import type {
  GenerateRequest,
  InitModelPayload,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '../types';

interface GenerateCallbacks {
  onToken(text: string): void;
  onToolCall?(name: string): void;
}

const GENERATE_TIMEOUT_MS = 120000;
const INIT_TIMEOUT_MS = 180000;

export class LlmWorkerClient {
  private worker: Worker;
  private initPromise: Promise<void> | null = null;
  private generateResolver:
    | {
        resolve: (value: WorkerOutboundMessage & { type: 'DONE' }) => void;
        reject: (error: Error) => void;
      }
    | null = null;
  private callbacks: GenerateCallbacks | null = null;

  constructor() {
    this.worker = new Worker(new URL('../workers/llm.worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      const message = event.data;

      if (message.type === 'TOKEN') {
        this.callbacks?.onToken(message.payload.text);
        return;
      }

      if (message.type === 'TOOL_CALL') {
        this.callbacks?.onToolCall?.(message.payload.name);
        return;
      }

      if (message.type === 'ERROR') {
        this.generateResolver?.reject(new Error(message.payload.message));
        this.generateResolver = null;
        return;
      }

      if (message.type === 'DONE') {
        this.generateResolver?.resolve(message);
        this.generateResolver = null;
      }
    };
  }

  async init(payload: InitModelPayload) {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.worker.removeEventListener('message', listener);
        this.initPromise = null;
        reject(new Error('Model initialization timed out after 3 minutes.'));
      }, INIT_TIMEOUT_MS);

      const listener = (event: MessageEvent<WorkerOutboundMessage>) => {
        const message = event.data;
        if (message.type === 'ERROR') {
          this.worker.removeEventListener('message', listener);
          window.clearTimeout(timeoutId);
          this.initPromise = null;
          reject(new Error(message.payload.message));
        }

        if (message.type === 'MODEL_PROGRESS' && message.payload.phase === 'ready') {
          this.worker.removeEventListener('message', listener);
          window.clearTimeout(timeoutId);
          this.initPromise = null;
          resolve();
        }
      };

      this.worker.addEventListener('message', listener);
      this.post({ type: 'INIT_MODEL', payload });
    });

    return this.initPromise;
  }

  async generate(payload: GenerateRequest, callbacks: GenerateCallbacks) {
    if (this.generateResolver) {
      throw new Error('Only one active generation is supported.');
    }

    this.callbacks = callbacks;

    return new Promise<WorkerOutboundMessage & { type: 'DONE' }>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.abort();
        this.generateResolver = null;
        reject(new Error('Model generation timed out before returning a response.'));
      }, GENERATE_TIMEOUT_MS);

      this.generateResolver = { resolve, reject };
      const originalResolve = resolve;
      const originalReject = reject;
      this.generateResolver = {
        resolve: (value) => {
          window.clearTimeout(timeoutId);
          originalResolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timeoutId);
          originalReject(error);
        },
      };
      this.post({ type: 'GENERATE', payload });
    });
  }

  abort() {
    this.post({ type: 'ABORT' });
  }

  dispose() {
    this.worker.terminate();
    this.initPromise = null;
    this.generateResolver = null;
    this.callbacks = null;
  }

  private post(message: WorkerInboundMessage) {
    this.worker.postMessage(message);
  }
}
