import { openCamera, openMedia, type FrameSource } from './core/source';
import { LabelLayer } from './render/LabelLayer';
import { Stage } from './render/Stage';
import { HumanPlugin } from './species/human/HumanPlugin';
import type { FaceMode, LabelAnchor, ViewOptions } from './species/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const stage = new Stage($<HTMLCanvasElement>('stage'));
const labels = new LabelLayer($<HTMLCanvasElement>('labels'), stage);
const plugin = new HumanPlugin();
const startButton = $<HTMLButtonElement>('start');
const status = $('status');

const options: ViewOptions = {
  face: (params.get('face') as FaceMode) ?? 'half',
  hands: params.get('hands') !== '0',
  body: params.get('body') === '1',
};
let showLabels = params.get('labels') !== '0';
let source: FrameSource | null = null;
let anchors: LabelAnchor[] = [];
let lastTime = 0;
let frames = 0;

const ready = plugin.load(stage, (message) => (status.textContent = message)).then(
  () => {
    status.textContent = '';
    startButton.textContent = 'Start camera';
    startButton.disabled = false;
  },
  (err) => {
    console.error(err);
    status.textContent = `Could not load: ${err instanceof Error ? err.message : err}`;
  },
);

async function start(open: () => Promise<FrameSource>): Promise<void> {
  try {
    await ready;
    const next = await open();
    source?.dispose();
    source = next;
    stage.setSource(next);
    lastTime = 0;
    $('intro').hidden = true;
    $('controls').hidden = false;
  } catch (err) {
    console.error(err);
    const denied = err instanceof DOMException && err.name === 'NotAllowedError';
    status.textContent = denied
      ? 'Camera access was blocked. Allow it in the address bar, or drop a file instead.'
      : `Could not start: ${err instanceof Error ? err.message : err}`;
  }
}

function tick(now: number): void {
  requestAnimationFrame(tick);
  if (!source) return;
  if (source.hasNewFrame()) {
    const dt = lastTime ? (now - lastTime) / 1000 : 0;
    lastTime = now;
    anchors = plugin.update({ source, time: now, dt, aspect: stage.aspect }, options);
    document.body.dataset.frames = String(++frames);
  }
  stage.render();
  labels.draw(showLabels ? anchors : []);
}
requestAnimationFrame(tick);

// Controls
startButton.addEventListener('click', () => start(openCamera));

function syncControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-face]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.face === options.face));
  });
  $('hands').setAttribute('aria-pressed', String(options.hands));
  $('body').setAttribute('aria-pressed', String(options.body));
  $('labelsToggle').setAttribute('aria-pressed', String(showLabels));
  $<HTMLButtonElement>('side').disabled = options.face !== 'half';
}
document.querySelectorAll<HTMLButtonElement>('[data-face]').forEach((b) => {
  b.addEventListener('click', () => {
    options.face = b.dataset.face as FaceMode;
    syncControls();
  });
});
$('side').addEventListener('click', () => plugin.flipFaceSide());
$('hands').addEventListener('click', () => ((options.hands = !options.hands), syncControls()));
$('body').addEventListener('click', () => ((options.body = !options.body), syncControls()));
$('labelsToggle').addEventListener('click', () => ((showLabels = !showLabels), syncControls()));
syncControls();

window.addEventListener('resize', () => {
  stage.layout();
  labels.resize();
});

// Dropped files, and ?src= for testing without a camera.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  void start(() => openMedia(url, file.type.startsWith('video/')));
});
const src = params.get('src');
if (src) void start(() => openMedia(src, /\.(mp4|webm|mov)$/i.test(src)));
