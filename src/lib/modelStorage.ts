import { getModelRecord, putModelRecord } from './db';
import type { ModelDownloadProgress, ModelRecord } from '../types';

const MODEL_DIRECTORY = 'models';
const MODEL_ID = 'gemma4';

export const DEFAULT_MODEL_URL =
  'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task?download=true';

async function getRootDirectory() {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) {
    throw new Error('OPFS is not available in this browser.');
  }

  return navigator.storage.getDirectory();
}

async function ensureModelDirectory() {
  const root = await getRootDirectory();
  return root.getDirectoryHandle(MODEL_DIRECTORY, { create: true });
}

async function removeIfExists(fileName: string) {
  const dir = await ensureModelDirectory();
  try {
    await dir.removeEntry(fileName);
  } catch {
    return;
  }
}

async function readBlob(fileName: string) {
  const dir = await ensureModelDirectory();
  const file = await dir.getFileHandle(fileName);
  return (await file.getFile()).slice();
}

async function recoverModelRecordFromOpfs() {
  const dir = await ensureModelDirectory();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') {
      continue;
    }

    const file = await handle.getFile();
    const record: ModelRecord = {
      id: MODEL_ID,
      version: name,
      checksum: `recovered:${file.size}:${file.lastModified}`,
      storagePath: name,
      status: 'ready',
      sourceUrl: DEFAULT_MODEL_URL,
      bytes: file.size,
      updatedAt: new Date(file.lastModified || Date.now()).toISOString(),
    };

    await putModelRecord(record);
    return record;
  }

  return null;
}

export async function getStoredModel() {
  let record = await getModelRecord();
  if (!record || record.status !== 'ready') {
    record = await recoverModelRecordFromOpfs();
  }

  if (!record || record.status !== 'ready') {
    return null;
  }

  return { record };
}

export async function estimateStorage() {
  if (!('storage' in navigator) || !navigator.storage.estimate) {
    return null;
  }

  return navigator.storage.estimate();
}

export async function downloadModelToOpfs(
  sourceUrl: string,
  onProgress: (progress: ModelDownloadProgress) => void,
  signal?: AbortSignal,
) {
  onProgress({ phase: 'checking', loadedBytes: 0, totalBytes: 0 });
  const response = await fetch(sourceUrl, { signal, mode: 'cors' });

  if (!response.ok || !response.body) {
    throw new Error(`Model download failed: ${response.status}`);
  }

  const totalBytes = Number(response.headers.get('content-length') ?? 0);
  const etag = response.headers.get('etag') ?? '';
  const lastModified = response.headers.get('last-modified') ?? '';
  const url = new URL(sourceUrl);
  const fileName = decodeURIComponent(url.pathname.split('/').at(-1) || 'gemma-4-E2B-it-web.task');

  const dir = await ensureModelDirectory();
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  const reader = response.body.getReader();
  let loadedBytes = 0;

  onProgress({ phase: 'downloading', loadedBytes, totalBytes });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (value) {
        await writable.write(value);
        loadedBytes += value.byteLength;
        onProgress({ phase: 'downloading', loadedBytes, totalBytes });
      }
    }

    await writable.close();
  } catch (error) {
    await writable.abort();
    await removeIfExists(fileName);
    throw error;
  }

  const record: ModelRecord = {
    id: MODEL_ID,
    version: 'gemma-4-E2B-it-web.task',
    checksum: `${etag}:${lastModified}:${loadedBytes}`,
    storagePath: fileName,
    status: 'ready',
    sourceUrl,
    bytes: loadedBytes,
    updatedAt: new Date().toISOString(),
  };

  await putModelRecord(record);
  onProgress({ phase: 'ready', loadedBytes, totalBytes: totalBytes || loadedBytes });
  return record;
}

export async function setModelDownloading(sourceUrl: string) {
  const current = await getModelRecord();
  await putModelRecord({
    id: MODEL_ID,
    version: current?.version ?? 'gemma-4-E2B-it-web.task',
    checksum: current?.checksum ?? '',
    storagePath: current?.storagePath ?? '',
    status: 'downloading',
    sourceUrl,
    bytes: current?.bytes ?? 0,
    updatedAt: new Date().toISOString(),
  });
}
