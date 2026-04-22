import { listAllChunks, listDocuments } from './db';
import { searchDocumentChunks } from './search';
import type { RetrievedChunk } from '../types';

const MIN_RETRIEVAL_SCORE = 1;
const MAX_RETRIEVED_CHUNKS = 4;
const MAX_RETRIEVED_CHARS = 1400;

export async function retrieveRelevantChunks(query: string): Promise<RetrievedChunk[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const [documents, chunks] = await Promise.all([listDocuments(), listAllChunks()]);
  if (documents.length === 0 || chunks.length === 0) {
    return [];
  }

  const matches = searchDocumentChunks(documents, chunks, trimmedQuery).filter((chunk) => chunk.score >= MIN_RETRIEVAL_SCORE);
  const selected: RetrievedChunk[] = [];
  let totalChars = 0;

  for (const match of matches) {
    const nextSize = totalChars + match.snippet.length;
    if (selected.length >= MAX_RETRIEVED_CHUNKS) {
      break;
    }

    if (selected.length > 0 && nextSize > MAX_RETRIEVED_CHARS) {
      break;
    }

    selected.push(match);
    totalChars = nextSize;
  }

  return selected;
}
