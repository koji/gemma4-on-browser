# Gemma 4 Agentic Web

[English README](./README.md)

MediaPipe Tasks GenAI と WebGPU を使って、Gemma 4 E2B をブラウザ上で動かす offline-first のチャットアプリです。

![Gemma 4 Agentic Web スクリーンショット](/webui.png)

## 概要

このプロジェクトは Gemma 4 の LiteRT Web モデルをブラウザで直接実行し、初回ダウンロード後は OPFS にモデルを保存して再利用します。さらに、`txt` / `md` / `pdf` を対象にしたローカル lexical RAG と、IndexedDB による会話履歴の永続化を備えています。

現状のスコープ:

- Gemma 4 E2B によるブラウザ内 text chat
- OPFS へのローカルモデル保存と再利用
- 初回ダウンロード後のオフライン利用
- 取り込み文書に対する local lexical RAG
- localhost 以外での PWA / service worker 対応

## 技術スタック

- React 19
- TypeScript
- Vite
- `@mediapipe/tasks-genai`
- `idb` による IndexedDB 利用
- モデル保存用の OPFS
- PDF テキスト抽出用の `pdfjs-dist`

## 動作要件

- WebGPU が有効なデスクトップ版 Chrome または Edge
- Node.js と npm
- 初回モデルダウンロード時のネットワーク接続

## セットアップ

```bash
npm install
npm run dev
```

本番ビルド:

```bash
npm run build
```

本番ビルドのローカル確認:

```bash
npm run preview
```

## 仕組み

### モデル実行

- 既定のモデル URL は LiteRT Community の Gemma 4 E2B Web task を指します
- モデルは初回のみダウンロードされ、OPFS に保存されます
- 同じ origin であれば、その後はオフラインでも初期化と推論が可能です

### データ保存

- モデルのメタデータは IndexedDB に保存されます
- モデル本体は OPFS に保存されます
- 会話、メッセージ、文書メタデータは IndexedDB に保存されます

### Local RAG

- 取り込んだファイルはブラウザ内でチャンク化されます
- v1 の検索は lexical retrieval のみです
- 各 user turn ごとに上位チャンクを自動で prompt に注入します
- assistant message には citation 情報を保存し、再読み込み後も source 表示を維持します

## 注意点

- OPFS と IndexedDB は origin ごとに分かれます。`localhost:5173` と `127.0.0.1:5173` では保存済みモデルを共有しません
- 開発中の stale bundle を避けるため、localhost では service worker を無効化しています
- 現在のアプリは text-only です。画像・音声解析は有効化していません
- `pdfjs-dist` により build 時に bundle size warning が出ることがありますが、build failure ではありません

## 主要スクリプト

- `npm run dev`: Vite 開発サーバーを起動
- `npm run build`: 本番ビルドを作成
- `npm run preview`: 本番ビルドをローカルで確認

## 主要ファイル

- [src/App.tsx](/Users/koji/Desktop/dev/gemma4-web/src/App.tsx): メイン UI と chat flow
- [src/workers/llm.worker.ts](/Users/koji/Desktop/dev/gemma4-web/src/workers/llm.worker.ts): MediaPipe worker 推論
- [src/lib/retrieval.ts](/Users/koji/Desktop/dev/gemma4-web/src/lib/retrieval.ts): local lexical RAG の検索処理
- [src/lib/modelStorage.ts](/Users/koji/Desktop/dev/gemma4-web/src/lib/modelStorage.ts): OPFS へのモデル保存処理

## ライセンス

MIT
