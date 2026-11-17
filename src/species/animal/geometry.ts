import {
  BufferGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SkullSpec, SpeciesSpec } from './species';

/**
 * Procedural bone shapes for the quadruped skeletons. Every piece is authored
 * in its own frame: +X is the subject's left, +Y runs along the bone (from the
 * proximal joint, or from tail to head for vertebrae) and +Z = X × Y, which is
 * caudal for a limb bone pointing down, cranial for one pointing up and
 * ventral for a vertebra. Lengths are in body units (see `SpeciesSpec`).
 */

type V3 = [number, number, number];
type Side = 1 | -1;
const m = new Matrix4();
const q = new Quaternion();
const Z = new Vector3(0, 0, 1);

function merge(parts: BufferGeometry[]): BufferGeometry {
  const out = mergeGeometries(parts.map((g) => (g.index ? g : g.toNonIndexed())));
  parts.forEach((g) => g.dispose());
  if (!out) throw new Error('could not merge bone geometry');
  return out;
}

/** Body of revolution around +Y from a [y, radius] profile. */
function lathe(profile: [number, number][], radial = 12): BufferGeometry {
  return new LatheGeometry(profile.map(([y, r]) => new Vector2(Math.max(r, 0), y)), radial);
}

function ellipsoid(center: V3, radii: V3, detail = 12): BufferGeometry {
  return new SphereGeometry(1, detail, Math.round(detail * 0.75))
    .applyMatrix4(m.makeScale(radii[0], radii[1], radii[2]))
    .translate(center[0], center[1], center[2]);
}

function tube(points: V3[], radius: number, radial = 7): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(...p)));
  return new TubeGeometry(curve, points.length * 6, radius, radial, false);
}

/** A ring whose axis points along `axis`. */
function ring(center: V3, axis: V3, radius: number, thickness: number): BufferGeometry {
  q.setFromUnitVectors(Z, new Vector3(...axis).normalize());
  return new TorusGeometry(radius, thickness, 6, 24)
    .applyQuaternion(q)
    .translate(center[0], center[1], center[2]);
}

/** A cone with its base at `base` and its tip `length` along `dir`. */
function cone(base: V3, dir: V3, radius: number, length: number): BufferGeometry {
  const d = new Vector3(...dir).normalize();
  q.setFromUnitVectors(new Vector3(0, 1, 0), d);
  return new ConeGeometry(radius, length, 8)
    .translate(0, length / 2, 0)
    .applyQuaternion(q)
    .translate(base[0], base[1], base[2]);
}

/** A long bone from y = 0 to y = len: rounded ends, narrower shaft. */
function longBone(len: number, prox: number, shaft: number, dist: number, radial = 12): BufferGeometry {
  const a = Math.min(prox * 2.2, len * 0.3);
  const b = Math.min(dist * 2.2, len * 0.3);
  return lathe([
    [0, 0],
    [prox * 0.15, prox * 0.65],
    [prox * 0.6, prox],
    [a, shaft * 1.15],
    [len * 0.5, shaft],
    [len - b, shaft * 1.15],
    [len - dist * 0.6, dist],
    [len - dist * 0.15, dist * 0.65],
    [len, 0],
  ], radial);
}

// ---------------------------------------------------------------- skull

export function skull(s: SkullSpec): BufferGeometry {
  const parts: BufferGeometry[] = [
    ellipsoid(s.cranium.center, s.cranium.radii, 20),
    lathe(s.muzzle, 16).applyMatrix4(m.makeScale(0.9, 1, 0.8)).translate(0, 0, s.muzzleDrop),
  ];
  const [, cy, cz] = s.cranium.center;
  const [rx, ry, rz] = s.cranium.radii;
  // Sagittal crest and occipital ridge.
  parts.push(ellipsoid([0, cy - ry * 0.2, cz - rz * 0.92], [rx * 0.06, ry * 0.75, rz * 0.12]));
  for (const side of [1, -1] as Side[]) {
    const x = (p: V3): V3 => [p[0] * side, p[1], p[2]];
    const o = s.orbit;
    parts.push(ring(x(o.center), [side * o.splay, 1, -0.1], o.radius, o.tube));
    parts.push(tube(s.zygomatic.map(x), s.mandibleRadius * 0.65));
    parts.push(tube(s.mandible.map(x), s.mandibleRadius));
    // Coronoid process, rising from the back of the jaw.
    const [m0, m1] = s.mandible;
    parts.push(tube([x([m1[0], m1[1] + 0.12 * ry, m1[2]]), x([m0[0] * 1.05, m0[1] + 0.25 * ry, m0[2] + 0.05])], s.mandibleRadius * 0.7));
    // Canines, upper pointing down and lower pointing up.
    const c = s.canine;
    parts.push(cone(x(c.upper), [0, 0.1, 1], c.length * 0.22, c.length));
    const tip = s.mandible[s.mandible.length - 2];
    parts.push(cone(x([tip[0] * 0.85, tip[1] + 0.06, tip[2] - 0.02]), [0, 0.15, -1], c.length * 0.18, c.length * 0.8));
    // Cheek teeth along the upper jaw.
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const p = new Vector3(...c.upper).lerp(new Vector3(c.upper[0] * 1.7, cy * 0.15, c.upper[2] * 1.1), 0.25 + t * 0.75);
      parts.push(ellipsoid(x([p.x, p.y, p.z]), [c.length * 0.12, c.length * 0.22, c.length * 0.18], 8));
    }
  }
  return merge(parts);
}

// ---------------------------------------------------------------- spine

export type VertebraKind = 'cervical' | 'thoracic' | 'lumbar' | 'sacrum' | 'caudal';

/**
 * One vertebra from y = 0 (caudal end) to y = len (cranial end). Thoracic
 * vertebrae carry their pair of ribs and a piece of the sternum, so the rib
 * cage bends with the spine.
 */
export function vertebra(spec: SpeciesSpec, kind: VertebraKind, len: number, index: number, count: number): BufferGeometry {
  const t = count > 1 ? index / (count - 1) : 0;
  let r = spec.vertebra;
  if (kind === 'caudal') r *= 0.85 * (1 - t * 0.75);
  if (kind === 'cervical') r *= 1.05;
  const parts: BufferGeometry[] = [
    lathe([[0, 0], [len * 0.02, r * 0.9], [len * 0.15, r], [len * 0.5, r * 0.82], [len * 0.85, r], [len * 0.98, r * 0.9], [len, 0]], 10),
  ];
  const process = (height: number, lean: number, width = 0.18) =>
    parts.push(ellipsoid([0, len * (0.45 - lean), -(r + height / 2)], [r * width, len * 0.2, height / 2], 8));

  switch (kind) {
    case 'cervical': {
      process(r * (index === 0 ? 0.6 : 0.4 + t * 0.8), 0);
      const wing = index === count - 1 ? 2.4 : 1.4; // the atlas, next to the skull, has broad wings
      for (const side of [1, -1]) parts.push(ellipsoid([side * r * wing, len * 0.5, r * 0.2], [r * 0.7, len * 0.4, r * 0.3], 8));
      break;
    }
    case 'thoracic': {
      // Index 0 is the last thoracic vertebra (T13), next to the lumbar spine.
      const fromFront = count - 1 - index;
      process(r * (3.2 - fromFront * 0.16), 0.15 + fromFront * 0.01);
      ribs(parts, spec, len, r, fromFront);
      break;
    }
    case 'lumbar':
      process(r * 1.5, -0.05, 0.25);
      for (const side of [1, -1]) parts.push(ellipsoid([side * r * 2.1, len * 0.6, r * 0.1], [r * 1.3, len * 0.18, r * 0.2], 8));
      break;
    case 'sacrum':
      process(r * 1.1, 0, 0.25);
      for (const side of [1, -1]) parts.push(ellipsoid([side * r * 1.6, len * 0.7, r * 0.1], [r * 1.1, len * 0.3, r * 0.35], 10));
      break;
    case 'caudal':
      if (t < 0.4) for (const side of [1, -1]) parts.push(ellipsoid([side * r * 1.3, len * 0.5, 0], [r * 0.6, len * 0.25, r * 0.2], 6));
      break;
  }
  return merge(parts);
}

const RIB_DEPTH = [0.55, 0.66, 0.76, 0.85, 0.92, 0.97, 1, 1, 0.97, 0.9, 0.82, 0.72, 0.6];
const RIB_WIDTH = [0.55, 0.66, 0.76, 0.84, 0.9, 0.95, 1, 1, 1, 0.98, 0.95, 0.9, 0.85];

/** The pair of ribs on one thoracic vertebra; `i` counts from the front (0 = first rib). */
function ribs(parts: BufferGeometry[], spec: SpeciesSpec, len: number, r: number, i: number): void {
  const depth = spec.chestDepth * RIB_DEPTH[i];
  const w = spec.chestHalfWidth * RIB_WIDTH[i];
  const sternal = i < 9;
  const y = len * 0.5;
  const sweep = spec.chestDepth * 0.28; // ribs slope backwards as they descend
  const radius = spec.shaft * 0.42;
  for (const side of [1, -1]) {
    const end: V3 = sternal ? [side * w * 0.12, y - sweep * 0.8, depth] : [side * w * 0.6, y - sweep, depth * 0.92];
    parts.push(tube([
      [side * r * 0.9, y, -r * 0.3],
      [side * w * 0.78, y - sweep * 0.12, depth * 0.1],
      [side * w, y - sweep * 0.45, depth * 0.45],
      [side * w * 0.8, y - sweep * 0.8, depth * 0.78],
      end,
    ], radius, 5));
  }
  if (sternal) parts.push(ellipsoid([0, y - sweep * 0.8, depth + radius], [radius * 1.6, len * 0.45, radius * 1.2], 8));
}

// ---------------------------------------------------------------- limbs

export function scapula(spec: SpeciesSpec, side: Side): BufferGeometry {
  const len = spec.scapula;
  const w = spec.shaft * 2.4;
  const blade = lathe([[0, 0], [len * 0.02, w * 0.6], [len * 0.08, w * 0.62], [len * 0.18, w * 0.42], [len * 0.45, w * 1.3], [len * 0.75, w * 1.75], [len * 0.93, w * 1.5], [len, 0]], 14)
    .applyMatrix4(m.makeScale(0.16, 1, 1));
  return merge([
    blade,
    // The spine of the scapula, a ridge on its outer face ending in the acromion.
    ellipsoid([side * w * 0.2, len * 0.5, 0], [w * 0.22, len * 0.45, w * 0.12], 8),
    ring([0, 0, 0], [0, 1, 0], w * 0.45, w * 0.12),
  ]);
}

export function humerus(spec: SpeciesSpec, len = spec.humerus): BufferGeometry {
  const sh = spec.shaft;
  return merge([
    longBone(len, sh * 1.5, sh, sh * 1.4),
    ellipsoid([0, sh * 0.6, sh * 0.9], [sh * 1.5, sh * 1.5, sh * 1.5]), // head, facing back into the shoulder
    ellipsoid([0, -sh * 0.3, -sh * 1.0], [sh * 1.0, sh * 1.3, sh * 1.0]), // greater tubercle, at the point of the shoulder
    ellipsoid([sh * 0.8, len - sh * 0.6, 0], [sh * 0.9, sh * 0.9, sh * 0.9]),
    ellipsoid([-sh * 0.8, len - sh * 0.6, 0], [sh * 0.9, sh * 0.9, sh * 0.9]),
  ]);
}

export function radiusUlna(spec: SpeciesSpec, side: Side, len = spec.radius): BufferGeometry {
  const sh = spec.shaft;
  return merge([
    longBone(len, sh * 1.1, sh * 0.75, sh * 1.3).translate(0, 0, -sh * 0.45),
    longBone(len * 0.94, sh * 0.9, sh * 0.5, sh * 0.6).translate(side * sh * 0.3, 0, sh * 0.75),
    ellipsoid([0, -sh * 1.2, sh * 1.1], [sh * 0.7, sh * 1.8, sh * 0.9]), // olecranon, the point of the elbow
  ]);
}

/** Carpal or tarsal bones, then four metacarpals or metatarsals, from y = 0 to y = len. */
export function metapodium(spec: SpeciesSpec, len: number, hind: boolean): BufferGeometry {
  const sh = spec.shaft;
  const parts: BufferGeometry[] = [];
  const top = sh * (hind ? 2.6 : 2.2);
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 3; i++) {
      parts.push(ellipsoid([(i - 1) * sh * 1.1, sh * (0.7 + row * 1.0), 0], [sh * 0.65, sh * 0.55, sh * 0.8], 8));
    }
  }
  if (hind) parts.push(ellipsoid([0, -sh * 0.6, sh * 1.7], [sh * 0.7, sh * 2.1, sh * 0.85])); // calcaneus, the point of the hock
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * sh * 0.85;
    const l = (len - top) * (i === 0 || i === 3 ? 0.88 : 1);
    parts.push(longBone(l, sh * 0.45, sh * 0.3, sh * 0.42, 8).translate(x, top, 0));
  }
  return merge(parts);
}

/** Toe bones, origin at the paw keypoint, +Y forward, +Z down. */
export function paw(spec: SpeciesSpec): BufferGeometry {
  const sh = spec.shaft;
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * sh * 0.95;
    const k = i === 0 || i === 3 ? 0.85 : 1;
    const joints: V3[] = [
      [x, -sh * 1.2 * k, -sh * 1.6],
      [x * 1.12, sh * 0.6 * k, -sh * 0.2],
      [x * 1.2, sh * 2.2 * k, sh * 0.5],
      [x * 1.25, sh * 3.4 * k, sh * 1.0],
    ];
    parts.push(tube(joints, sh * 0.32, 6));
    for (const j of joints.slice(0, 3)) parts.push(ellipsoid(j, [sh * 0.42, sh * 0.42, sh * 0.42], 8));
    parts.push(cone(joints[3], [0, 1, 0.6], sh * 0.28, sh * 1.1));
  }
  return merge(parts);
}

/** One half of the pelvis, from the sacrum (y = 0) to the hip socket (y = len). */
export function pelvis(spec: SpeciesSpec, side: Side): BufferGeometry {
  const len = spec.pelvis;
  const sh = spec.shaft;
  const mid = spec.chestHalfWidth * 0.6; // hip socket to the midline
  return merge([
    ellipsoid([0, len * 0.38, -len * 0.12], [sh * 0.45, len * 0.42, len * 0.3], 14), // ilium wing
    longBone(len * 0.6, sh * 1.0, sh * 0.9, sh * 1.3).translate(0, len * 0.4, 0),
    ring([0, len, 0], [1, 0, 0], sh * 1.4, sh * 0.35), // acetabulum
    ellipsoid([-side * sh * 0.3, len * 1.08, len * 0.42], [sh * 0.45, sh * 1.2, len * 0.36], 10), // ischium
    ring([-side * mid * 0.4, len * 1.14, len * 0.22], [side * 0.5, 1, 0], len * 0.15, sh * 0.32), // obturator foramen
    tube([[0, len, sh * 0.4], [-side * mid * 0.5, len * 1.18, len * 0.12], [-side * mid, len * 1.22, len * 0.28]], sh * 0.45, 6), // pubis
  ]);
}

export function femur(spec: SpeciesSpec, side: Side, len = spec.femur): BufferGeometry {
  const sh = spec.shaft;
  return merge([
    longBone(len, sh * 1.6, sh * 1.05, sh * 1.6),
    ellipsoid([-side * sh * 1.7, sh * 0.2, 0], [sh * 1.4, sh * 1.4, sh * 1.4]), // head, into the hip socket
    tube([[-side * sh * 1.6, sh * 0.3, 0], [0, sh * 1.5, 0]], sh * 0.8, 6),
    ellipsoid([side * sh * 1.0, -sh * 0.5, sh * 0.5], [sh * 1.1, sh * 1.3, sh * 1.1]), // greater trochanter
    ellipsoid([sh * 0.9, len - sh * 0.7, sh * 0.4], [sh * 1.0, sh * 1.0, sh * 1.0]),
    ellipsoid([-sh * 0.9, len - sh * 0.7, sh * 0.4], [sh * 1.0, sh * 1.0, sh * 1.0]),
    ellipsoid([0, len - sh * 1.6, -sh * 1.5], [sh * 0.6, sh * 1.1, sh * 0.5]), // patella
  ]);
}

export function tibia(spec: SpeciesSpec, side: Side, len = spec.tibia): BufferGeometry {
  const sh = spec.shaft;
  return merge([
    longBone(len, sh * 1.9, sh * 0.9, sh * 1.2),
    ellipsoid([0, len * 0.18, -sh * 1.0], [sh * 0.5, len * 0.16, sh * 0.6]), // tibial crest
    longBone(len - sh * 1.5, sh * 0.5, sh * 0.28, sh * 0.45, 6).translate(side * sh * 1.4, sh * 0.6, sh * 0.5), // fibula
  ]);
}
