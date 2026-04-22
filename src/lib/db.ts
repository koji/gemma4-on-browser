import { openDB } from 'idb';
import type {
  ChatMessage,
  Conversation,
  DocumentChunk,
  DocumentRecord,
  ModelRecord,
  NoteRecord,
  SettingsRecord,
} from '../types';

interface AppDatabase {
  conversations: {
    key: string;
    value: Conversation;
  };
  messages: {
    key: string;
    value: ChatMessage;
    indexes: {
      'by-conversation': string;
    };
  };
  notes: {
    key: string;
    value: NoteRecord;
  };
  documents: {
    key: string;
    value: DocumentRecord;
  };
  chunks: {
    key: string;
    value: DocumentChunk;
    indexes: {
      'by-document': string;
    };
  };
  models: {
    key: string;
    value: ModelRecord;
  };
  settings: {
    key: string;
    value: SettingsRecord;
  };
}

const dbPromise = openDB<AppDatabase>('gemma-agentic-web', 1, {
  upgrade(db) {
    db.createObjectStore('conversations', { keyPath: 'id' });

    const messages = db.createObjectStore('messages', { keyPath: 'id' });
    messages.createIndex('by-conversation', 'conversationId');

    db.createObjectStore('notes', { keyPath: 'id' });
    db.createObjectStore('documents', { keyPath: 'id' });

    const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
    chunks.createIndex('by-document', 'documentId');

    db.createObjectStore('models', { keyPath: 'id' });
    db.createObjectStore('settings', { keyPath: 'id' });
  },
});

export async function getSettings() {
  return (await dbPromise).get('settings', 'app');
}

export async function putSettings(settings: SettingsRecord) {
  return (await dbPromise).put('settings', settings);
}

export async function listConversations() {
  return (await dbPromise).getAll('conversations');
}

export async function putConversation(conversation: Conversation) {
  return (await dbPromise).put('conversations', conversation);
}

export async function getConversation(id: string) {
  return (await dbPromise).get('conversations', id);
}

export async function deleteConversation(id: string) {
  const db = await dbPromise;
  const tx = db.transaction(['conversations', 'messages'], 'readwrite');
  await tx.objectStore('conversations').delete(id);

  let cursor = await tx.objectStore('messages').index('by-conversation').openKeyCursor(id);
  while (cursor) {
    await tx.objectStore('messages').delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }

  await tx.done;
}

export async function listMessages(conversationId: string) {
  return (await dbPromise).getAllFromIndex('messages', 'by-conversation', conversationId);
}

export async function putMessage(message: ChatMessage) {
  return (await dbPromise).put('messages', message);
}

export async function bulkPutMessages(messages: ChatMessage[]) {
  const db = await dbPromise;
  const tx = db.transaction('messages', 'readwrite');
  await Promise.all(messages.map((message) => tx.store.put(message)));
  await tx.done;
}

export async function listNotes() {
  return (await dbPromise).getAll('notes');
}

export async function putNote(note: NoteRecord) {
  return (await dbPromise).put('notes', note);
}

export async function listDocuments() {
  return (await dbPromise).getAll('documents');
}

export async function putDocument(document: DocumentRecord) {
  return (await dbPromise).put('documents', document);
}

export async function putChunks(chunks: DocumentChunk[]) {
  const db = await dbPromise;
  const tx = db.transaction('chunks', 'readwrite');
  await Promise.all(chunks.map((chunk) => tx.store.put(chunk)));
  await tx.done;
}

export async function listChunksForDocument(documentId: string) {
  return (await dbPromise).getAllFromIndex('chunks', 'by-document', documentId);
}

export async function listAllChunks() {
  return (await dbPromise).getAll('chunks');
}

export async function getModelRecord() {
  return (await dbPromise).get('models', 'gemma4');
}

export async function putModelRecord(record: ModelRecord) {
  return (await dbPromise).put('models', record);
}
