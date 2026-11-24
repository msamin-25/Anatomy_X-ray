import { defineConfig } from 'vite';

// Cross-origin isolation lets ONNX Runtime use several threads for animal
// pose inference. "credentialless" keeps the MediaPipe model downloads from
// Google Cloud Storage working. Static hosts need the same two headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  // ONNX Runtime finds its .wasm next to its own module (new URL(..., import.meta.url)).
  // Pre-bundling moves the module and breaks that path in dev; the build handles it.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
