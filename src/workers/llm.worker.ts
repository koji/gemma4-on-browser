/// <reference lib="webworker" />

import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';
import type {
  ChatMessage,
  GenerateRequest,
  InitModelPayload,
  ToolCall,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '../types';
import { createId } from '../lib/id';
import { cleanAssistantText } from '../lib/modelText';

type WorkerGlobalWithImport = typeof self & {
  import?: (url: string) => Promise<unknown>;
  ModuleFactory?: unknown;
};

const workerGlobal = self as WorkerGlobalWithImport;
if (!workerGlobal.import) {
  workerGlobal.import = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch worker dependency: ${url} (${response.status})`);
    }

    const source = await response.text();
    (0, eval)(`${source}\n//# sourceURL=${url}`);
    return workerGlobal.ModuleFactory;
  };
}

let llmInference: LlmInference | null = null;
let activeAbort = false;
const MAX_MESSAGE_CHARS = 1200;

function post(message: WorkerOutboundMessage) {
  self.postMessage(message);
}

function sanitizePromptText(text: string) {
  return text
    .replace(/<start_of_turn>/g, '')
    .replace(/<end_of_turn>/g, '')
    .replace(/<end_of_of_turn>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

function toGemmaRole(message: ChatMessage) {
  if (message.role === 'assistant') {
    return 'model';
  }

  if (message.role === 'tool') {
    return 'user';
  }

  return message.role;
}

function getPromptTemplate(messages: ChatMessage[], request: GenerateRequest) {
  const transcriptMessages = messages
    .map((message) => {
      if (message.role === 'tool' && message.toolResult) {
        return {
          role: 'user',
          content: `Tool result: ${sanitizePromptText(JSON.stringify(message.toolResult))}`,
        };
      }

      return {
        role: toGemmaRole(message),
        content: sanitizePromptText(message.content),
      };
    })
    .filter((message) => message.content);

  if (transcriptMessages.length > 0) {
    const firstUserIndex = transcriptMessages.findIndex((message) => message.role === 'user');
    if (firstUserIndex !== -1) {
      const contextSections: string[] = [];
      if (request.toolContext.conversationSummary) {
        contextSections.push(`Relevant prior context:\n${sanitizePromptText(request.toolContext.conversationSummary)}`);
      }

      if (request.toolContext.retrievedChunks.length > 0) {
        const retrievedContext = request.toolContext.retrievedChunks
          .map(
            (chunk, index) =>
              `[Source ${index + 1}] ${sanitizePromptText(chunk.fileName)} (chunk ${chunk.chunkIndex + 1})\n${sanitizePromptText(chunk.snippet)}`,
          )
          .join('\n\n');

        contextSections.push(
          `Retrieved context:\n${retrievedContext}\n\nUse retrieved context when it is relevant. If the local documents do not contain the answer, say that clearly instead of inventing details.`,
        );
      }

      if (contextSections.length > 0) {
        transcriptMessages[firstUserIndex] = {
          ...transcriptMessages[firstUserIndex],
          content: `${contextSections.join('\n\n')}\n\n${transcriptMessages[firstUserIndex].content}`,
        };
      }
    }
  }

  const transcript = transcriptMessages
    .map((message) => {
      return `<start_of_turn>${message.role}\n${message.content}<end_of_turn>`;
    })
    .join('\n');

  return `${transcript}\n<start_of_turn>model`;
}

function parseModelOutput(rawText: string, request: GenerateRequest): { text: string; toolCalls: ToolCall[] } {
  const cleanedText = cleanAssistantText(rawText);

  if (request.tools.length === 0) {
    return { text: cleanedText, toolCalls: [] };
  }

  const firstBrace = cleanedText.indexOf('{');
  const lastBrace = cleanedText.lastIndexOf('}');
  const jsonCandidate =
    firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
      ? cleanedText.slice(firstBrace, lastBrace + 1)
      : cleanedText;

  try {
    const parsed = JSON.parse(jsonCandidate) as { reply?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> };
    const toolCalls = (parsed.toolCalls ?? [])
      .filter((toolCall) => typeof toolCall?.name === 'string')
      .map((toolCall) => ({
        id: createId('toolcall'),
        name: toolCall.name as ToolCall['name'],
        args: toolCall.args ?? {},
      }));

    return {
      text: cleanAssistantText(parsed.reply ?? ''),
      toolCalls,
    };
  } catch {
    return { text: cleanedText, toolCalls: [] };
  }
}

async function initModel(payload: InitModelPayload) {
  post({
    type: 'MODEL_PROGRESS',
    payload: { phase: 'persisting', loadedBytes: 0, totalBytes: 0 },
  });

  llmInference?.close();
  const fileset = await FilesetResolver.forGenAiTasks('/genai/wasm', false);
  const root = await navigator.storage.getDirectory();
  const modelsDir = await root.getDirectoryHandle('models');
  const modelHandle = await modelsDir.getFileHandle(payload.storagePath);
  const modelFile = await modelHandle.getFile();
  const modelBytes = new Uint8Array(await modelFile.arrayBuffer());

  llmInference = await LlmInference.createFromOptions(fileset, {
    baseOptions: {
      modelAssetBuffer: modelBytes,
    },
    maxTokens: payload.maxTokens,
    temperature: payload.temperature,
    topK: payload.topK,
  });

  post({
    type: 'MODEL_PROGRESS',
    payload: { phase: 'ready', loadedBytes: 0, totalBytes: 0 },
  });
}

async function generate(request: GenerateRequest) {
  if (!llmInference) {
    throw new Error('Model is not initialized.');
  }

  activeAbort = false;
  let streamedText = '';
  const prompt = getPromptTemplate(request.messages, request);
  const rawText = await llmInference.generateResponse(prompt, (partialResult, done) => {
    if (activeAbort) {
      llmInference?.cancelProcessing();
      return;
    }

    const newText = partialResult.slice(streamedText.length);
    streamedText = partialResult;

    if (newText) {
      post({ type: 'TOKEN', payload: { text: newText } });
    }

    if (done && activeAbort) {
      llmInference?.clearCancelSignals();
    }
  });

  if (activeAbort) {
    llmInference.clearCancelSignals();
    return {
      text: streamedText,
      toolCalls: [],
    };
  }

  const parsed = parseModelOutput(rawText, request);
  for (const toolCall of parsed.toolCalls) {
    post({ type: 'TOOL_CALL', payload: toolCall });
  }

  return parsed;
}

self.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
  try {
    const message = event.data;
    if (message.type === 'ABORT') {
      activeAbort = true;
      llmInference?.cancelProcessing();
      return;
    }

    if (message.type === 'INIT_MODEL') {
      await initModel(message.payload);
      return;
    }

    if (message.type === 'GENERATE') {
      const result = await generate(message.payload);
      post({
        type: 'DONE',
        payload: {
          text: result.text,
          toolCalls: result.toolCalls,
          usage: {
            promptChars: JSON.stringify(message.payload.messages).length,
            outputChars: result.text.length,
          },
        },
      });
    }
  } catch (error) {
    post({
      type: 'ERROR',
      payload: {
        code: 'worker_error',
        message: error instanceof Error ? error.message : 'Unknown worker error',
        retryable: true,
      },
    });
  }
};
