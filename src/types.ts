export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ToolName =
  | 'save_note'
  | 'list_notes'
  | 'search_notes'
  | 'import_files'
  | 'search_files'
  | 'export_chat';

export interface ToolCall {
  id: string;
  name: ToolName;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
  toolCall?: ToolCall | null;
  toolResult?: ToolResult | null;
  citations?: Citation[] | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
}

export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  text: string;
  index: number;
}

export interface DocumentRecord {
  id: string;
  fileName: string;
  mimeType: string;
  importedAt: string;
  chunkCount: number;
}

export interface ModelRecord {
  id: string;
  version: string;
  checksum: string;
  storagePath: string;
  status: 'missing' | 'downloading' | 'ready' | 'error';
  sourceUrl: string;
  bytes: number;
  updatedAt: string;
}

export interface SettingsRecord {
  id: 'app';
  modelUrl: string;
  maxTokens: number;
  temperature: number;
  topK: number;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: string;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  conversation: Conversation;
  messages: ChatMessage[];
}

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: 'note' | 'document';
}

export interface RetrievedChunk {
  documentId: string;
  chunkId: string;
  fileName: string;
  snippet: string;
  score: number;
  chunkIndex: number;
}

export interface Citation {
  documentId: string;
  chunkId: string;
  fileName: string;
  snippet: string;
  chunkIndex: number;
}

export interface ModelDownloadProgress {
  phase: 'idle' | 'checking' | 'downloading' | 'persisting' | 'ready' | 'error';
  loadedBytes: number;
  totalBytes: number;
}

export interface GenerateRequest {
  messages: ChatMessage[];
  tools: ToolDefinitionPrompt[];
  toolContext: {
    conversationSummary: string;
    retrievedChunks: RetrievedChunk[];
  };
}

export interface ToolDefinitionPrompt {
  name: ToolName;
  description: string;
  inputSchema: string;
}

export interface InitModelPayload {
  storagePath: string;
  maxTokens: number;
  temperature: number;
  topK: number;
}

export type WorkerInboundMessage =
  | { type: 'INIT_MODEL'; payload: InitModelPayload }
  | { type: 'GENERATE'; payload: GenerateRequest }
  | { type: 'ABORT' };

export type WorkerOutboundMessage =
  | { type: 'MODEL_PROGRESS'; payload: ModelDownloadProgress }
  | { type: 'TOKEN'; payload: { text: string } }
  | { type: 'TOOL_CALL'; payload: ToolCall }
  | { type: 'DONE'; payload: { text: string; toolCalls: ToolCall[]; usage: { promptChars: number; outputChars: number } } }
  | { type: 'ERROR'; payload: { code: string; message: string; retryable: boolean } };
