import { hasSeveralCameras, openCamera, openMedia, type Facing, type FrameSource } from './core/source';
import { LabelLayer } from './render/LabelLayer';
import { Stage } from './render/Stage';
import { SkinCheck } from './skin/SkinCheck';
import type { AnimalPlugin } from './species/animal/AnimalPlugin';
import { HumanPlugin } from './species/human/HumanPlugin';
import type { FaceMode, LabelAnchor, SpeciesPlugin, ViewOptions } from './species/types';

type Mode = 'human' | 'animal' | 'skin';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const stage = new Stage($<HTMLCanvasElement>('stage'));
const labels = new LabelLayer($<HTMLCanvasElement>('labels'), stage);
const human = new HumanPlugin();
/** Loaded on first use: it brings ONNX Runtime and a 54 MB pose model. */
let animal: AnimalPlugin | null = null;
let speciesOverride: 'dog' | 'cat' | null = null;
const skin = new SkinCheck($('skinPanel'));
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
const MODES: Mode[] = ['human', 'animal', 'skin'];
let mode: Mode = MODES.includes(params.get('mode') as Mode) ? (params.get('mode') as Mode) : 'human';
const species = params.get('species');
if (species === 'dog' || species === 'cat') speciesOverride = species;
let active: SpeciesPlugin | null = null;
let showLabels = params.get('labels') !== '0';
let source: FrameSource | null = null;
let anchors: LabelAnchor[] = [];
let lastTime = 0;
let frames = 0;
let message = '';
/** Skin mode: the phone's light (where the camera supports it). */
let torchOn = false;

/** Loads a plugin once; a failed load can be retried by switching to it again. */
const loading: Partial<Record<Mode, Promise<void>>> = {};
async function create(m: Mode): Promise<SpeciesPlugin> {
  if (m === 'human') return human;
  if (m === 'skin') return skin;
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
  if (next !== 'skin') resetSkinCamera();
  syncControls();
  try {
    await load(next);
    if (mode !== next) return;
    active = plugins[next] ?? null;
    if (next === 'skin') skin.show();
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
    torchOn = false;
    syncControls();
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
    const opened = await openCamera(next, mode === 'skin');
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
  if (mode === 'skin') anchors = [];
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
$('startSkin').addEventListener('click', () => {
  if (mode !== 'skin') void setMode('skin');
  void startCamera('environment');
});

// Skin mode: the camera works as a magnifier.
const ZOOMS = [1, 2, 3, 4];
function torchSupported(): boolean {
  const caps = source?.track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
  return !!caps?.torch;
}
function setTorch(on: boolean): void {
  const track = source?.track;
  if (!track || !torchSupported()) return;
  torchOn = on;
  track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }).catch((err) => {
    console.warn('Light not available', err);
    torchOn = false;
    syncControls();
  });
  syncControls();
}
function resetSkinCamera(): void {
  stage.setZoom(1);
  if (torchOn) setTorch(false);
}
$('zoom').addEventListener('click', () => {
  stage.setZoom(ZOOMS[(ZOOMS.indexOf(stage.zoom) + 1) % ZOOMS.length]);
  syncControls();
});
$('torch').addEventListener('click', () => setTorch(!torchOn));
$('savePhoto').addEventListener('click', () => void savePhoto());

/** Saves the magnified centre of the camera frame, unmirrored, as a JPEG on this device. */
async function savePhoto(): Promise<void> {
  if (!source) return;
  const w = source.width / stage.zoom;
  const h = source.height / stage.zoom;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
  canvas.getContext('2d')!.drawImage(source.el, (source.width - w) / 2, (source.height - h) / 2, w, h, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) return;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const file = new File([blob], `skin-${stamp}.jpg`, { type: 'image/jpeg' });
  // Phones: the share sheet can save to the photo library. Elsewhere: a download.
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

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
  document.querySelectorAll<HTMLElement>('.skin-only').forEach((el) => (el.hidden = mode !== 'skin'));
  $('torch').hidden = mode !== 'skin' || !torchSupported();
  $('torch').setAttribute('aria-pressed', String(torchOn));
  $('zoom').textContent = `Zoom ${stage.zoom}×`;
  $('labelsToggle').hidden = mode === 'skin';
  document.querySelectorAll<HTMLButtonElement>('[data-species]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.species === (speciesOverride ?? 'auto')));
  });
  credit.textContent = {
    human: 'Bone models: BodyParts3D © DBCLS, CC BY-SA 2.1 JP',
    animal: 'Pose: RTMPose AP-10K (OpenMMLab, Apache 2.0) · bones are schematic',
    skin: 'Guidance based on NHS advice · not a diagnosis',
  }[mode];
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
