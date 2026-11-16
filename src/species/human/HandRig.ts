import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { Matrix4, Vector3 } from 'three';
import { PointSmoother } from '../../core/filters';
import { planeFrame, segmentFrame, solveTranslation, toNdc, unproject, type Point2 } from '../../core/math';
import type { LabelAnchor } from '../types';
import type { Bone, Skeleton } from './skeleton';

const CARPALS = ['scaphoid', 'lunate', 'triquetral', 'pisiform', 'trapezium', 'trapezoid', 'capitate', 'hamate'];
const LABELS: [string, string][] = [
  ['dp3', 'Distal phalanges'],
  ['mp3', 'Middle phalanges'],
  ['pp3', 'Proximal phalanges'],
  ['mc3', 'Metacarpals'],
  ['capitate', 'Carpals'],
];
/** How far the fingertip landmark sits beyond the end of the last bone. */
const TIP_EXTENSION = 0.25;

interface Segment {
  bone: Bone;
  /** Live joint index for the near end, or -1 when it follows the palm block. */
  from: number;
  to: number;
  restA: Vector3;
  restLen: number;
  restInv: Matrix4;
}

/**
 * Poses one hand's 27 bones from MediaPipe's 21 hand landmarks. The carpals
 * move as one block with the palm; every other bone spans two joints.
 */
export class HandRig {
  /** Tracked joints in camera space (cm), exposed for the forearm rig. */
  readonly joints = Array.from({ length: 21 }, () => new Vector3());
  active = false;
  private readonly bones: Bone[] = [];
  private readonly carpals: Bone[] = [];
  private readonly segments: Segment[] = [];
  private readonly restPalmInv = new Matrix4();
  private readonly restAcross: number;
  private readonly restUp: number;
  private readonly smoother = new PointSmoother(21, 1.8, 0.08);
  private readonly anchors: { bone: Bone; anchor: LabelAnchor }[] = [];

  private readonly rel = Array.from({ length: 21 }, () => new Vector3());
  private readonly ndc: Point2[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  private readonly t = new Vector3();
  private readonly across = new Vector3();
  private readonly up = new Vector3();
  private readonly a = new Vector3();
  private readonly palm = new Matrix4();
  private readonly frame = new Matrix4();
  private readonly scaleM = new Matrix4();

  constructor(skeleton: Skeleton, readonly side: 'L' | 'R') {
    const get = (stem: string): Bone => {
      const bone = skeleton.bones.get(`${stem}_${side}`);
      if (!bone) throw new Error(`missing bone ${stem}_${side}`);
      this.bones.push(bone);
      return bone;
    };
    const mid = (p: Vector3, q: Vector3) => p.clone().add(q).multiplyScalar(0.5);
    const tip = (b: Bone) => b.info.b.clone().addScaledVector(b.info.b.clone().sub(b.info.a), TIP_EXTENSION);

    // Rest-pose positions of the 21 landmarks, derived from the bone meshes.
    const rest: Vector3[] = [];
    for (const stem of CARPALS) this.carpals.push(get(stem));
    const row = ['scaphoid', 'lunate', 'triquetral'].map((s) => skeleton.bones.get(`${s}_${side}`)!.info.c);
    rest[0] = row[0].clone().add(row[1]).add(row[2]).divideScalar(3);

    const chains: { bone: Bone; from: number; to: number }[] = [];
    const mc1 = get('mc1'), pp1 = get('pp1'), dp1 = get('dp1');
    rest[1] = mc1.info.a.clone();
    rest[2] = mid(mc1.info.b, pp1.info.a);
    rest[3] = mid(pp1.info.b, dp1.info.a);
    rest[4] = tip(dp1);
    chains.push({ bone: mc1, from: 1, to: 2 }, { bone: pp1, from: 2, to: 3 }, { bone: dp1, from: 3, to: 4 });
    for (let d = 2; d <= 5; d++) {
      const k = 5 + (d - 2) * 4;
      const mc = get(`mc${d}`), pp = get(`pp${d}`), mp = get(`mp${d}`), dp = get(`dp${d}`);
      rest[k] = mid(mc.info.b, pp.info.a);
      rest[k + 1] = mid(pp.info.b, mp.info.a);
      rest[k + 2] = mid(mp.info.b, dp.info.a);
      rest[k + 3] = tip(dp);
      chains.push({ bone: mc, from: -1, to: k }, { bone: pp, from: k, to: k + 1 },
        { bone: mp, from: k + 1, to: k + 2 }, { bone: dp, from: k + 2, to: k + 3 });
    }

    const across = rest[17].clone().sub(rest[5]);
    const up = rest[9].clone().sub(rest[0]);
    this.restAcross = across.length();
    this.restUp = up.length();
    planeFrame(this.restPalmInv, rest[0], across, up);
    this.restPalmInv.invert();
    for (const { bone, from, to } of chains) {
      const restA = from < 0 ? bone.info.a.clone() : rest[from];
      const restInv = new Matrix4();
      const restLen = segmentFrame(restInv, restA, rest[to], across);
      this.segments.push({ bone, from, to, restA, restLen, restInv: restInv.invert() });
    }
    for (const [stem, text] of LABELS) {
      const bone = skeleton.bones.get(`${stem}_${side}`)!;
      this.anchors.push({ bone, anchor: { text, pos: new Vector3(), entity: `hand${side}` } });
    }
  }

  hide(): void {
    if (!this.active) return;
    this.active = false;
    this.smoother.reset();
    for (const b of this.bones) b.node.visible = false;
  }

  update(landmarks: NormalizedLandmark[], world: Landmark[], aspect: number, dt: number): LabelAnchor[] {
    // World landmarks are metric but centred on the hand. Find where the hand
    // is in front of the camera, then pin each joint to its image landmark.
    for (let i = 0; i < 21; i++) {
      this.rel[i].set(world[i].x * 100, -world[i].y * 100, -world[i].z * 100);
      toNdc(landmarks[i], this.ndc[i]);
    }
    solveTranslation(this.rel, this.ndc, aspect, this.t);
    const J = this.joints;
    for (let i = 0; i < 21; i++) {
      const depth = Math.max(-(this.rel[i].z + this.t.z), 5);
      unproject(this.ndc[i], depth, aspect, J[i]);
    }
    this.smoother.apply(J, dt);
    if (!this.active) {
      this.active = true;
      for (const b of this.bones) b.node.visible = true;
    }

    this.across.subVectors(J[17], J[5]);
    this.up.subVectors(J[9], J[0]);
    const sx = this.across.length() / this.restAcross;
    const sy = this.up.length() / this.restUp;
    const thickness = (sx + sy) / 2;
    planeFrame(this.palm, J[0], this.across, this.up);
    this.palm.multiply(this.scaleM.makeScale(sx, sy, thickness)).multiply(this.restPalmInv);
    for (const b of this.carpals) {
      b.node.matrix.copy(this.palm);
      b.node.matrixWorldNeedsUpdate = true;
    }

    for (const s of this.segments) {
      const start = s.from < 0 ? this.a.copy(s.restA).applyMatrix4(this.palm) : J[s.from];
      const len = segmentFrame(this.frame, start, J[s.to], this.across);
      this.frame.multiply(this.scaleM.makeScale(thickness, len / s.restLen, thickness)).multiply(s.restInv);
      s.bone.node.matrix.copy(this.frame);
      s.bone.node.matrixWorldNeedsUpdate = true;
    }

    return this.anchors.map(({ bone, anchor }) => {
      anchor.pos.copy(bone.info.c).applyMatrix4(bone.node.matrix);
      return anchor;
    });
  }
}
