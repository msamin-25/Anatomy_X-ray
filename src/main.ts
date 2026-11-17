import { hasSeveralCameras, openCamera, openMedia, type Facing, type FrameSource } from './core/source';
import { LabelLayer } from './render/LabelLayer';
import { Stage } from './render/Stage';
import type { AnimalPlugin } from './species/animal/AnimalPlugin';
import { HumanPlugin } from './species/human/HumanPlugin';
import type { FaceMode, LabelAnchor, SpeciesPlugin, ViewOptions } from './species/types';

type Mode = 'human' | 'animal';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const stage = new Stage($<HTMLCanvasElement>('stage'));
const labels = new LabelLayer($<HTMLCanvasElement>('labels'), stage);
const human = new HumanPlugin();
/** Loaded on first use: it brings ONNX Runtime and a 54 MB pose model. */
let animal: AnimalPlugin | null = null;
let speciesOverride: 'dog' | 'cat' | null = null;
const plugins: Partial<Record<Mode, SpeciesPlugin>> = { human };
const startButton = $<HTMLButtonElement>('start');
const status = $('status');
const hud = $('hud');
const credit = $('credit');

const options: ViewOptions = {
  face: (params.get('face') as FaceMode) ?? 'half',
  hands: params.get('hands') !== '0',
  body: params.get('body') === '1',
};
let mode: Mode = params.get('mode') === 'animal' ? 'animal' : 'human';
const species = params.get('species');
if (species === 'dog' || species === 'cat') speciesOverride = species;
let active: SpeciesPlugin | null = null;
let showLabels = params.get('labels') !== '0';
let source: FrameSource | null = null;
let anchors: LabelAnchor[] = [];
let lastTime = 0;
let frames = 0;
let message = '';

/** Loads a plugin once; a failed load can be retried by switching to it again. */
const loading: Partial<Record<Mode, Promise<void>>> = {};
async function create(m: Mode): Promise<SpeciesPlugin> {
  if (m === 'human') return human;
  setMessage('Loading animal mode');
  const { AnimalPlugin } = await import('./species/animal/AnimalPlugin');
  animal = new AnimalPlugin();
  animal.override = speciesOverride;
  return animal;
}

function load(m: Mode): Promise<void> {
  loading[m] ??= create(m).then(async (plugin) => {
    await plugin.load(stage, (text) => setMessage(text));
    plugins[m] = plugin;
  }).then(
    () => setMessage(''),
    (err) => {
      delete loading[m];
      throw err;
    },
  );
  return loading[m];
}

function setMessage(text: string): void {
  message = text;
  status.textContent = text;
}

async function setMode(next: Mode): Promise<void> {
  mode = next;
  active?.hide();
  active = null;
  anchors = [];
  syncControls();
  try {
    await load(next);
    if (mode === next) active = plugins[next] ?? null;
  } catch (err) {
    console.error(err);
    setMessage(`Could not load: ${err instanceof Error ? err.message : err}`);
  }
}

// Start loading the trackers right away; the camera can open while they load.
void setMode(mode);

/** Replaces the current source. A camera is released first: phones allow only one at a time. */
async function start(open: () => Promise<FrameSource>, camera: boolean): Promise<void> {
  if (camera && source?.live) {
    const old = source;
    source = null;
    old.dispose();
  }
  try {
    const next = await open();
    source?.dispose();
    source = next;
    stage.setSource(next);
    lastTime = 0;
    $('intro').hidden = true;
    $('controls').hidden = false;
    $('flip').hidden = !(next.live && (await hasSeveralCameras()));
  } catch (err) {
    console.error(err);
    const denied = err instanceof DOMException && err.name === 'NotAllowedError';
    const text = denied
      ? 'Camera access was blocked. Allow it in the browser settings, or choose a photo or video.'
      : `Could not start: ${err instanceof Error ? err.message : err}`;
    setMessage(text);
    if (!source) {
      // The old camera was released; go back to the start screen to retry.
      $('intro').hidden = false;
      $('controls').hidden = true;
    }
  }
}

let facing: Facing = 'user';
function startCamera(next: Facing): Promise<void> {
  return start(async () => {
    const opened = await openCamera(next);
    facing = next;
    return opened;
  }, true);
}

function tick(now: number): void {
  requestAnimationFrame(tick);
  if (!source) return;
  if (stage.needsLayout()) stage.layout(); // the phone was rotated
  if (active && source.hasNewFrame()) {
    const dt = lastTime ? (now - lastTime) / 1000 : 0;
    lastTime = now;
    anchors = active.update({ source, time: now, dt, aspect: stage.aspect }, options);
    document.body.dataset.frames = String(++frames);
  }
  stage.render();
  labels.draw(showLabels ? anchors : []);
  hud.textContent = message || (mode === 'animal' && active ? animalStatus() : '');
}

function animalStatus(): string {
  if (!animal) return '';
  const kind = animal.kind;
  const text = kind ? kind[0].toUpperCase() + kind.slice(1) + (animal.override ? '' : ' (detected)') : 'Looking for a dog or cat';
  return params.has('debug') ? `${text} · pose ${animal.tracker.inferenceMs.toFixed(0)} ms` : text;
}
requestAnimationFrame(tick);

// Controls
startButton.addEventListener('click', () => {
  if (mode !== 'human') void setMode('human');
  void startCamera('user');
});
$('startPet').addEventListener('click', () => {
  if (mode !== 'animal') void setMode('animal');
  void startCamera('environment');
});
$('flip').addEventListener('click', () => void startCamera(facing === 'user' ? 'environment' : 'user'));
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) openFile(file);
});

function openFile(file: File): void {
  const url = URL.createObjectURL(file);
  void start(() => openMedia(url, file.type.startsWith('video/')), false);
}

function syncControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
  document.querySelectorAll<HTMLElement>('.human-only').forEach((el) => (el.hidden = mode !== 'human'));
  document.querySelectorAll<HTMLElement>('.animal-only').forEach((el) => (el.hidden = mode !== 'animal'));
  document.querySelectorAll<HTMLButtonElement>('[data-species]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.species === (speciesOverride ?? 'auto')));
  });
  credit.textContent = mode === 'human'
    ? 'Bone models: BodyParts3D © DBCLS, CC BY-SA 2.1 JP'
    : 'Pose: RTMPose AP-10K (OpenMMLab, Apache 2.0) · bones are schematic';
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
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.mode !== mode) void setMode(b.dataset.mode as Mode);
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-species]').forEach((b) => {
  b.addEventListener('click', () => {
    speciesOverride = b.dataset.species === 'auto' ? null : (b.dataset.species as 'dog' | 'cat');
    if (animal) animal.override = speciesOverride;
    syncControls();
  });
});
$('side').addEventListener('click', () => human.flipFaceSide());
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
  if (file) openFile(file);
});
const src = params.get('src');
if (src) void start(() => openMedia(src, /\.(mp4|webm|mov)$/i.test(src)), false);
