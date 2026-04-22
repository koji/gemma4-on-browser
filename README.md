# Gemma 4 Agentic Web

[日本語版 README](./README.ja.md)

Offline-first browser chat app for Gemma 4 E2B using MediaPipe Tasks GenAI and WebGPU.

![Gemma 4 Agentic Web screenshot](/Users/koji/Desktop/screenshots/Screenshot 2026-04-22 at 12.05.49 AM.png)

## Overview

This project runs a Gemma 4 LiteRT Web model directly in the browser and stores the model locally in OPFS after the first download. It also includes local lexical RAG over imported `txt`, `md`, and `pdf` files, plus persistent chat history in IndexedDB.

Current scope:

- Browser-only text chat with Gemma 4 E2B
- Local model download and reuse from OPFS
- Offline use after the first successful model download
- Local lexical RAG over imported documents
- PWA/service worker support outside localhost

## Tech Stack

- React 19
- TypeScript
- Vite
- `@mediapipe/tasks-genai`
- IndexedDB via `idb`
- OPFS for model storage
- `pdfjs-dist` for PDF text extraction

## Requirements

- Chrome or Edge desktop with WebGPU enabled
- Node.js and npm
- Network access for the first model download

## Getting Started

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## How It Works

### Model Runtime

- The default model URL points to the LiteRT Community Gemma 4 E2B Web task.
- The model is downloaded once and saved into OPFS under the browser origin.
- After that, the app can initialize and run offline on the same origin.

### Persistence

- Model metadata is stored in IndexedDB.
- The model binary is stored in OPFS.
- Conversations, messages, and imported document metadata are stored in IndexedDB.

### Local RAG

- Imported files are chunked locally in the browser.
- Retrieval is lexical only in v1.
- Top matching chunks are injected into the prompt automatically for each user turn.
- Assistant messages persist source citations so they remain visible after reload.

## Important Notes

- OPFS and IndexedDB are origin-scoped. `localhost:5173` and `127.0.0.1:5173` do not share the same stored model.
- Service workers are disabled on localhost in development to avoid stale bundles.
- The current app is text-only. Image and audio analysis are not enabled.
- Bundle size warnings during build are expected because of `pdfjs-dist`; they are not build failures.

## Main Scripts

- `npm run dev`: start the Vite dev server
- `npm run build`: create a production build
- `npm run preview`: preview the production build locally

## Repository Structure

- [src/App.tsx](/Users/koji/Desktop/dev/gemma4-web/src/App.tsx): main UI and chat flow
- [src/workers/llm.worker.ts](/Users/koji/Desktop/dev/gemma4-web/src/workers/llm.worker.ts): MediaPipe worker-based inference
- [src/lib/retrieval.ts](/Users/koji/Desktop/dev/gemma4-web/src/lib/retrieval.ts): local lexical retrieval for RAG
- [src/lib/modelStorage.ts](/Users/koji/Desktop/dev/gemma4-web/src/lib/modelStorage.ts): OPFS model download and storage

## License

MIT
