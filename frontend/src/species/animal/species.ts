import type { AnimalKind } from './AnimalTracker';

/**
 * Body proportions of one species. Lengths are in body units: 1 is the
 * distance between AP-10K's neck and tail-root keypoints. Skull dimensions are
 * in head units: 1 is the distance from between the eyes to the nose.
 *
 * AP-10K marks the joints that are visible from outside, which are lower than
 * their anatomical names suggest: its "shoulder" sits at the elbow, "elbow" at
 * the carpus, "hip" at the stifle (knee) and "knee" at the hock. The limb
 * lengths below follow that, and the hidden shoulder and hip joints are
 * placed between the body line and those points.
 */
export interface SpeciesSpec {
  kind: AnimalKind;
  /** Expected keypoint distances, used to recover scale and out-of-plane rotation. */
  radius: number; // AP shoulder -> AP elbow
  metacarpus: number; // AP elbow -> front paw
  tibia: number; // AP hip -> AP knee
  metatarsus: number; // AP knee -> back paw
  eyeToNose: number;
  eyeSpan: number;
  /** Bone lengths between estimated joints. */
  humerus: number;
  femur: number;
  scapula: number;
  pelvis: number;
  /** Shaft radius of the long bones. */
  shaft: number;
  vertebra: number;
  /** Rib cage half-width and depth (spine to sternum). */
  chestHalfWidth: number;
  chestDepth: number;
  tailLength: number;
  skull: SkullSpec;
}

/** Skull shape in head units, origin between the eyes, +X left, +Y forward, +Z down. */
export interface SkullSpec {
  cranium: { center: [number, number, number]; radii: [number, number, number] };
  /** Muzzle profile along +Y: [y, radius]. */
  muzzle: [number, number][];
  muzzleDrop: number;
  orbit: { center: [number, number, number]; radius: number; tube: number; splay: number };
  zygomatic: [number, number, number][];
  mandible: [number, number, number][];
  mandibleRadius: number;
  canine: { upper: [number, number, number]; length: number };
  /** Where the neck attaches. */
  occiput: [number, number, number];
}

export const DOG: SpeciesSpec = {
  kind: 'dog',
  radius: 0.21,
  metacarpus: 0.17,
  tibia: 0.27,
  metatarsus: 0.21,
  eyeToNose: 0.16,
  eyeSpan: 0.08,
  humerus: 0.25,
  femur: 0.26,
  scapula: 0.27,
  pelvis: 0.17,
  shaft: 0.015,
  vertebra: 0.02,
  chestHalfWidth: 0.12,
  chestDepth: 0.3,
  tailLength: 0.42,
  skull: {
    cranium: { center: [0, -0.55, 0.12], radii: [0.4, 0.62, 0.34] },
    muzzle: [[-0.05, 0.3], [0.3, 0.25], [0.7, 0.19], [0.95, 0.14], [1.02, 0.06]],
    muzzleDrop: 0.12,
    orbit: { center: [0.22, 0.02, -0.02], radius: 0.15, tube: 0.022, splay: 0.6 },
    zygomatic: [[0.28, 0.15, 0.14], [0.42, -0.15, 0.2], [0.35, -0.45, 0.24]],
    mandible: [[0.3, -0.55, 0.12], [0.3, -0.45, 0.38], [0.22, 0.0, 0.37], [0.12, 0.6, 0.35], [0.04, 0.98, 0.29]],
    mandibleRadius: 0.045,
    canine: { upper: [0.1, 0.86, 0.2], length: 0.16 },
    occiput: [0, -1.12, 0.3],
  },
};

export const CAT: SpeciesSpec = {
  kind: 'cat',
  radius: 0.2,
  metacarpus: 0.16,
  tibia: 0.27,
  metatarsus: 0.2,
  eyeToNose: 0.11,
  eyeSpan: 0.1,
  humerus: 0.24,
  femur: 0.28,
  scapula: 0.24,
  pelvis: 0.16,
  shaft: 0.013,
  vertebra: 0.019,
  chestHalfWidth: 0.11,
  chestDepth: 0.3,
  tailLength: 0.55,
  skull: {
    cranium: { center: [0, -0.75, -0.1], radii: [0.72, 0.95, 0.68] },
    muzzle: [[-0.1, 0.52], [0.3, 0.44], [0.7, 0.32], [0.95, 0.2], [1.0, 0.1]],
    muzzleDrop: 0.25,
    orbit: { center: [0.42, 0.05, -0.05], radius: 0.36, tube: 0.04, splay: 0.45 },
    zygomatic: [[0.5, 0.25, 0.3], [0.8, -0.2, 0.3], [0.65, -0.75, 0.25]],
    mandible: [[0.58, -0.9, 0.1], [0.6, -0.7, 0.6], [0.4, 0.0, 0.75], [0.22, 0.6, 0.74], [0.1, 0.88, 0.68]],
    mandibleRadius: 0.07,
    canine: { upper: [0.22, 0.78, 0.5], length: 0.3 },
    occiput: [0, -1.75, 0.15],
  },
};
