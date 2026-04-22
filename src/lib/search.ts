import type { DocumentChunk, DocumentRecord, NoteRecord, RetrievedChunk, SearchHit } from '../types';

function tokenize(input: string) {
  return input
    .toLowerCase()
    .split(/[\s、。,.!?()[\]{}:;/'"`-]+/)
    .filter(Boolean);
}

function scoreText(queryTokens: string[], text: string) {
  const haystack = text.toLowerCase();
  return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function toSnippet(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    return text.slice(0, 180);
  }

  const start = Math.max(index - 60, 0);
  const end = Math.min(index + 120, text.length);
  return text.slice(start, end);
}

export function searchNotesIndex(notes: NoteRecord[], query: string): SearchHit[] {
  const queryTokens = tokenize(query);

  return notes
    .map((note) => {
      const text = `${note.title}\n${note.body}\n${note.tags.join(' ')}`;
      const score = scoreText(queryTokens, text);
      return {
        id: note.id,
        title: note.title,
        snippet: toSnippet(note.body, query),
        score,
        source: 'note' as const,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
}

export function searchDocumentChunks(
  documents: DocumentRecord[],
  chunks: DocumentChunk[],
  query: string,
): RetrievedChunk[] {
  const queryTokens = tokenize(query);
  const documentMap = new Map(documents.map((document) => [document.id, document]));

  return chunks
    .map((chunk) => {
      const score = scoreText(queryTokens, chunk.text);
      const document = documentMap.get(chunk.documentId);
      return {
        documentId: chunk.documentId,
        chunkId: chunk.id,
        fileName: document?.fileName ?? chunk.documentId,
        snippet: toSnippet(chunk.text, query),
        score,
        chunkIndex: chunk.index,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
}
