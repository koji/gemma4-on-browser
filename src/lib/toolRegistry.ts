import {
  bulkPutMessages,
  listAllChunks,
  listDocuments,
  listNotes,
  putChunks,
  putDocument,
  putNote,
} from './db';
import { importDocument } from './documentParser';
import { createId } from './id';
import { searchDocumentChunks, searchNotesIndex } from './search';
import type { ChatMessage, ToolContext, ToolDefinition } from '../types';

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function asTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((tag): tag is string => typeof tag === 'string');
}

export const toolRegistry: ToolDefinition[] = [
  {
    name: 'save_note',
    description: 'Save a note with title, body and optional tags.',
    inputSchema: '{"title":"string","body":"string","tags":["string"]}',
    async execute(args) {
      const title = asString(args.title).trim() || 'Untitled Note';
      const body = asString(args.body).trim();
      const tags = asTags(args.tags);

      await putNote({
        id: createId('note'),
        title,
        body,
        tags,
        updatedAt: new Date().toISOString(),
      });

      return {
        ok: true,
        summary: `Saved note "${title}".`,
        data: { title, tags },
      };
    },
  },
  {
    name: 'list_notes',
    description: 'List the latest saved notes.',
    inputSchema: '{}',
    async execute() {
      const notes = await listNotes();
      const items = notes
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 10)
        .map((note) => ({ title: note.title, updatedAt: note.updatedAt, tags: note.tags }));

      return {
        ok: true,
        summary: `Found ${items.length} notes.`,
        data: { items },
      };
    },
  },
  {
    name: 'search_notes',
    description: 'Search note contents by keyword.',
    inputSchema: '{"query":"string"}',
    async execute(args) {
      const query = asString(args.query);
      const hits = searchNotesIndex(await listNotes(), query);
      return {
        ok: true,
        summary: `Found ${hits.length} note matches for "${query}".`,
        data: { hits },
      };
    },
  },
  {
    name: 'import_files',
    description: 'Import local txt, md or pdf files into the local knowledge base.',
    inputSchema: '{"files":[File]}',
    async execute(args) {
      const files = Array.isArray(args.files) ? args.files.filter((item): item is File => item instanceof File) : [];
      const imported: Array<{ fileName: string; chunkCount: number }> = [];

      for (const file of files) {
        const { document, chunks } = await importDocument(file);
        await putDocument(document);
        await putChunks(chunks);
        imported.push({ fileName: document.fileName, chunkCount: document.chunkCount });
      }

      return {
        ok: true,
        summary: `Imported ${imported.length} files.`,
        data: { imported },
      };
    },
  },
  {
    name: 'search_files',
    description: 'Search imported file chunks by keyword.',
    inputSchema: '{"query":"string"}',
    async execute(args) {
      const query = asString(args.query);
      const hits = searchDocumentChunks(await listDocuments(), await listAllChunks(), query);
      return {
        ok: true,
        summary: `Found ${hits.length} file matches for "${query}".`,
        data: { hits },
      };
    },
  },
  {
    name: 'export_chat',
    description: 'Export the active conversation as JSON.',
    inputSchema: '{}',
    async execute(_, context: ToolContext) {
      const fileName = `${context.conversation.title.replace(/\s+/g, '-').toLowerCase() || 'conversation'}.json`;
      const payload = {
        conversation: context.conversation,
        messages: context.messages,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      return {
        ok: true,
        summary: `Prepared export for ${context.conversation.title}.`,
        data: { fileName, url },
      };
    },
  },
];

export function toolPrompts() {
  return toolRegistry.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
) {
  const tool = toolRegistry.find((candidate) => candidate.name === name);
  if (!tool) {
    return {
      ok: false,
      summary: `Unknown tool: ${name}`,
      data: {},
    };
  }

  return tool.execute(args, context);
}

export async function persistToolTranscript(messages: ChatMessage[]) {
  await bulkPutMessages(messages);
}
