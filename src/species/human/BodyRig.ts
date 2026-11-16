import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { Matrix4, Vector3 } from 'three';
import { PointSmoother } from '../../core/filters';
import { planeFrame, segmentFrame, solveTranslation, toNdc, unproject, type Point2 } from '../../core/math';
import type { LabelAnchor } from '../types';
import type { Bone, Skeleton } from './skeleton';

/** MediaPipe Pose landmark indices for the subject's left side; right is +1. */
const LM = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 } as const;
type JointName = keyof typeof LM;
type Side = 'L' | 'R';
const VISIBLE = 0.5;

/** How much each neck vertebra follows the skull rather than the rib cage. */
const NECK: [string, number][] = [
  ['atlas', 0.92], ['axis', 0.8], ['c3', 0.66], ['c4', 0.52], ['c5', 0.38], ['c6', 0.24], ['c7', 0.1],
];
const LABELS: [string, string][] = [
  ['clavicle_L', 'Clavicle'], ['body_of_sternum', 'Sternum'], ['rib6_R', 'Ribs'], ['scapula_R', 'Scapula'],
  ['humerus_R', 'Humerus'], ['radius_L', 'Radius'], ['ulna_R', 'Ulna'], ['l3', 'Lumbar vertebrae'],
  ['hip_L', 'Hip bone'], ['sacrum', 'Sacrum'], ['femur_R', 'Femur'], ['patella_L', 'Patella'],
  ['tibia_R', 'Tibia'], ['fibula_L', 'Fibula'],
];

/** A limb bone (or bones) stretched between two joints. */
interface Limb {
  bones: Bone[];
  from: JointName;
  to: JointName;
  /** The joint after `to`, used to find the hinge axis; absent for the foot. */
  next?: JointName;
  side: Side;
  restInv: Matrix4;
  restLen: number;
  /** Hinge axis in camera space, kept from the last frame the limb was bent. */
  hint: Vector3;
  hasHint: boolean;
}

/**
 * Poses the trunk and limbs from MediaPipe Pose. The rib cage follows the
 * shoulders, the pelvis follows the hips, and the lumbar and neck vertebrae
 * are blended between their neighbours.
 */
export class BodyRig {
  /** Wrist position per side from a tracked hand, which is more precise than the pose wrist. */
  readonly handWrist: Record<Side, Vector3 | null> = { L: null, R: null };
  private readonly all: Bone[] = [];
  private readonly chest: Bone[] = [];
  private readonly pelvis: Bone[] = [];
  private readonly lumbar: { bone: Bone; t: number }[] = [];
  private readonly neck: { bone: Bone; t: number }[] = [];
  private readonly limbs: Limb[] = [];
  private readonly rest: Record<string, Vector3> = {};
  private readonly restChestInv = new Matrix4();
  private readonly restPelvisInv = new Matrix4();
  private readonly restShoulderWidth: number;
  private readonly restTorso: number;
  private readonly labels: { bone: Bone; anchor: LabelAnchor }[] = [];
  private readonly smoother = new PointSmoother(33, 1.2, 0.04);
  private active = false;

  private readonly J = Array.from({ length: 33 }, () => new Vector3());
  private readonly rel: Vector3[] = [];
  private readonly ndcAll: Point2[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
  private readonly ndcFit: Point2[] = [];
  private readonly t = new Vector3();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly midS = new Vector3();
  private readonly midH = new Vector3();
  private readonly chestM = new Matrix4();
  private readonly pelvisM = new Matrix4();
  private readonly m = new Matrix4();
  private readonly scaleM = new Matrix4();

  constructor(skeleton: Skeleton) {
    for (const [name, p] of Object.entries(skeleton.joints)) this.rest[name] = new Vector3(p[0], p[1], p[2]);
    const limbBones: Record<string, Bone[]> = {};
    for (const bone of skeleton.bones.values()) {
      const { group, side } = bone.info;
      const k = bone.key;
      if (group === 'thorax' || group === 'shoulder' || /^(t\d+|disc_t\d+)$/.test(k)) this.chest.push(bone);
      else if (group === 'pelvis') this.pelvis.push(bone);
      else if (/^(l\d|disc_l\d)$/.test(k)) {
        // L1 mostly follows the rib cage, L5 mostly follows the pelvis.
        const n = Number(k.slice(-1));
        this.lumbar.push({ bone, t: (n - (k.startsWith('disc') ? 0.2 : 0.5)) / 5 });
      } else if (['arm', 'forearm', 'thigh', 'shin', 'foot'].includes(group)) {
        (limbBones[`${group}_${side}`] ??= []).push(bone);
      } else continue;
      this.all.push(bone);
    }
    for (const [key, t] of NECK) {
      const bone = skeleton.bones.get(key);
      if (bone) {
        this.neck.push({ bone, t });
        this.all.push(bone);
      }
    }

    const r = this.rest;
    const midS = r.shoulder_L.clone().add(r.shoulder_R).multiplyScalar(0.5);
    const midH = r.hip_L.clone().add(r.hip_R).multiplyScalar(0.5);
    const up = midS.clone().sub(midH);
    this.restShoulderWidth = r.shoulder_L.distanceTo(r.shoulder_R);
    this.restTorso = up.length();
    planeFrame(this.restChestInv, midS, r.shoulder_L.clone().sub(r.shoulder_R), up);
    this.restChestInv.invert();
    planeFrame(this.restPelvisInv, midH, r.hip_L.clone().sub(r.hip_R), up);
    this.restPelvisInv.invert();

    // In the rest pose the elbow hinge axis points to -X and the knee axis to +X
    // (the sign that the cross product of the two limb segments gives when bent).
    const specs: [string, JointName, JointName, JointName | undefined, Vector3][] = [
      ['arm', 'shoulder', 'elbow', 'wrist', new Vector3(-1, 0, 0)],
      ['forearm', 'elbow', 'wrist', undefined, new Vector3(-1, 0, 0)],
      ['thigh', 'hip', 'knee', 'ankle', new Vector3(1, 0, 0)],
      ['shin', 'knee', 'ankle', undefined, new Vector3(1, 0, 0)],
    ];
    for (const side of ['L', 'R'] as Side[]) {
      for (const [group, from, to, next, restHint] of specs) {
        const restInv = new Matrix4();
        const restLen = segmentFrame(restInv, r[`${from}_${side}`], r[`${to}_${side}`], restHint);
        this.limbs.push({ bones: limbBones[`${group}_${side}`] ?? [], from, to, next, side,
          restInv: restInv.invert(), restLen, hint: new Vector3(), hasHint: false });
      }
      const restInv = new Matrix4();
      const heel = r[`heel_${side}`];
      const restLen = segmentFrame(restInv, heel, r[`toe_${side}`], r[`ankle_${side}`].clone().sub(heel));
      this.limbs.push({ bones: limbBones[`foot_${side}`] ?? [], from: 'heel', to: 'toe', side,
        restInv: restInv.invert(), restLen, hint: new Vector3(), hasHint: false });
    }
    for (const [key, text] of LABELS) {
      const bone = skeleton.bones.get(key);
      if (bone) this.labels.push({ bone, anchor: { text, pos: new Vector3(), entity: 'body' } });
    }
  }

  hide(): void {
    if (!this.active) return;
    this.active = false;
    this.smoother.reset();
    for (const limb of this.limbs) limb.hasHint = false;
    for (const b of this.all) b.node.visible = false;
  }

  /**
   * @param skullBase rest-to-camera matrix of the tracked skull, or null; the
   *   neck is blended towards it so the spine meets the head.
   */
  update(landmarks: NormalizedLandmark[], world: Landmark[], aspect: number, dt: number, skullBase: Matrix4 | null): LabelAnchor[] {
    const vis = (i: number) => (landmarks[i].visibility ?? 0) > VISIBLE;
    if (!vis(LM.shoulder) || !vis(LM.shoulder + 1)) {
      this.hide();
      return [];
    }
    this.active = true;

    // Place the metric, hip-centred skeleton in front of the camera using the
    // landmarks that are actually in view, then pin every joint to the image.
    this.rel.length = 0;
    this.ndcFit.length = 0;
    const J = this.J;
    for (let i = 0; i < 33; i++) {
      J[i].set(world[i].x * 100, -world[i].y * 100, -world[i].z * 100);
      toNdc(landmarks[i], this.ndcAll[i]);
      if (i >= 11 && vis(i)) {
        this.rel.push(J[i]);
        this.ndcFit.push(this.ndcAll[i]);
      }
    }
    solveTranslation(this.rel, this.ndcFit, aspect, this.t);
    for (let i = 0; i < 33; i++) {
      const depth = Math.max(-(J[i].z + this.t.z), 10);
      unproject(this.ndcAll[i], depth, aspect, J[i]);
    }
    this.smoother.apply(J, dt);

    const joint = (name: JointName, side: Side) => J[LM[name] + (side === 'R' ? 1 : 0)];
    const seen = (name: JointName, side: Side) => vis(LM[name] + (side === 'R' ? 1 : 0));

    // Trunk: rib cage from the shoulders, pelvis from the hips.
    const sL = joint('shoulder', 'L'), sR = joint('shoulder', 'R');
    const hL = joint('hip', 'L'), hR = joint('hip', 'R');
    this.midS.addVectors(sL, sR).multiplyScalar(0.5);
    this.midH.addVectors(hL, hR).multiplyScalar(0.5);
    const hipsSeen = seen('hip', 'L') && seen('hip', 'R');
    const up = this.v1.subVectors(this.midS, this.midH);
    const sx = sL.distanceTo(sR) / this.restShoulderWidth;
    const sy = hipsSeen ? up.length() / this.restTorso : sx;
    const acrossS = this.v2.subVectors(sL, sR);
    planeFrame(this.chestM, this.midS, acrossS, up);
    this.chestM.multiply(this.scaleM.makeScale(sx, sy, (sx + sy) / 2)).multiply(this.restChestInv);
    if (hipsSeen) {
      // The pelvis takes its width from the shoulders: tracked hip points sit
      // wider than the hip joints, which would inflate it.
      planeFrame(this.pelvisM, this.midH, this.v3.subVectors(hL, hR), up);
      this.pelvisM.multiply(this.scaleM.makeScale(sx, sy, (sx + sy) / 2)).multiply(this.restPelvisInv);
    } else {
      this.pelvisM.copy(this.chestM);
    }
    for (const b of this.chest) this.place(b, this.chestM, true);
    for (const b of this.pelvis) this.place(b, this.pelvisM, true);
    for (const { bone, t } of this.lumbar) this.place(bone, blend(this.m, this.chestM, this.pelvisM, t), true);
    for (const { bone, t } of this.neck) {
      this.place(bone, skullBase ? blend(this.m, this.chestM, skullBase, t) : this.chestM, true);
    }

    // Limbs.
    const thickness = sx;
    for (const limb of this.limbs) {
      const { side } = limb;
      const visible = seen(limb.from, side) && seen(limb.to, side) && (limb.from !== 'hip' || hipsSeen);
      if (!visible) {
        limb.hasHint = false;
        for (const b of limb.bones) b.node.visible = false;
        continue;
      }
      const a = joint(limb.from, side);
      let b = joint(limb.to, side);
      if (limb.to === 'wrist' && this.handWrist[side]) b = this.handWrist[side]!;
      this.updateHint(limb, joint);
      const len = segmentFrame(this.m, a, b, limb.hint);
      const isFoot = limb.from === 'heel';
      const girth = isFoot ? len / limb.restLen : thickness;
      this.m.multiply(this.scaleM.makeScale(girth, len / limb.restLen, girth)).multiply(limb.restInv);
      for (const bone of limb.bones) this.place(bone, this.m, true);
    }

    const out: LabelAnchor[] = [];
    for (const { bone, anchor } of this.labels) {
      if (!bone.node.visible) continue;
      anchor.pos.copy(bone.info.anchor).applyMatrix4(bone.node.matrix);
      out.push(anchor);
    }
    return out;
  }

  /** Finds the roll reference for a limb: its hinge axis, or the ankle for the foot. */
  private updateHint(limb: Limb, joint: (name: JointName, side: Side) => Vector3): void {
    const { side } = limb;
    if (limb.from === 'heel') {
      limb.hint.subVectors(joint('ankle', side), joint('heel', side));
      return;
    }
    // The hinge axis is perpendicular to both segments of the limb. It is only
    // measurable while the joint is bent; otherwise keep the last good value.
    const arm = limb.from === 'shoulder' || limb.from === 'elbow';
    const [p, q, r] = arm
      ? [joint('shoulder', side), joint('elbow', side), joint('wrist', side)]
      : [joint('hip', side), joint('knee', side), joint('ankle', side)];
    const u = this.v2.subVectors(q, p);
    const w = this.v3.subVectors(r, q);
    const n = new Vector3().crossVectors(u, w);
    const bend = n.length() / (u.length() * w.length() || 1);
    if (bend > 0.3) {
      n.normalize();
      if (limb.hasHint) limb.hint.lerp(n, 0.35).normalize();
      else limb.hint.copy(n);
      limb.hasHint = true;
    } else if (!limb.hasHint) {
      // Straight limb and no history: assume the hinge is parallel to the shoulders or hips.
      const across = arm
        ? n.subVectors(joint('shoulder', 'R'), joint('shoulder', 'L'))
        : n.subVectors(joint('hip', 'L'), joint('hip', 'R'));
      limb.hint.copy(across).normalize();
    }
  }

  private place(bone: Bone, m: Matrix4, visible: boolean): void {
    bone.node.matrix.copy(m);
    bone.node.matrixWorldNeedsUpdate = true;
    bone.node.visible = visible;
  }
}

/** Element-wise blend of two transforms; adequate for the small differences between neighbours. */
function blend(out: Matrix4, a: Matrix4, b: Matrix4, t: number): Matrix4 {
  for (let i = 0; i < 16; i++) out.elements[i] = a.elements[i] + (b.elements[i] - a.elements[i]) * t;
  return out;
}
