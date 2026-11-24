// Runs after npm install: copies MediaPipe's WASM runtime into public/ so the app serves it itself.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dest = `${root}public/mediapipe/wasm`;
mkdirSync(dest, { recursive: true });
cpSync(`${root}node_modules/@mediapipe/tasks-vision/wasm`, dest, { recursive: true });
