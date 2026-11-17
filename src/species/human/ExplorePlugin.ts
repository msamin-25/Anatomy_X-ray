import { CanvasTexture, Matrix4, SRGBColorSpace, Vector3 } from 'three';
import type { FrameSource } from '../../core/source';
import type { Stage } from '../../render/Stage';
import type { FrameInput, LabelAnchor, SpeciesPlugin, ViewOptions } from '../types';
import { HumanModel, humanModel } from './model';
import type { Bone } from './skeleton';

export type ExploreView = 'body' | 'head' | 'chest' | 'hand';

/** Where each preset looks (rest-pose cm) and from how far. */
const VIEWS: Record<ExploreView, { target: [number, number, number]; dist: number; yaw: number; pitch: number }> = {
  body: { target: [0, 84, 9], dist: 190, yaw: 0.45, pitch: 0.06 },
  head: { target: [0, 152.5, 10], dist: 36, yaw: 0.55, pitch: 0.1 },
  chest: { target: [0, 122, 11], dist: 64, yaw: 0.3, pitch: 0.05 },
  hand: { target: [26, 75, 13], dist: 32, yaw: -0.85, pitch: 0.15 },
};

const LABELS: [string, string][] = [
  ['frontal', 'Skull'], ['mandible', 'Mandible'], ['clavicle_L', 'Clavicle'], ['body_of_sternum', 'Sternum'],
  ['rib6_R', 'Ribs'], ['humerus_R', 'Humerus'], ['radius_L', 'Radius'], ['ulna_R', 'Ulna'],
  ['l3', 'Lumbar vertebrae'], ['hip_L', 'Hip bone'], ['femur_R', 'Femur'], ['patella_L', 'Patella'],
  ['tibia_R', 'Tibia'], ['fibula_L', 'Fibula'], ['mc3_L', 'Hand bones'], ['calcaneus_R', 'Foot bones'],
];

/** A camera-free frame source: a dark backdrop the size of the window. */
export function sceneSource(): FrameSource {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(256, 210, 20, 256, 256, 380);
  g.addColorStop(0, '#11203a');
  g.addColorStop(0.55, '#0a1424');
  g.addColorStop(1, '#05080f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return {
    el: new Image(),
    get width() {
      return window.innerWidth;
    },
    get height() {
      return window.innerHeight;
    },
    texture,
    mirror: false,
    live: true,
    scene: true,
    hasNewFrame: () => true,
    dispose: () => texture.dispose(),
  };
}

/**
 * The 3D explorer: the whole body in the anatomical position, with the same
 * bones, vessels and nerves as the live view. Drag to turn it, pinch or
 * scroll to zoom, drag with two fingers (or the right mouse button) to move.
 */
export class ExplorePlugin implements SpeciesPlugin {
  readonly id = 'explore';
  readonly model = humanModel;
  spin = false;
  private stage!: Stage;
  private enabled = false;
  private bones: Bone[] = [];
  private readonly anchors: { bone: Bone; anchor: LabelAnchor }[] = [];
  private midX = 0;

  // Current and goal camera; presets ease toward their goal.
  private yaw = VIEWS.body.yaw;
  private pitch = VIEWS.body.pitch;
  private dist = VIEWS.body.dist;
  private readonly target = new Vector3(...VIEWS.body.target);
  private goal: { yaw: number; pitch: number; dist: number; target: Vector3 } | null = null;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly m = new Matrix4();
  private readonly t = new Matrix4();
  private readonly v = new Vector3();

  async load(stage: Stage): Promise<void> {
    this.stage = stage;
    await this.model.load(stage);
    const sk = this.model.skeleton;
    this.midX = sk.skull.midX;
    this.target.x = this.midX;
    this.bones = [...sk.bones.values()];
    for (const [key, text] of LABELS) {
      const bone = sk.bones.get(key);
      if (bone) this.anchors.push({ bone, anchor: { text, pos: new Vector3(), entity: 'body' } });
    }
    this.listen(stage.canvas);
  }

  setView(view: ExploreView): void {
    const v = VIEWS[view];
    const target = new Vector3(...v.target);
    target.x = view === 'hand' ? v.target[0] : this.midX;
    // Keep turning the short way round.
    const yaw = this.yaw + (((v.yaw - this.yaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.goal = { yaw, pitch: v.pitch, dist: v.dist, target };
  }

  update(frame: FrameInput, options: ViewOptions): LabelAnchor[] {
    this.enabled = true;
    const { dt } = frame;
    const { layers } = options;
    if (this.goal) {
      const k = 1 - Math.exp(-dt * 6);
      this.yaw += (this.goal.yaw - this.yaw) * k;
      this.pitch += (this.goal.pitch - this.pitch) * k;
      this.dist += (this.goal.dist - this.dist) * k;
      this.target.lerp(this.goal.target, k);
      if (Math.abs(this.goal.dist - this.dist) < 0.2 && this.target.distanceTo(this.goal.target) < 0.1) this.goal = null;
    }
    if (this.spin && !this.pointers.size) this.yaw += dt * 0.35;

    // Model matrix: turn the body about the target, then set it in front of the camera.
    this.m.makeTranslation(0, 0, -this.dist)
      .multiply(this.t.makeRotationX(this.pitch))
      .multiply(this.t.makeRotationY(this.yaw))
      .multiply(this.t.makeTranslation(-this.target.x, -this.target.y, -this.target.z));
    for (const b of this.bones) {
      b.node.matrix.copy(this.m);
      b.node.matrixWorldNeedsUpdate = true;
      b.node.visible = true;
    }
    this.model.mask.mesh.visible = false;
    this.model.skullStyle.clip.set(0, 0, 0, 1);
    this.model.skeleton.root.visible = layers.bones;

    const systems = this.model.systems;
    this.model.dimBones(!!systems && (layers.nerves || layers.blood));
    if (systems && (layers.nerves || layers.blood)) {
      return systems.update(frame.time / 1000, layers, HumanModel.focalPixels(this.stage), true);
    }
    systems?.hide();
    if (!layers.bones) return [];
    return this.anchors.map(({ bone, anchor }) => {
      anchor.pos.copy(bone.info.anchor).applyMatrix4(this.m);
      return anchor;
    });
  }

  hide(): void {
    this.enabled = false;
    this.pointers.clear();
    for (const b of this.bones) b.node.visible = false;
    if (this.model.skeleton) this.model.skeleton.root.visible = true;
    this.model.systems?.hide();
  }

  dispose(): void {
    this.hide();
  }

  /** Drag to turn, pinch or scroll to zoom, two fingers or right button to move, double-click to reset. */
  private listen(canvas: HTMLCanvasElement): void {
    const focalCss = () => canvas.getBoundingClientRect().height / 2 / Math.tan((this.stage.camera.fov * Math.PI) / 360);
    const zoom = (factor: number) => {
      this.goal = null;
      this.dist = Math.min(Math.max(this.dist * factor, 18), 340);
    };
    const pan = (dx: number, dy: number) => {
      this.goal = null;
      const k = this.dist / focalCss();
      // Screen right and up, expressed in the body's rest frame.
      const inv = this.t.makeRotationX(this.pitch).multiply(new Matrix4().makeRotationY(this.yaw)).invert();
      this.target.addScaledVector(this.v.set(1, 0, 0).applyMatrix4(inv), -dx * k);
      this.target.addScaledVector(this.v.set(0, 1, 0).applyMatrix4(inv), dy * k);
    };
    let panning = false;
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      panning = e.button === 2 || e.shiftKey;
      this.goal = null;
    });
    canvas.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!this.enabled || !prev) return;
      if (this.pointers.size === 1) {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        if (panning) pan(dx, dy);
        else {
          this.yaw += dx * 0.008;
          this.pitch = Math.min(Math.max(this.pitch + dy * 0.006, -1.3), 1.3);
        }
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.entries()];
        const other = a[0] === e.pointerId ? b[1] : a[1];
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 0 && after > 0) zoom(before / after);
        pan((e.clientX - prev.x) / 2, (e.clientY - prev.y) / 2);
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      panning = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', (e) => this.enabled && e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    canvas.addEventListener('dblclick', () => this.enabled && this.setView('body'));
  }
}
