import { Matrix4, Vector3 } from 'three';

/** Vertical field of view of the scene camera, matching MediaPipe's face geometry. */
export const FOV_DEG = 63;
export const FOCAL = 1 / Math.tan((FOV_DEG * Math.PI) / 360);

export interface Point2 {
  x: number;
  y: number;
}

/** MediaPipe normalised image coordinates (origin top-left) to NDC. */
export function toNdc(p: Point2, out: Point2 = { x: 0, y: 0 }): Point2 {
  out.x = p.x * 2 - 1;
  out.y = 1 - p.y * 2;
  return out;
}

/** Camera-space point that projects to `ndc` at distance `depth` in front of the camera. */
export function unproject(ndc: Point2, depth: number, aspect: number, out: Vector3): Vector3 {
  return out.set((ndc.x * depth * aspect) / FOCAL, (ndc.y * depth) / FOCAL, -depth);
}

/**
 * Finds the translation t so that the points `rel[i] + t` (camera space) project
 * onto `ndc[i]`. `rel` are points known only relative to their own centre, such
 * as MediaPipe world landmarks. Linear least squares on three unknowns.
 */
export function solveTranslation(rel: Vector3[], ndc: Point2[], aspect: number, out: Vector3): Vector3 {
  const fx = FOCAL / aspect;
  const fy = FOCAL;
  // Normal equations A^T A t = A^T b, rows: [fx, 0, nx] and [0, fy, ny].
  let a00 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < rel.length; i++) {
    const p = rel[i];
    const n = ndc[i];
    const rx = -n.x * p.z - fx * p.x;
    const ry = -n.y * p.z - fy * p.y;
    a00 += fx * fx;
    a02 += fx * n.x;
    a11 += fy * fy;
    a12 += fy * n.y;
    a22 += n.x * n.x + n.y * n.y;
    b0 += fx * rx;
    b1 += fy * ry;
    b2 += n.x * rx + n.y * ry;
  }
  // Solve the symmetric system [[a00,0,a02],[0,a11,a12],[a02,a12,a22]] by elimination.
  const d = a22 - (a02 * a02) / a00 - (a12 * a12) / a11;
  const tz = (b2 - (a02 * b0) / a00 - (a12 * b1) / a11) / d;
  const tx = (b0 - a02 * tz) / a00;
  const ty = (b1 - a12 * tz) / a11;
  return out.set(tx, ty, tz);
}

const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();

/**
 * Rigid frame with origin `a`, +Y towards `b`, and +X as close to `hint` as
 * possible. Returns the segment length.
 */
export function segmentFrame(out: Matrix4, a: Vector3, b: Vector3, hint: Vector3): number {
  _y.subVectors(b, a);
  const len = _y.length() || 1e-6;
  _y.divideScalar(len);
  _x.copy(hint).addScaledVector(_y, -hint.dot(_y));
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _x.normalize();
  _z.crossVectors(_x, _y);
  out.makeBasis(_x, _y, _z).setPosition(a);
  return len;
}

/**
 * Rigid frame with origin `o`, +Y towards `up`, +X towards `across` (made
 * perpendicular to Y).
 */
export function planeFrame(out: Matrix4, o: Vector3, across: Vector3, up: Vector3): void {
  _y.copy(up).normalize();
  _x.copy(across).addScaledVector(_y, -across.dot(_y)).normalize();
  _z.crossVectors(_x, _y);
  out.makeBasis(_x, _y, _z).setPosition(o);
}
