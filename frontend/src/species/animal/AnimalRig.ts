import { BufferGeometry, CatmullRomCurve3, Group, Matrix4, Vector3 } from 'three';
import { OneEuro, PointSmoother } from '../../core/filters';
import { segmentFrame, toNdc, unproject, type Point2 } from '../../core/math';
import type { XrayStyle } from '../../render/xray';
import type { LabelAnchor } from '../types';
import { debugInfo, KP, type Keypoint } from './AnimalTracker';
import * as G from './geometry';
import type { SpeciesSpec } from './species';

/**
 * The animal is placed at this distance (cm). A single camera gives no
 * absolute size, so only proportions matter: everything scales with it.
 */
const DEPTH = 150;
const VISIBLE = 0.4;
/** Limbs are often partly hidden behind the body; accept weaker points. */
const LIMB_VISIBLE = 0.3;
const COUNT = { cervical: 7, thoracic: 13, lumbar: 7, caudal: 12 };
/** Shares of the back, tail root to neck. */
const BACK = { sacrum: 0.12, lumbar: 0.42, thoracic: 0.46 };
const NECK_LENGTH = 0.35;

type Side = 'L' | 'R';
const SIGN: Record<Side, 1 | -1> = { L: 1, R: -1 };

interface Piece {
  node: Group;
  /** Authored length along +Y in body units; the rig stretches it to the live joint distance. */
  len0: number;
}

interface Limb {
  scapula: Piece;
  humerus: Piece;
  radius: Piece;
  metacarpus: Piece;
  forePaw: Piece;
  pelvis: Piece;
  femur: Piece;
  tibia: Piece;
  metatarsus: Piece;
  hindPaw: Piece;
}

interface Label {
  piece: Piece;
  /** Point in the piece's authored frame. */
  local: Vector3;
  /** Limb labels are drawn only for the side nearer the camera. */
  side?: Side;
  anchor: LabelAnchor;
}

/**
 * Poses a procedural quadruped skeleton from AP-10K's 17 keypoints.
 *
 * Keypoints are 2D, so depth comes from the body's proportions: the scale is
 * the largest ratio of a measured to an expected segment length (segments
 * only shrink when they turn away from the camera), the body's yaw comes from
 * how much the spine is foreshortened, and its sign from which side's legs
 * appear on the left of the image. Each keypoint is then lifted onto the
 * sagittal plane of its own side of the body.
 */
export class AnimalRig {
  readonly root = new Group();
  private readonly skull: Piece;
  private readonly cervical: Piece[] = [];
  private readonly thoracic: Piece[] = [];
  private readonly lumbar: Piece[] = [];
  private readonly sacrum: Piece;
  private readonly caudal: Piece[] = [];
  private readonly limbs: Record<Side, Limb>;
  private readonly all: Piece[] = [];
  private readonly labels: Label[] = [];
  private readonly smoother = new PointSmoother(17, 1.0, 0.02);
  private readonly scaleFilter = new OneEuro(0.5, 0.004);
  private readonly bodyYaw = new OneEuro(0.8, 0.1);
  private readonly headYaw = new OneEuro(1.2, 0.2);
  private active = false;

  /** Keypoints on the depth plane, then lifted to their place in 3D. */
  private readonly P = Array.from({ length: 17 }, () => new Vector3());
  private readonly J = Array.from({ length: 17 }, () => new Vector3());
  private readonly ndc: Point2[] = Array.from({ length: 17 }, () => ({ x: 0, y: 0 }));
  private readonly back = new CatmullRomCurve3([new Vector3(), new Vector3(), new Vector3(), new Vector3()]);
  private readonly neck = new CatmullRomCurve3([new Vector3(), new Vector3(), new Vector3()]);
  private readonly tail = new CatmullRomCurve3([new Vector3(), new Vector3(), new Vector3()]);
  private readonly f = new Vector3();
  private readonly d = new Vector3();
  private readonly l = new Vector3();
  private readonly headM = new Matrix4();
  private readonly m = new Matrix4();
  private readonly scaleM = new Matrix4();
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  constructor(readonly spec: SpeciesSpec, style: XrayStyle) {
    const piece = (geometry: BufferGeometry, name: string, len0 = 0): Piece => {
      const p = { node: style.makeBone(geometry, name), len0 };
      p.node.visible = false;
      this.root.add(p.node);
      this.all.push(p);
      return p;
    };
    this.skull = piece(G.skull(spec.skull), 'skull');
    const neckLen = NECK_LENGTH / COUNT.cervical;
    for (let i = 0; i < COUNT.cervical; i++) {
      this.cervical.push(piece(G.vertebra(spec, 'cervical', neckLen, i, COUNT.cervical), `c${COUNT.cervical - i}`, neckLen));
    }
    const tLen = BACK.thoracic / COUNT.thoracic;
    for (let i = 0; i < COUNT.thoracic; i++) {
      this.thoracic.push(piece(G.vertebra(spec, 'thoracic', tLen, i, COUNT.thoracic), `t${COUNT.thoracic - i}`, tLen));
    }
    const lLen = BACK.lumbar / COUNT.lumbar;
    for (let i = 0; i < COUNT.lumbar; i++) {
      this.lumbar.push(piece(G.vertebra(spec, 'lumbar', lLen, i, COUNT.lumbar), `l${COUNT.lumbar - i}`, lLen));
    }
    this.sacrum = piece(G.vertebra(spec, 'sacrum', BACK.sacrum, 0, 1), 'sacrum', BACK.sacrum);
    const cLen = spec.tailLength / COUNT.caudal;
    for (let i = 0; i < COUNT.caudal; i++) {
      this.caudal.push(piece(G.vertebra(spec, 'caudal', cLen, i, COUNT.caudal), `cd${i + 1}`, cLen));
    }
    const limb = (side: Side): Limb => {
      const s = SIGN[side];
      return {
        scapula: piece(G.scapula(spec, s), `scapula_${side}`, spec.scapula),
        humerus: piece(G.humerus(spec), `humerus_${side}`, spec.humerus),
        radius: piece(G.radiusUlna(spec, s), `radius_${side}`, spec.radius),
        metacarpus: piece(G.metapodium(spec, spec.metacarpus, false), `metacarpus_${side}`, spec.metacarpus),
        forePaw: piece(G.paw(spec), `forepaw_${side}`),
        pelvis: piece(G.pelvis(spec, s), `pelvis_${side}`, spec.pelvis),
        femur: piece(G.femur(spec, s), `femur_${side}`, spec.femur),
        tibia: piece(G.tibia(spec, s), `tibia_${side}`, spec.tibia),
        metatarsus: piece(G.metapodium(spec, spec.metatarsus, true), `metatarsus_${side}`, spec.metatarsus),
        hindPaw: piece(G.paw(spec), `hindpaw_${side}`),
      };
    };
    this.limbs = { L: limb('L'), R: limb('R') };

    const sk = spec.skull;
    const label = (piece: Piece, text: string, local: [number, number, number], side?: Side) =>
      this.labels.push({ piece, local: new Vector3(...local), side, anchor: { text, pos: new Vector3(), entity: 'animal' } });
    label(this.skull, 'Skull', [0, sk.cranium.center[1], sk.cranium.center[2] - sk.cranium.radii[2] * 0.8]);
    label(this.skull, 'Mandible', sk.mandible[2]);
    label(this.cervical[3], 'Cervical vertebrae', [0, neckLen / 2, 0]);
    label(this.lumbar[3], 'Lumbar vertebrae', [0, lLen / 2, -spec.vertebra * 2]);
    label(this.caudal[3], 'Caudal vertebrae', [0, cLen / 2, 0]);
    for (const side of ['L', 'R'] as Side[]) {
      const s = SIGN[side];
      const L = this.limbs[side];
      label(this.thoracic[6], 'Ribs', [s * spec.chestHalfWidth, tLen / 2 - spec.chestDepth * 0.13, spec.chestDepth * 0.5], side);
      label(L.scapula, 'Scapula', [0, spec.scapula * 0.6, 0], side);
      label(L.humerus, 'Humerus', [0, spec.humerus * 0.5, 0], side);
      label(L.radius, 'Radius & ulna', [0, spec.radius * 0.5, 0], side);
      label(L.metacarpus, 'Metacarpals', [0, spec.metacarpus * 0.6, 0], side);
      label(L.pelvis, 'Pelvis', [0, spec.pelvis * 0.4, -spec.pelvis * 0.12], side);
      label(L.femur, 'Femur', [0, spec.femur * 0.5, 0], side);
      label(L.tibia, 'Tibia & fibula', [0, spec.tibia * 0.5, 0], side);
      label(L.metatarsus, 'Metatarsals', [0, spec.metatarsus * 0.6, 0], side);
    }
  }

  hide(): void {
    if (!this.active) return;
    this.active = false;
    this.smoother.reset();
    this.scaleFilter.reset();
    this.bodyYaw.reset();
    this.headYaw.reset();
    for (const p of this.all) p.node.visible = false;
  }

  update(points: Keypoint[], aspect: number, dt: number): LabelAnchor[] {
    const spec = this.spec;
    const { P, J } = this;
    const seen = (i: number, min = VISIBLE) => points[i].score > min;
    for (let i = 0; i < 17; i++) unproject(toNdc(points[i], this.ndc[i]), DEPTH, aspect, P[i]);
    this.smoother.apply(P, dt);

    // The body line: neck to tail root, or the shoulders and hips when those are hidden.
    const N = seen(KP.neck) ? P[KP.neck].clone() : mean(P, [KP.shoulderL, KP.shoulderR].filter((i) => seen(i)));
    const T = seen(KP.tail) ? P[KP.tail].clone() : mean(P, [KP.hipL, KP.hipR].filter((i) => seen(i)));
    if (!N || !T) {
      this.hide();
      return [];
    }
    this.active = true;

    // Scale (cm per body unit): the second largest measured/expected ratio,
    // which ignores a single misplaced keypoint.
    const ratios = [N.distanceTo(T)];
    const ratio = (i: number, j: number, expected: number) => {
      if (seen(i, LIMB_VISIBLE) && seen(j, LIMB_VISIBLE)) ratios.push(P[i].distanceTo(P[j]) / expected);
    };
    for (const side of ['L', 'R'] as Side[]) {
      const o = side === 'L' ? 0 : 3;
      ratio(KP.shoulderL + o, KP.elbowL + o, spec.radius);
      ratio(KP.elbowL + o, KP.frontPawL + o, spec.metacarpus);
      ratio(KP.hipL + o, KP.kneeL + o, spec.tibia);
      ratio(KP.kneeL + o, KP.backPawL + o, spec.metatarsus);
    }
    const eyes = [KP.eyeL, KP.eyeR].filter((i) => seen(i));
    const midEye = mean(P, eyes);
    if (midEye && seen(KP.nose)) ratios.push(midEye.distanceTo(P[KP.nose]) / spec.eyeToNose);
    ratios.sort((x, y) => y - x);
    const s = this.scaleFilter.filter(ratios[Math.min(1, ratios.length - 1)], dt);

    // Forward: the 2D spine plus the depth that its foreshortening implies.
    // Facing the camera, the subject's left side appears on the image right,
    // so the left-minus-right offsets of paired points give the sign.
    const hw = spec.chestHalfWidth;
    const across = this.b.set(0, 0, 0);
    let pairs = 0;
    for (const [li, ri] of [[KP.shoulderL, KP.shoulderR], [KP.hipL, KP.hipR], [KP.elbowL, KP.elbowR], [KP.kneeL, KP.kneeR]]) {
      if (seen(li, LIMB_VISIBLE) && seen(ri, LIMB_VISIBLE)) {
        across.add(P[li]).sub(P[ri]);
        pairs++;
      }
    }
    if (eyes.length === 2) {
      across.addScaledVector(P[KP.eyeL], hw / spec.eyeSpan).addScaledVector(P[KP.eyeR], -hw / spec.eyeSpan);
      pairs++;
    }
    if (pairs) across.divideScalar(pairs * 2 * hw * s);
    // Far-side points also sit higher in the image (the camera looks down), so
    // vertical offsets say little about turning; damp them.
    across.y *= 0.3;
    // 0 seen from the side, about 1 seen from the front or back.
    const frontal = Math.min(1, across.length());
    const facing = clamp(across.x * 2, -1, 1);
    const f2 = this.a.subVectors(N, T);
    const depthShare = Math.sqrt(Math.max(0, 1 - f2.lengthSq() / (s * s)));
    const yaw = this.bodyYaw.filter(depthShare * facing, dt);
    const f = this.f.set(f2.x, f2.y, yaw * s).normalize();

    // Left: from the paired points when they are well apart, otherwise from
    // dorsal (away from the paws) × forward. Dorsal = forward × left.
    const paws = mean(P, [KP.frontPawL, KP.frontPawR, KP.backPawL, KP.backPawR].filter((i) => seen(i, LIMB_VISIBLE)));
    const d = this.d.set(0, 1, 0);
    if (paws) d.addVectors(N, T).multiplyScalar(0.5).sub(paws);
    d.addScaledVector(f, -d.dot(f));
    if (d.lengthSq() < 1e-6) d.set(0, 1, 0).addScaledVector(f, -f.y);
    const l = this.l.crossVectors(d.normalize(), f).normalize();
    const w = clamp((frontal - 0.25) * 2, 0, 1);
    if (w > 0) {
      across.addScaledVector(f, -across.dot(f)).normalize();
      if (across.dot(l) < 0 && w < 0.5) across.negate();
      l.lerp(across, w);
    }
    l.addScaledVector(f, -l.dot(f)).normalize();
    d.crossVectors(f, l);
    Object.assign(debugInfo, { s, ratios, frontal, facing, yaw });

    // Lift each keypoint onto the sagittal plane of its side of the body.
    const C = N.clone().add(T).multiplyScalar(0.5);
    const lift = (i: number, offset: number) => {
      const ray = this.b.copy(P[i]).divideScalar(DEPTH);
      const plane = l.dot(C) + offset * s;
      const denom = l.dot(ray);
      const t = Math.abs(denom) > 1e-3 ? plane / denom : DEPTH;
      J[i].copy(ray).multiplyScalar(clamp(t, DEPTH - 0.8 * s, DEPTH + 0.8 * s));
    };
    lift(KP.neck, 0);
    lift(KP.tail, 0);
    for (const side of ['L', 'R'] as Side[]) {
      const sg = SIGN[side];
      const o = side === 'L' ? 0 : 3;
      lift(side === 'L' ? KP.eyeL : KP.eyeR, (sg * spec.eyeSpan) / 2);
      for (const i of [KP.shoulderL, KP.elbowL, KP.frontPawL]) lift(i + o, sg * hw * 0.85);
      for (const i of [KP.hipL, KP.kneeL, KP.backPawL]) lift(i + o, sg * hw * 0.75);
    }
    const neckJ = seen(KP.neck) ? J[KP.neck] : C.clone().addScaledVector(f, s * 0.5);
    const tailJ = seen(KP.tail) ? J[KP.tail] : C.clone().addScaledVector(f, -s * 0.5);

    // Head.
    let occiput: Vector3;
    const headSeen = eyes.length > 0 && seen(KP.nose);
    if (headSeen) {
      const eye = mean(J, eyes)!;
      const depth = -eye.z;
      // Eye-to-nose offset on the image, at the depth of the eyes; its
      // foreshortening says how far the muzzle points towards the camera.
      const h = this.b.subVectors(P[KP.nose], mean(P, eyes)!).multiplyScalar(depth / DEPTH);
      h.z = 0;
      const span = spec.eyeToNose * s;
      const turn = eyes.length === 2
        ? clamp(((P[KP.eyeL].x - P[KP.eyeR].x) / (spec.eyeSpan * s)) * 1.5, -1, 1)
        : Math.sign(yaw);
      const toward = this.headYaw.filter(Math.sqrt(Math.max(0, 1 - h.lengthSq() / (span * span))) * turn, dt) * span;
      // Keep the nose on its own camera ray so the muzzle ends on the keypoint.
      h.copy(P[KP.nose]).multiplyScalar((depth - toward) / DEPTH).sub(eye);
      const len = Math.max(h.length(), span * 0.5);
      const hf = h.normalize();
      // Head up follows the back; looking straight up or down, fall back to the body's left.
      const hu = d.clone().addScaledVector(hf, -d.dot(hf));
      if (hu.lengthSq() < 1e-4) hu.crossVectors(hf, l);
      hu.normalize();
      const hl = new Vector3().crossVectors(hu, hf);
      this.headM.makeBasis(hl, hf, new Vector3().crossVectors(hl, hf)).setPosition(eye);
      this.headM.multiply(this.scaleM.makeScale(len, len, len));
      this.place(this.skull, this.headM);
      occiput = new Vector3(...spec.skull.occiput).applyMatrix4(this.headM);
    } else {
      this.skull.node.visible = false;
      occiput = neckJ.clone().addScaledVector(f, s * 0.25).addScaledVector(d, s * 0.12);
    }

    // Spine: the back runs just under the neck-to-tail line, which follows
    // the top of the back; the neck rises from there to the skull.
    const ventral = (p: Vector3, k: number) => p.addScaledVector(d, -k * s);
    const [b0, b1, b2, b3] = this.back.points;
    ventral(b0.copy(tailJ), 0.04);
    ventral(b1.lerpVectors(tailJ, neckJ, 0.3), 0.025);
    ventral(b2.lerpVectors(tailJ, neckJ, 0.7), 0.05);
    ventral(b3.lerpVectors(neckJ, tailJ, 0.05), 0.05);
    this.back.updateArcLengths();
    let u = 0;
    u = this.chain(this.back, [this.sacrum], u, BACK.sacrum, s);
    u = this.chain(this.back, this.lumbar, u, BACK.lumbar, s);
    this.chain(this.back, this.thoracic, u, BACK.thoracic, s);

    const [n0, n1, n2] = this.neck.points;
    n0.copy(b3);
    n2.copy(occiput);
    n1.lerpVectors(n0, n2, 0.5).addScaledVector(d, 0.05 * s);
    this.neck.updateArcLengths();
    this.chain(this.neck, this.cervical, 0, 1, s);

    const [t0, t1, t2] = this.tail.points;
    t0.copy(b0);
    t1.copy(b0).addScaledVector(f, -0.45 * spec.tailLength * s).addScaledVector(d, -0.1 * spec.tailLength * s);
    // Tails mostly hang, so bend the tip towards gravity (image down) as well as ventrally.
    t2.copy(b0).addScaledVector(f, -0.6 * spec.tailLength * s).addScaledVector(d, -0.3 * spec.tailLength * s);
    t2.y -= 0.45 * spec.tailLength * s;
    this.tail.updateArcLengths();
    // The tail is stored base first; walk it from the tip so +Y points to the head.
    this.chain(this.tail, [...this.caudal].reverse(), 0, 1, s, true);

    // Limbs. AP-10K's shoulder/hip points are the elbow/stifle; the real
    // shoulder and hip joints sit between them and the body line.
    for (const side of ['L', 'R'] as Side[]) {
      const sg = SIGN[side];
      const o = side === 'L' ? 0 : 3;
      const L = this.limbs[side];
      const front = seen(KP.shoulderL + o, LIMB_VISIBLE) && seen(KP.elbowL + o, LIMB_VISIBLE);
      if (front) {
        const elbow = J[KP.shoulderL + o];
        const carpus = J[KP.elbowL + o];
        const shoulder = neckJ.clone().addScaledVector(l, sg * hw * 0.7 * s).lerp(elbow, 0.42).addScaledVector(f, 0.03 * s);
        const withers = this.back.getPointAt(BACK.sacrum + BACK.lumbar + BACK.thoracic * 0.72).addScaledVector(l, sg * hw * 0.6 * s);
        this.segment(L.scapula, shoulder, withers, s);
        this.segment(L.humerus, shoulder, elbow, s);
        this.segment(L.radius, elbow, carpus, s);
        if (seen(KP.frontPawL + o, LIMB_VISIBLE)) {
          this.segment(L.metacarpus, carpus, J[KP.frontPawL + o], s);
          this.paw(L.forePaw, J[KP.frontPawL + o], s);
        } else {
          this.hidePieces(L.metacarpus, L.forePaw);
        }
      } else {
        this.hidePieces(L.scapula, L.humerus, L.radius, L.metacarpus, L.forePaw);
      }

      const hind = seen(KP.hipL + o, LIMB_VISIBLE) && seen(KP.kneeL + o, LIMB_VISIBLE);
      if (hind) {
        const stifle = J[KP.hipL + o];
        const hock = J[KP.kneeL + o];
        const hip = tailJ.clone().addScaledVector(l, sg * hw * 0.6 * s).lerp(stifle, 0.38).addScaledVector(f, 0.02 * s);
        const sacrum = this.back.getPointAt(BACK.sacrum * 0.6).addScaledVector(l, sg * 0.03 * s);
        this.segment(L.pelvis, sacrum, hip, s);
        this.segment(L.femur, hip, stifle, s);
        this.segment(L.tibia, stifle, hock, s);
        if (seen(KP.backPawL + o, LIMB_VISIBLE)) {
          this.segment(L.metatarsus, hock, J[KP.backPawL + o], s);
          this.paw(L.hindPaw, J[KP.backPawL + o], s);
        } else {
          this.hidePieces(L.metatarsus, L.hindPaw);
        }
      } else {
        this.hidePieces(L.pelvis, L.femur, L.tibia, L.metatarsus, L.hindPaw);
      }
    }

    // Labels, limb labels on the side facing the camera.
    const near: Side = l.z >= 0 ? 'L' : 'R';
    const out: LabelAnchor[] = [];
    for (const { piece, local, side, anchor } of this.labels) {
      if (!piece.node.visible || (side && side !== near)) continue;
      anchor.pos.copy(local).applyMatrix4(piece.node.matrix);
      out.push(anchor);
    }
    return out;
  }

  /** Lays `pieces` end to end along `curve` from arc-length fraction `u` over `share` of it. */
  private chain(curve: CatmullRomCurve3, pieces: Piece[], u: number, share: number, s: number, reverse = false): number {
    const step = share / pieces.length;
    for (let i = 0; i < pieces.length; i++) {
      let u0 = u + i * step, u1 = u0 + step;
      if (reverse) [u0, u1] = [1 - u0, 1 - u1];
      curve.getPointAt(Math.min(u0, 1), this.a);
      curve.getPointAt(Math.min(u1, 1), this.b);
      this.segment(pieces[i], this.a, this.b, s);
    }
    return u + share;
  }

  /** Stretches a piece from joint `from` to joint `to`; its girth follows the body scale. */
  private segment(piece: Piece, from: Vector3, to: Vector3, s: number): void {
    const len = segmentFrame(this.m, from, to, this.l);
    this.m.multiply(this.scaleM.makeScale(s, len / piece.len0, s));
    this.place(piece, this.m);
  }

  /** Toes point forward along the body and down. */
  private paw(piece: Piece, at: Vector3, s: number): void {
    segmentFrame(this.m, at, this.a.copy(at).add(this.f), this.l);
    this.m.multiply(this.scaleM.makeScale(s, s, s));
    this.place(piece, this.m);
  }

  private place(piece: Piece, m: Matrix4): void {
    piece.node.matrix.copy(m);
    piece.node.matrixWorldNeedsUpdate = true;
    piece.node.visible = true;
  }

  private hidePieces(...pieces: Piece[]): void {
    for (const p of pieces) p.node.visible = false;
  }
}

function mean(points: Vector3[], indices: number[]): Vector3 | null {
  if (!indices.length) return null;
  const out = new Vector3();
  for (const i of indices) out.add(points[i]);
  return out.divideScalar(indices.length);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
