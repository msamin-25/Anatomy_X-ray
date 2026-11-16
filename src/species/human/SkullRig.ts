import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { OneEuro, PointSmoother, RotationSmoother } from '../../core/filters';
import { solveTranslation, toNdc, type Point2 } from '../../core/math';
import type { FaceMask } from '../../render/FaceMask';
import type { XrayStyle } from '../../render/xray';
import type { FaceMode, LabelAnchor } from '../types';
import type { Bone, Skeleton } from './skeleton';

/** A few stable points of MediaPipe's canonical face model (cm), by landmark index. */
const CANONICAL: Record<number, [number, number, number]> = {
  10: [0, 8.262, 4.482], 152: [0, -9.403, 4.264], 168: [0, 3.271, 5.236], 1: [0, -1.127, 7.476],
  234: [-7.664, 0.673, -2.436], 454: [7.664, 0.673, -2.436], 33: [-4.446, 2.664, 3.173],
  263: [4.446, 2.664, 3.173], 133: [-1.856, 2.585, 3.758], 362: [1.856, 2.585, 3.758],
  61: [-2.456, -4.343, 4.284], 291: [2.456, -4.343, 4.284], 199: [0, -7.942, 5.181],
  6: [0, 2.473, 5.789], 127: [-7.743, 2.365, -2.005], 356: [7.743, 2.365, -2.005],
  58: [-6.72, -4.789, -1.745], 288: [6.72, -4.789, -1.745],
};
const REF_IDS = Object.keys(CANONICAL).map(Number);

/** Bones worth a label, in the order they are listed. */
const LABELLED = ['frontal', 'parietal', 'sphenoid', 'temporal', 'nasal', 'zygomatic', 'maxilla', 'mandible'];
const MAX_JAW_ANGLE = 0.5; // radians at jawOpen = 1

/** Locks the skull to the head and opens the jaw with the mouth. */
export class SkullRig {
  /** Which half of the face is revealed in half mode: the subject's left or right. */
  side: 'L' | 'R' = 'L';
  private readonly cranium: Bone[] = [];
  private readonly jaw: Bone[] = [];
  private readonly labelled: Bone[] = [];
  private readonly teeth: Bone | undefined;
  private readonly fit = new Matrix4();
  private readonly hinge: Vector3;
  private readonly hingeAxis: Vector3;
  private readonly midX: number;

  private readonly posFilter = new PointSmoother(1, 1.2, 0.02);
  private readonly rotFilter = new RotationSmoother();
  private readonly jawFilter = new OneEuro(2, 0.5);

  private readonly head = new Matrix4();
  private readonly pos = new Vector3();
  private readonly quat = new Quaternion();
  private readonly scale = new Vector3();
  /** Rest-to-camera matrix of the cranium; valid while `tracked`. */
  readonly base = new Matrix4();
  tracked = false;
  private readonly jawLocal = new Matrix4();
  private readonly tmpM = new Matrix4();
  private readonly rel = REF_IDS.map(() => new Vector3());
  private readonly refNdc: Point2[] = REF_IDS.map(() => ({ x: 0, y: 0 }));
  private readonly ndc: Point2[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  private readonly anchors: LabelAnchor[] = [];

  constructor(skeleton: Skeleton, private style: XrayStyle, private mask: FaceMask) {
    for (const bone of skeleton.bones.values()) {
      if (bone.info.group === 'cranium') this.cranium.push(bone);
      if (bone.info.group === 'jaw') this.jaw.push(bone);
    }
    for (const stem of LABELLED) {
      for (const key of [stem, `${stem}_L`, `${stem}_R`]) {
        const bone = skeleton.bones.get(key);
        if (bone) this.labelled.push(bone);
      }
    }
    this.teeth = skeleton.bones.get('tooth_upper_canine_L');
    this.fit.fromArray(skeleton.skull.fit);
    this.midX = skeleton.skull.midX;
    const [l, r] = skeleton.skull.jawHinge.map((p) => new Vector3(p[0], p[1], p[2]));
    this.hinge = l.clone().add(r).multiplyScalar(0.5);
    this.hingeAxis = l.clone().sub(r).normalize();
    for (const bone of this.labelled) this.anchors.push({ text: bone.info.name, pos: new Vector3(), entity: 'face' });
    if (this.teeth) this.anchors.push({ text: 'Teeth', pos: new Vector3(), entity: 'face' });
  }

  private show(visible: boolean): void {
    this.tracked = visible;
    for (const b of this.cranium) b.node.visible = visible;
    for (const b of this.jaw) b.node.visible = visible;
    this.mask.mesh.visible = visible;
  }

  reset(): void {
    this.show(false);
    this.posFilter.reset();
    this.rotFilter.reset();
    this.jawFilter.reset();
  }

  update(result: FaceLandmarkerResult, aspect: number, dt: number, mode: FaceMode): LabelAnchor[] {
    const landmarks = result.faceLandmarks[0];
    const matrix = result.facialTransformationMatrixes?.[0];
    if (mode === 'off' || !landmarks || !matrix) {
      this.reset();
      return [];
    }
    this.show(true);

    // Head rotation and size come from MediaPipe; the position is re-solved so
    // the canonical face projects exactly onto the tracked landmarks.
    this.head.fromArray(matrix.data);
    this.head.decompose(this.pos, this.quat, this.scale);
    this.rotFilter.apply(this.quat, dt);
    for (let i = 0; i < REF_IDS.length; i++) {
      const id = REF_IDS[i];
      const c = CANONICAL[id];
      this.rel[i].set(c[0], c[1], c[2]).multiply(this.scale).applyQuaternion(this.quat);
      toNdc(landmarks[id], this.refNdc[i]);
    }
    solveTranslation(this.rel, this.refNdc, aspect, this.pos);
    this.posFilter.apply([this.pos], dt);
    this.head.compose(this.pos, this.quat, this.scale);

    this.base.multiplyMatrices(this.head, this.fit);
    for (const b of this.cranium) this.place(b, this.base);

    const open = result.faceBlendshapes?.[0]?.categories.find((c) => c.categoryName === 'jawOpen')?.score ?? 0;
    const angle = this.jawFilter.filter(open, dt) * MAX_JAW_ANGLE;
    this.jawLocal
      .makeTranslation(this.hinge.x, this.hinge.y, this.hinge.z)
      .multiply(this.tmpM.makeRotationAxis(this.hingeAxis, angle))
      .multiply(this.tmpM.makeTranslation(-this.hinge.x, -this.hinge.y, -this.hinge.z));
    this.jawLocal.premultiply(this.base);
    for (const b of this.jaw) this.place(b, this.jawLocal);

    // Reveal region: everything, or one side of the head's midline plane.
    for (let i = 0; i < landmarks.length && i < this.ndc.length; i++) toNdc(landmarks[i], this.ndc[i]);
    this.mask.update(this.ndc);
    if (mode === 'half') {
      const sign = this.side === 'L' ? 1 : -1;
      const n = new Vector3().setFromMatrixColumn(this.head, 0).normalize().multiplyScalar(sign);
      this.style.clip.set(n.x, n.y, n.z, -n.dot(this.pos));
      // Same split in 2D for the tint: the line through forehead and chin.
      const top = this.ndc[10];
      const chin = this.ndc[152];
      const cheek = this.ndc[this.side === 'L' ? 454 : 234];
      let a = chin.y - top.y;
      let b = top.x - chin.x;
      let c = -(a * top.x + b * top.y);
      if (a * cheek.x + b * cheek.y + c < 0) (a = -a), (b = -b), (c = -c);
      this.mask.clip.set(a, b, c, 0);
    } else {
      this.style.clip.set(0, 0, 0, 1);
      this.mask.clip.set(0, 0, 1, 0);
    }

    const out: LabelAnchor[] = [];
    this.labelled.forEach((bone, i) => {
      if (mode === 'half' && bone.info.side && bone.info.side !== this.side) return;
      const pos = this.anchors[i].pos.copy(bone.info.anchor);
      // Midline bones are labelled on the revealed half.
      if (!bone.info.side && this.side === 'R') pos.x = 2 * this.midX - pos.x;
      pos.applyMatrix4(bone.node.matrix);
      out.push(this.anchors[i]);
    });
    if (this.teeth) {
      const a = this.anchors[this.anchors.length - 1];
      a.pos.copy(this.teeth.info.c);
      if (this.side === 'R') a.pos.x = 2 * this.midX - a.pos.x;
      a.pos.applyMatrix4(this.base);
      out.push(a);
    }
    return out;
  }

  private place(bone: Bone, m: Matrix4): void {
    bone.node.matrix.copy(m);
    bone.node.matrixWorldNeedsUpdate = true;
  }
}
