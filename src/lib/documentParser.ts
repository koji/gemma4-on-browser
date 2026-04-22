import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { createId } from './id';
import type { DocumentChunk, DocumentRecord } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const CHUNK_SIZE = 900;

function chunkText(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: string[] = [];

  for (let index = 0; index < normalized.length; index += CHUNK_SIZE) {
    chunks.push(normalized.slice(index, index + CHUNK_SIZE));
  }

  return chunks.filter(Boolean);
}

async function readTextFromPdf(file: File) {
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, offset) => {
      const page = await pdf.getPage(offset + 1);
      const textContent = await page.getTextContent();
      return textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .trim();
    }),
  );

  return pages.join('\n\n');
}

async function extractText(file: File) {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return readTextFromPdf(file);
  }

  return file.text();
}

export async function importDocument(file: File): Promise<{ document: DocumentRecord; chunks: DocumentChunk[] }> {
  const content = await extractText(file);
  const documentId = createId('document');
  const split = chunkText(content);

  return {
    document: {
      id: documentId,
      fileName: file.name,
      mimeType: file.type || 'text/plain',
      chunkCount: split.length,
      importedAt: new Date().toISOString(),
    },
    chunks: split.map((text, index) => ({
      id: createId('chunk'),
      documentId,
      text,
      index,
    })),
  };
}
