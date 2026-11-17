import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import * as ort from 'onnxruntime-web/wasm';

const BASE = import.meta.env.BASE_URL;
const DETECTOR = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
const SIZE = 256;
/** SimCC bins per input pixel. */
const SPLIT = 2;
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];
/** Crop margin around the detected box, as in RTMPose's top-down pipeline. */
const PADDING = 1.25;
/** Frames without a detection before the animal is considered gone. */
const MAX_MISSES = 8;
const DEBUG = new URLSearchParams(location.search).has('debug');

export type AnimalKind = 'dog' | 'cat';

/** With ?debug, tracking and rigging internals are exposed as `window.__animal`. */
export const debugInfo: Record<string, unknown> = {};
if (DEBUG) (window as unknown as { __animal: object }).__animal = debugInfo;

/** AP-10K keypoint indices. */
export const KP = {
  eyeL: 0, eyeR: 1, nose: 2, neck: 3, tail: 4,
  shoulderL: 5, elbowL: 6, frontPawL: 7, shoulderR: 8, elbowR: 9, frontPawR: 10,
  hipL: 11, kneeL: 12, backPawL: 13, hipR: 14, kneeR: 15, backPawR: 16,
} as const;

export interface Keypoint {
  /** Normalised image coordinates, origin top-left. */
  x: number;
  y: number;
  /** SimCC peak value; above about 0.4 the point is reliable. */
  score: number;
}

export interface AnimalPose {
  kind: AnimalKind;
  points: Keypoint[];
}

interface Box {
  cx: number;
  cy: number;
  size: number;
}

/**
 * Finds a dog or cat with MediaPipe's object detector, then runs RTMPose
 * (AP-10K, 17 keypoints) on a square crop around it with ONNX Runtime.
 * Pose inference is asynchronous: `track` starts a run when the previous one
 * has finished and `latest` holds the newest result.
 */
export class AnimalTracker {
  latest: AnimalPose | null = null;
  /** Duration of the last pose inference, for the debug readout. */
  inferenceMs = 0;
  private detector!: ObjectDetector;
  private session!: ort.InferenceSession;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly input = new Float32Array(3 * SIZE * SIZE);
  private busy = false;
  private misses = 0;
  private box: Box | null = null;
  /** Running confidence per kind, so a single misclassified frame does not switch species. */
  private readonly votes: Record<AnimalKind, number> = { dog: 0, cat: 0 };

  constructor() {
    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  async load(onProgress: (message: string) => void): Promise<void> {
    onProgress('Loading animal detector');
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    const options = (delegate: 'CPU' | 'GPU') => ({
      baseOptions: { modelAssetPath: DETECTOR, delegate },
      runningMode: 'VIDEO' as const,
      scoreThreshold: 0.25,
      categoryAllowlist: ['dog', 'cat'],
    });
    try {
      this.detector = await ObjectDetector.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('GPU detection unavailable, using CPU', err);
      this.detector = await ObjectDetector.createFromOptions(fileset, options('CPU'));
    }

    const model = await download(`${BASE}models/animal/rtmpose-ap10k.onnx`, (share) =>
      onProgress(`Loading animal pose model ${Math.round(share * 100)}%`),
    );
    onProgress('Starting animal pose model');
    this.session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }

  track(el: HTMLVideoElement | HTMLImageElement, time: number): void {
    if (this.busy) return;
    const width = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const height = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (!width || !height) return;

    const target = this.detect(el, time, width, height) ?? this.boxFromPose(width, height);
    if (!target) {
      if (++this.misses > MAX_MISSES) {
        this.latest = null;
        this.box = null;
      }
      return;
    }
    this.misses = 0;
    // Ease the crop towards the new box so the pose model sees a steady frame.
    const box = this.box;
    if (box && Math.abs(box.cx - target.cx) < box.size * 0.5) {
      box.cx += (target.cx - box.cx) * 0.6;
      box.cy += (target.cy - box.cy) * 0.6;
      box.size += (target.size - box.size) * 0.4;
    } else {
      this.box = { ...target };
    }
    void this.estimate(el, width, height, this.box!);
  }

  /** Returns a square crop box in source pixels, or null when no animal is found. */
  private detect(el: HTMLVideoElement | HTMLImageElement, time: number, width: number, height: number): Box | null {
    const result = this.detector.detectForVideo(el, time);
    let best: { box: Box; score: number } | null = null;
    const score: Record<AnimalKind, number> = { dog: 0, cat: 0 };
    for (const d of result.detections) {
      const c = d.categories[0];
      const b = d.boundingBox;
      if (!c || !b) continue;
      const kind = c.categoryName as AnimalKind;
      score[kind] = Math.max(score[kind], c.score);
      if (!best || c.score > best.score) {
        best = {
          score: c.score,
          box: { cx: b.originX + b.width / 2, cy: b.originY + b.height / 2, size: Math.max(b.width, b.height) * PADDING },
        };
      }
    }
    // The detector often reports the same animal as both dog and cat; let
    // both labels vote, and decay old votes so a new animal can take over.
    for (const k of ['dog', 'cat'] as AnimalKind[]) this.votes[k] = this.votes[k] * 0.9 + score[k];
    if (DEBUG) debugInfo.detections = result.detections.map((d) => `${d.categories[0]?.categoryName}:${d.categories[0]?.score.toFixed(2)}`);
    if (!best) return null;
    best.box.size = Math.min(best.box.size, Math.max(width, height) * 1.5);
    return best.box;
  }

  /** Falls back to the box around the last confident pose when the detector misses a frame. */
  private boxFromPose(width: number, height: number): Box | null {
    const pose = this.latest;
    if (!pose || this.misses > MAX_MISSES) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (const p of pose.points) {
      if (p.score < 0.5) continue;
      x0 = Math.min(x0, p.x * width);
      y0 = Math.min(y0, p.y * height);
      x1 = Math.max(x1, p.x * width);
      y1 = Math.max(y1, p.y * height);
      n++;
    }
    if (n < 8) return null;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) * PADDING * 1.1 };
  }

  private async estimate(el: CanvasImageSource, width: number, height: number, box: Box): Promise<void> {
    this.busy = true;
    try {
      const { cx, cy, size } = box;
      const x0 = cx - size / 2;
      const y0 = cy - size / 2;
      const ctx = this.ctx;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, SIZE, SIZE);
      // drawImage clips a source rectangle that extends past the frame and
      // shrinks the destination to match, which leaves black padding.
      const sx = Math.max(0, x0), sy = Math.max(0, y0);
      const sw = Math.min(width, x0 + size) - sx, sh = Math.min(height, y0 + size) - sy;
      const k = SIZE / size;
      ctx.drawImage(el, sx, sy, sw, sh, (sx - x0) * k, (sy - y0) * k, sw * k, sh * k);
      const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;
      const plane = SIZE * SIZE;
      for (let i = 0; i < plane; i++) {
        this.input[i] = (rgba[i * 4] - MEAN[0]) / STD[0];
        this.input[plane + i] = (rgba[i * 4 + 1] - MEAN[1]) / STD[1];
        this.input[plane * 2 + i] = (rgba[i * 4 + 2] - MEAN[2]) / STD[2];
      }
      const started = performance.now();
      const out = await this.session.run({ input: new ort.Tensor('float32', this.input, [1, 3, SIZE, SIZE]) });
      this.inferenceMs = performance.now() - started;
      const sx2 = out.simcc_x.data as Float32Array;
      const sy2 = out.simcc_y.data as Float32Array;
      const bins = out.simcc_x.dims[2];
      const count = out.simcc_x.dims[1];
      const points: Keypoint[] = [];
      for (let j = 0; j < count; j++) {
        const [bx, vx] = peak(sx2, j * bins, bins);
        const [by, vy] = peak(sy2, j * bins, bins);
        points.push({
          x: (x0 + (bx / SPLIT / SIZE) * size) / width,
          y: (y0 + (by / SPLIT / SIZE) * size) / height,
          score: Math.min(vx, vy),
        });
      }
      if (this.box) this.latest = { kind: this.votes.cat > this.votes.dog ? 'cat' : 'dog', points };
    } catch (err) {
      console.error(err);
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.detector.close();
    void this.session.release();
  }
}

/** Fetches a file, reporting progress (0-1) while it arrives; it is large on a phone connection. */
async function download(url: string, onProgress: (share: number) => void): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  // Content-Length is the compressed size when the host compresses, so cap the share at 1.
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let received = 0;
  let shown = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const share = Math.min(99, Math.floor((received / total) * 100));
    if (share !== shown) onProgress((shown = share) / 100);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Index of the largest value (refined to sub-bin with a parabola) and the value itself. */
function peak(data: Float32Array, offset: number, length: number): [number, number] {
  let best = 0;
  for (let i = 1; i < length; i++) if (data[offset + i] > data[offset + best]) best = i;
  const v = data[offset + best];
  if (best > 0 && best < length - 1) {
    const l = data[offset + best - 1];
    const r = data[offset + best + 1];
    const d = l - 2 * v + r;
    if (d < 0) return [best + (0.5 * (l - r)) / d, v];
  }
  return [best, v];
}
