import { useEffect, useRef, useState, startTransition, type KeyboardEvent } from 'react';
import { buildConversationSummary, selectPromptMessages } from './lib/chatMemory';
import { cleanAssistantText, getStreamingPreviewText } from './lib/modelText';
import {
  deleteConversation,
  getConversation,
  getSettings,
  listDocuments,
  listConversations,
  listMessages,
  putChunks,
  putConversation,
  putDocument,
  putMessage,
  putSettings,
} from './lib/db';
import { importDocument } from './lib/documentParser';
import { createId } from './lib/id';
import {
  DEFAULT_MODEL_URL,
  downloadModelToOpfs,
  estimateStorage,
  getStoredModel,
  setModelDownloading,
} from './lib/modelStorage';
import { retrieveRelevantChunks } from './lib/retrieval';
import { LlmWorkerClient } from './lib/workerClient';
import type {
  Citation,
  ChatMessage,
  Conversation,
  ModelDownloadProgress,
  ModelRecord,
  RetrievedChunk,
  SettingsRecord,
} from './types';

type Tab = 'chat' | 'settings';
type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language: string };
type CodeToken = { text: string; className?: string };

const promptInputId = 'chat-prompt';
const modelUrlId = 'model-url';
const maxTokensId = 'max-tokens';
const temperatureId = 'temperature';
const topKId = 'top-k';

const DEFAULT_SETTINGS: SettingsRecord = {
  id: 'app',
  modelUrl: DEFAULT_MODEL_URL,
  maxTokens: 2048,
  temperature: 0.7,
  topK: 40,
};

function createConversation(): Conversation {
  const timestamp = new Date().toISOString();
  return {
    id: createId('conversation'),
    title: 'New chat',
    createdAt: timestamp,
    updatedAt: timestamp,
    summary: '',
  };
}

function createMessage(conversationId: string, role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: createId('message'),
    conversationId,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

function createStreamingMessage(conversationId: string): ChatMessage {
  return {
    id: 'streaming',
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
  };
}

function formatMb(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function updateConversationTitle(messages: ChatMessage[], fallback: string) {
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser) {
    return fallback;
  }

  return firstUser.content.slice(0, 48) || fallback;
}

function parseMessageSegments(content: string): MessageSegment[] {
  const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  const segments: MessageSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(fencePattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      segments.push({
        type: 'text',
        content: content.slice(lastIndex, matchIndex),
      });
    }

    segments.push({
      type: 'code',
      language: match[1]?.trim() ?? '',
      content: match[2] ?? '',
    });

    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      content: content.slice(lastIndex),
    });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content }];
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitPlainCodeText(text: string, keywordPattern: RegExp | null): CodeToken[] {
  if (!text) {
    return [];
  }

  if (!keywordPattern) {
    return [{ text }];
  }

  const splitPattern = new RegExp(`(${keywordPattern.source})`, 'g');
  return text
    .split(splitPattern)
    .filter(Boolean)
    .map((part) => ({
      text: part,
      className: keywordPattern.test(part) ? 'code-keyword' : undefined,
    }));
}

function tokenizeCode(code: string, language: string): CodeToken[] {
  const keywordsByLanguage: Record<string, string[]> = {
    ts: ['function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'type', 'interface', 'import', 'from', 'export', 'default', 'new', 'class', 'extends', 'implements', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof'],
    typescript: ['function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'type', 'interface', 'import', 'from', 'export', 'default', 'new', 'class', 'extends', 'implements', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof'],
    js: ['function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'import', 'from', 'export', 'default', 'new', 'class', 'extends', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof'],
    javascript: ['function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'import', 'from', 'export', 'default', 'new', 'class', 'extends', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof'],
    json: [],
    css: ['display', 'position', 'color', 'background', 'font', 'grid', 'flex', 'padding', 'margin', 'border'],
    html: [],
    xml: [],
  };

  const normalizedLanguage = language.toLowerCase();
  const keywords = keywordsByLanguage[normalizedLanguage] ?? keywordsByLanguage.ts;
  const keywordPattern = keywords.length > 0 ? new RegExp(`\\b(?:${keywords.map(escapeRegExp).join('|')})\\b`) : null;
  const tokenPattern =
    /(\b\d+(?:\.\d+)?\b|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|\/\/.*$|\/\*[\s\S]*?\*\/|#.*$|<\/?[A-Za-z][^>\n]*>|[{}()[\].,;:+\-*/%=!<>|&]+)/gm;

  const tokens: CodeToken[] = [];
  let lastIndex = 0;

  for (const match of code.matchAll(tokenPattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      const text = code.slice(lastIndex, matchIndex);
      tokens.push(...splitPlainCodeText(text, keywordPattern));
    }

    const value = match[0] ?? '';
    let className: string | undefined;
    if (/^\/\/|^\/\*|^#/.test(value)) {
      className = 'code-comment';
    } else if (/^["'`]/.test(value)) {
      className = 'code-string';
    } else if (/^\d/.test(value)) {
      className = 'code-number';
    } else if (/^<\/?[A-Za-z]/.test(value)) {
      className = 'code-tag';
    } else {
      className = 'code-punctuation';
    }

    tokens.push({ text: value, className });
    lastIndex = matchIndex + value.length;
  }

  if (lastIndex < code.length) {
    const text = code.slice(lastIndex);
    tokens.push(...splitPlainCodeText(text, keywordPattern));
  }

  return tokens;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const tokens = tokenizeCode(code, language);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language || 'code'}</span>
        <button className="secondary code-copy-button" onClick={() => void handleCopy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((token, index) => (
            <span key={`${token.className ?? 'plain'}-${index}`} className={token.className}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const segments = parseMessageSegments(content);

  return (
    <div className="message-body">
      {segments.map((segment, index) =>
        segment.type === 'code' ? (
          <CodeBlock
            key={`${segment.language}-${index}`}
            code={segment.content}
            language={segment.language}
          />
        ) : segment.content.trim() ? (
          <pre key={`text-${index}`} className="message-text">
            {segment.content}
          </pre>
        ) : null,
      )}
    </div>
  );
}

function MessageCitations({ citations }: { citations: Citation[] }) {
  const [expandedCitationId, setExpandedCitationId] = useState<string | null>(null);

  return (
    <div className="message-citations">
      <p className="citation-summary">Used {citations.length} local source{citations.length === 1 ? '' : 's'}</p>
      <div className="citation-list">
        {citations.map((citation) => {
          const citationId = `${citation.documentId}:${citation.chunkId}`;
          const isExpanded = expandedCitationId === citationId;

          return (
            <div key={citationId} className="citation-item">
              <button
                className={`secondary citation-pill ${isExpanded ? 'active' : ''}`}
                onClick={() => setExpandedCitationId(isExpanded ? null : citationId)}
              >
                {citation.fileName} · chunk {citation.chunkIndex + 1}
              </button>
              {isExpanded ? <p className="citation-snippet">{citation.snippet}</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function App() {
  const workerRef = useRef<LlmWorkerClient | null>(null);
  const modelDownloadAbortRef = useRef<AbortController | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);

  const [tab, setTab] = useState<Tab>('chat');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<SettingsRecord>(DEFAULT_SETTINGS);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState('Checking local model...');
  const [downloadProgress, setDownloadProgress] = useState<ModelDownloadProgress>({
    phase: 'idle',
    loadedBytes: 0,
    totalBytes: 0,
  });
  const [storedModelRecord, setStoredModelRecord] = useState<ModelRecord | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<{ quota?: number; usage?: number } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isModelReady, setIsModelReady] = useState(false);
  const [hasLocalModel, setHasLocalModel] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState('');
  const [documentCount, setDocumentCount] = useState(0);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;

  function resetWorker() {
    workerRef.current?.dispose();
    workerRef.current = new LlmWorkerClient();
  }

  useEffect(() => {
    if (!('gpu' in navigator)) {
      setCompatibilityError('WebGPU is unavailable on this device. Use the latest version of Chrome or Edge.');
      setStatus('WebGPU unavailable');
      return;
    }

    resetWorker();

    void (async () => {
      try {
        const [storedSettings, storedConversations, estimate] = await Promise.all([
          getSettings(),
          listConversations(),
          estimateStorage(),
        ]);

        setStorageEstimate(estimate ?? null);
        if (storedSettings) {
          setSettings(storedSettings);
        }
        setDocumentCount((await listDocuments()).length);

        if (storedConversations.length === 0) {
          const conversation = createConversation();
          await putConversation(conversation);
          setConversations([conversation]);
          setActiveConversationId(conversation.id);
        } else {
          const sorted = storedConversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
          setConversations(sorted);
          setActiveConversationId(sorted[0].id);
        }
      } catch (error) {
        setCompatibilityError(error instanceof Error ? error.message : 'IndexedDB initialization failed.');
      }
    })();

    const onlineListener = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', onlineListener);
    window.addEventListener('offline', onlineListener);

    return () => {
      window.removeEventListener('online', onlineListener);
      window.removeEventListener('offline', onlineListener);
      workerRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    void (async () => {
      const conversation = await getConversation(activeConversationId);
      const storedMessages = await listMessages(activeConversationId);
      if (conversation) {
        setConversations((current) =>
          current
            .map((item) => (item.id === conversation.id ? conversation : item))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        );
      }
      setMessages(storedMessages.sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
    })();
  }, [activeConversationId]);

  async function handleDownloadModel() {
    try {
      setStatus('Checking storage and preparing download...');
      setDownloadProgress({ phase: 'checking', loadedBytes: 0, totalBytes: 0 });
      await setModelDownloading(settings.modelUrl);
      modelDownloadAbortRef.current = new AbortController();

      const record = await downloadModelToOpfs(
        settings.modelUrl,
        (progress) => {
          startTransition(() => {
            setDownloadProgress(progress);
          });
        },
        modelDownloadAbortRef.current.signal,
      );

      setHasLocalModel(true);
      setStoredModelRecord(record);
      await initializeModel();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model download failed.';
      const isAbort =
        message.includes('AbortError') ||
        message.includes('BodyStreamBuffer was aborted') ||
        message.includes('aborted');

      setStatus(isAbort ? 'Download canceled.' : message);
      setDownloadProgress((current) => ({
        ...current,
        phase: isAbort ? 'idle' : 'error',
      }));
    }
  }

  async function initializeModel() {
    try {
      const stored = await getStoredModel();
      if (!stored) {
        setHasLocalModel(false);
        setStoredModelRecord(null);
        setIsModelReady(false);
        setStatus('No local model found. Download the model to enable offline use.');
        return false;
      }

      setHasLocalModel(true);
      setStoredModelRecord(stored.record);
      setStatus('Initializing model...');
      await workerRef.current?.init({
        storagePath: stored.record.storagePath,
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
        topK: settings.topK,
      });
      setIsModelReady(true);
      setStatus('Model ready for offline chat.');
      return true;
    } catch (error) {
      resetWorker();
      setStatus(error instanceof Error ? error.message : 'Model initialization failed.');
      setIsModelReady(false);
      return false;
    }
  }

  useEffect(() => {
    void initializeModel();
  }, [settings.maxTokens, settings.temperature, settings.topK]);

  useEffect(() => {
    const container = messageListRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [messages, activeConversationId, isGenerating]);

  async function runAgentLoop(baseMessages: ChatMessage[], conversation: Conversation) {
    const latestUserMessage = [...baseMessages].reverse().find((message) => message.role === 'user');
    const retrievedChunks: RetrievedChunk[] = latestUserMessage
      ? await retrieveRelevantChunks(latestUserMessage.content)
      : [];
    let workingMessages = [...baseMessages];
    let rawAssistantText = '';
    let visibleAssistantText = '';
    setStatus(
      retrievedChunks.length > 0
        ? `Generating response with ${retrievedChunks.length} local source${retrievedChunks.length === 1 ? '' : 's'}...`
        : 'Generating response...',
    );
    setMessages((current) => {
      const existing = current.find((message) => message.id === 'streaming');
      if (existing) {
        return current;
      }
      return current.concat(createStreamingMessage(conversation.id));
    });

    const promptMessages = selectPromptMessages(workingMessages);
    const conversationSummary = buildConversationSummary(workingMessages);

    const final = await workerRef.current?.generate(
      {
        messages: promptMessages,
        tools: [],
        toolContext: {
          conversationSummary,
          retrievedChunks,
        },
      },
      {
        onToken: (chunk) => {
          rawAssistantText += chunk;
          const nextPreviewText = getStreamingPreviewText(rawAssistantText);
          if (nextPreviewText.length >= visibleAssistantText.length) {
            visibleAssistantText = nextPreviewText;
          }
          setStatus('Receiving tokens...');
          setMessages((current) => {
            const last = current.at(-1);
            if (!last || last.role !== 'assistant' || last.id !== 'streaming') {
              return [...current, { ...createStreamingMessage(conversation.id), content: visibleAssistantText }];
            }

            return current.map((message) =>
              message.id === 'streaming' ? { ...message, content: visibleAssistantText } : message,
            );
          });
        },
      },
    );

    if (final) {
      const streamedAssistant = createMessage(
        conversation.id,
        'assistant',
        final.payload.text || cleanAssistantText(rawAssistantText),
      );
      streamedAssistant.citations = retrievedChunks.map((chunk) => ({
        documentId: chunk.documentId,
        chunkId: chunk.chunkId,
        fileName: chunk.fileName,
        snippet: chunk.snippet,
        chunkIndex: chunk.chunkIndex,
      }));
      setMessages((current) =>
        current.filter((message) => message.id !== 'streaming').concat(streamedAssistant),
      );
      await putMessage(streamedAssistant);
      workingMessages = [...workingMessages, streamedAssistant];
    }

    const updatedConversation: Conversation = {
      ...conversation,
      title: updateConversationTitle(workingMessages, conversation.title),
      summary: buildConversationSummary(workingMessages),
      updatedAt: new Date().toISOString(),
    };

    await putConversation(updatedConversation);
    setConversations((current) =>
      [updatedConversation, ...current.filter((item) => item.id !== updatedConversation.id)].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    );
  }

  async function handleSend() {
    if (!prompt.trim() || !activeConversation || (!hasLocalModel && !isModelReady) || isGenerating) {
      return;
    }

    if (!isModelReady) {
      setIsGenerating(true);
      setStatus('Finishing model initialization...');
      const initialized = await initializeModel();
      if (!initialized) {
        setIsGenerating(false);
        return;
      }
      setIsGenerating(false);
    }

    const userMessage = createMessage(activeConversation.id, 'user', prompt.trim());
    const nextConversation: Conversation = {
      ...activeConversation,
      updatedAt: new Date().toISOString(),
    };

    setPrompt('');
    setIsGenerating(true);
    setStatus('Preparing prompt...');
    setMessages((current) => current.concat(userMessage));
    await putMessage(userMessage);
    await putConversation(nextConversation);

    try {
      await runAgentLoop([...messages, userMessage], nextConversation);
      setStatus('Model ready for offline chat.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Generation failed.');
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleNewConversation() {
    const conversation = createConversation();
    await putConversation(conversation);
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setMessages([]);
  }

  async function handleDeleteConversation(conversationId: string) {
    const existingConversation = conversations.find((conversation) => conversation.id === conversationId);
    if (!existingConversation) {
      return;
    }

    const remainingConversations = conversations.filter((conversation) => conversation.id !== conversationId);
    await deleteConversation(conversationId);

    if (remainingConversations.length === 0) {
      const replacementConversation = createConversation();
      await putConversation(replacementConversation);
      setConversations([replacementConversation]);
      setActiveConversationId(replacementConversation.id);
      setMessages([]);
      setStatus(`Deleted "${existingConversation.title}".`);
      return;
    }

    setConversations(remainingConversations);
    if (activeConversationId === conversationId) {
      setMessages([]);
      setActiveConversationId(remainingConversations[0].id);
    }
    setStatus(`Deleted "${existingConversation.title}".`);
  }

  async function handleSaveSettings() {
    await putSettings(settings);
    setStatus('Settings saved.');
    if (isModelReady) {
      await initializeModel();
    }
  }

  async function handleImportFiles(files: FileList | null) {
    const selectedFiles = files ? Array.from(files) : [];
    if (selectedFiles.length === 0) {
      return;
    }

    setStatus(`Importing ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}...`);
    let importedCount = 0;
    let failedCount = 0;
    let lastError = '';

    for (const file of selectedFiles) {
      try {
        const { document, chunks } = await importDocument(file);
        await putDocument(document);
        await putChunks(chunks);
        importedCount += 1;
      } catch (error) {
        failedCount += 1;
        lastError = error instanceof Error ? error.message : 'Unknown import error';
      }
    }

    setDocumentCount((await listDocuments()).length);

    if (importedCount > 0 && failedCount === 0) {
      setStatus(`Imported ${importedCount} file${importedCount === 1 ? '' : 's'}.`);
    } else if (importedCount > 0) {
      setStatus(
        `Imported ${importedCount} file${importedCount === 1 ? '' : 's'} with ${failedCount} import error${failedCount === 1 ? '' : 's'}.`,
      );
    } else {
      setStatus(lastError || 'File import failed.');
    }

    if (documentInputRef.current) {
      documentInputRef.current.value = '';
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }

    event.preventDefault();
    void handleSend();
  }

  const originLabel = window.location.origin;
  const runtimeLabel = isModelReady ? 'Ready' : hasLocalModel ? 'Downloaded' : 'Missing';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Offline Agent</p>
          <h1>Gemma 4 Agentic Web</h1>
          <p className="sidebar-copy">
            A text-only browser agent powered by MediaPipe, WebGPU, and Gemma 4 E2B.
          </p>
        </div>

        <div className="status-card">
          <div className="status-row">
            <span>Status</span>
            <strong>{isOnline ? 'Online' : 'Offline'}</strong>
          </div>
          <div className="status-row">
            <span>Runtime</span>
            <strong>{runtimeLabel}</strong>
          </div>
          <p>{status}</p>
          <p className="status-subtle">Origin: {originLabel}</p>
          {storedModelRecord ? (
            <p className="status-subtle">
              Local model: {storedModelRecord.storagePath} ({formatMb(storedModelRecord.bytes)})
            </p>
          ) : (
            <p className="status-subtle">Local model: none detected for this origin.</p>
          )}
          {storageEstimate && (
            <p className="status-subtle">
              Storage: {Math.round((storageEstimate.usage ?? 0) / 1024 / 1024)}MB /{' '}
              {Math.round((storageEstimate.quota ?? 0) / 1024 / 1024)}MB
            </p>
          )}
        </div>

        <nav className="tabs">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            Chat
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>

        <section className="conversation-list">
          <div className="section-head">
            <h2>Chats</h2>
            <button onClick={() => void handleNewConversation()}>New</button>
          </div>
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`conversation-row ${conversation.id === activeConversationId ? 'selected' : ''}`}
            >
              <button
                className={`conversation-item ${conversation.id === activeConversationId ? 'selected' : ''}`}
                onClick={() => setActiveConversationId(conversation.id)}
              >
                <span>{conversation.title}</span>
                <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
              </button>
              <button
                className="secondary conversation-delete"
                onClick={() => void handleDeleteConversation(conversation.id)}
                aria-label={`Delete ${conversation.title}`}
                title={`Delete ${conversation.title}`}
              >
                Delete
              </button>
            </div>
          ))}
        </section>
      </aside>

      <main className="main-panel">
        {compatibilityError ? (
          <section className="empty-state">
            <h2>Unsupported Environment</h2>
            <p>{compatibilityError}</p>
          </section>
        ) : null}

        {!compatibilityError && tab === 'chat' && (
          <section className="panel chat-panel">
            {!isModelReady && (
              <div className="hero">
                <div>
                  <p className="eyebrow">Offline Enablement</p>
                  <h2>Download Gemma 4 E2B</h2>
                  <p>
                    Download the model once and store it in OPFS. After that, startup and inference can run offline.
                  </p>
                </div>
                <div className="hero-actions">
                  <button onClick={() => void handleDownloadModel()}>
                    {hasLocalModel ? 'Re-download Model' : 'Download Model'}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => modelDownloadAbortRef.current?.abort()}
                    disabled={downloadProgress.phase !== 'downloading'}
                  >
                    Stop Download
                  </button>
                </div>
                <progress
                  max={downloadProgress.totalBytes || 1}
                  value={downloadProgress.loadedBytes}
                />
                <p className="status-subtle">
                  {downloadProgress.phase} {Math.round(downloadProgress.loadedBytes / 1024 / 1024)}MB /{' '}
                  {Math.round((downloadProgress.totalBytes || 0) / 1024 / 1024)}MB
                </p>
                {storedModelRecord ? (
                  <p className="status-subtle">
                    Saved for {originLabel}: {storedModelRecord.storagePath} ({formatMb(storedModelRecord.bytes)})
                  </p>
                ) : null}
              </div>
            )}

            <div className="rag-toolbar">
              <div>
                <p className="eyebrow">Local RAG</p>
                <p className="rag-toolbar-copy">
                  Imported documents: <strong>{documentCount}</strong>. Retrieval runs automatically on each message.
                </p>
              </div>
              <div className="hero-actions">
                <input
                  ref={documentInputRef}
                  className="sr-only"
                  type="file"
                  accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
                  multiple
                  onChange={(event) => void handleImportFiles(event.target.files)}
                />
                <button className="secondary" onClick={() => documentInputRef.current?.click()}>
                  Import Documents
                </button>
              </div>
            </div>

            <div ref={messageListRef} className="message-list">
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <header>
                    <span>{message.role}</span>
                    <small>{new Date(message.createdAt).toLocaleTimeString()}</small>
                  </header>
                  <MessageContent content={message.content} />
                  {message.citations && message.citations.length > 0 ? (
                    <MessageCitations citations={message.citations} />
                  ) : null}
                  {message.toolResult?.data && 'url' in message.toolResult.data ? (
                    <a href={String(message.toolResult.data.url)} download={String(message.toolResult.data.fileName)}>
                      Download exported chat
                    </a>
                  ) : null}
                </article>
              ))}
            </div>

            <div className="composer">
              <textarea
                id={promptInputId}
                name={promptInputId}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handlePromptKeyDown}
                placeholder="Ask something..."
                rows={4}
              />
              <div className="composer-actions">
                <div className="submit-row">
                  <button className="secondary" onClick={() => workerRef.current?.abort()} disabled={!isGenerating}>
                    Stop
                  </button>
                  <button onClick={() => void handleSend()} disabled={(!hasLocalModel && !isModelReady) || isGenerating}>
                    Send
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {!compatibilityError && tab === 'settings' && (
          <section className="panel settings-panel">
            <div className="section-head">
              <h2>Settings</h2>
              <button onClick={() => void handleSaveSettings()}>Save</button>
            </div>

            <label htmlFor={modelUrlId}>
              Model URL
              <input
                id={modelUrlId}
                name={modelUrlId}
                value={settings.modelUrl}
                onChange={(event) => setSettings((current) => ({ ...current, modelUrl: event.target.value }))}
              />
            </label>

            <div className="settings-grid">
              <label htmlFor={maxTokensId}>
                Max Tokens
                <input
                  id={maxTokensId}
                  name={maxTokensId}
                  type="number"
                  min={256}
                  max={8192}
                  value={settings.maxTokens}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, maxTokens: Number(event.target.value) || current.maxTokens }))
                  }
                />
              </label>

              <label htmlFor={temperatureId}>
                Temperature
                <input
                  id={temperatureId}
                  name={temperatureId}
                  type="number"
                  step="0.1"
                  min={0}
                  max={2}
                  value={settings.temperature}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      temperature: Number(event.target.value) || current.temperature,
                    }))
                  }
                />
              </label>

              <label htmlFor={topKId}>
                Top K
                <input
                  id={topKId}
                  name={topKId}
                  type="number"
                  min={1}
                  max={100}
                  value={settings.topK}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, topK: Number(event.target.value) || current.topK }))
                  }
                />
              </label>
            </div>

            <div className="settings-note">
              <p>
                v1 officially targets Chrome/Edge desktop with WebGPU only. CPU fallback, vision, audio, and OCR are not included.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
