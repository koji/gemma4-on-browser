import { mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const sourceDir = path.resolve('node_modules/@mediapipe/tasks-genai/wasm');
const targetDir = path.resolve('public/genai/wasm');

await mkdir(targetDir, { recursive: true });

const files = await readdir(sourceDir);

await Promise.all(
  files.map(async (file) => {
    await copyFile(path.join(sourceDir, file), path.join(targetDir, file));
  }),
);
