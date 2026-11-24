import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { XrayStyle } from '../../render/xray';

export interface BoneInfo {
  name: string;
  group: string;
  side: '' | 'L' | 'R';
  /** Principal-axis end points in the rest pose, higher end first. */
  a: Vector3;
  b: Vector3;
  c: Vector3;
  anchor: Vector3;
}

export interface Bone {
  key: string;
  info: BoneInfo;
  /** Set `node.matrix` and `node.visible` to pose the bone; geometry stays in rest coordinates. */
  node: Group;
}

export interface Skeleton {
  bones: Map<string, Bone>;
  skull: { fit: number[]; jawHinge: [number[], number[]]; midX: number };
  /** Rest-pose body joints, e.g. `shoulder_L`. */
  joints: Record<string, number[]>;
  root: Group;
  /** Sends the bones' current matrices and visibility to the GPU; call before each render. */
  sync(): void;
}

type Raw = { name: string; group: string; side: '' | 'L' | 'R'; a: number[]; b: number[]; c: number[]; anchor: number[] };

/** Bones that the rigs show and hide together share one batch (one draw call per pass). */
function regionOf(raw: Raw): string {
  switch (raw.group) {
    case 'cranium':
    case 'jaw':
      return 'skull';
    case 'hand':
    case 'foot':
      return `${raw.group}_${raw.side}`;
    case 'arm':
    case 'forearm':
      return `arm_${raw.side}`;
    case 'thigh':
    case 'shin':
      return `leg_${raw.side}`;
    default:
      return 'trunk';
  }
}

/** Loads the bone meshes and rest-pose manifest. `styleFor` picks the look per bone. */
export async function loadSkeleton(base: string, styleFor: (group: string) => XrayStyle): Promise<Skeleton> {
  const [gltf, manifest] = await Promise.all([
    new GLTFLoader().loadAsync(`${base}human.glb`),
    fetch(`${base}human.json`).then((r) => r.json()),
  ]);
  const root = new Group();
  const bones = new Map<string, Bone>();
  /** Every bone, in the order of the rows of the matrix texture. */
  const rows: Bone[] = [];
  const styles: XrayStyle[] = [];
  const batches = new Map<string, { style: XrayStyle; parts: { geometry: BufferGeometry; row: number }[]; bones: Bone[] }>();
  const v = (p: number[]) => new Vector3(p[0], p[1], p[2]);
  gltf.scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const key = mesh.name || mesh.parent?.name || '';
    const raw = manifest.bones[key] as Raw | undefined;
    if (!raw) return;
    const node = new Group();
    node.name = key;
    node.matrixAutoUpdate = false;
    node.visible = false;
    const bone: Bone = {
      key,
      node,
      info: { name: raw.name, group: raw.group, side: raw.side, a: v(raw.a), b: v(raw.b), c: v(raw.c), anchor: v(raw.anchor) },
    };
    bones.set(key, bone);
    const style = styleFor(raw.group);
    if (!styles.includes(style)) styles.push(style);
    const id = `${regionOf(raw)}:${styles.indexOf(style)}`;
    if (!batches.has(id)) batches.set(id, { style, parts: [], bones: [] });
    const batch = batches.get(id)!;
    batch.parts.push({ geometry: mesh.geometry, row: rows.length });
    batch.bones.push(bone);
    rows.push(bone);
  });

  const data = new Float32Array(rows.length * 16);
  const matrices = new DataTexture(data, 4, rows.length, RGBAFormat, FloatType);
  matrices.magFilter = NearestFilter;
  matrices.minFilter = NearestFilter;
  const groups = [...batches].map(([id, batch]) => {
    const group = batch.style.makeBatch(mergeBones(batch.parts), matrices, id);
    group.visible = false;
    root.add(group);
    return { group, bones: batch.bones };
  });

  const sync = () => {
    if (!root.visible) return;
    // A batch with no bone in view is skipped entirely.
    for (const g of groups) g.group.visible = g.bones.some((bone) => bone.node.visible);
    for (let i = 0; i < rows.length; i++) {
      const node = rows[i].node;
      data.set(node.matrix.elements, i * 16);
      // Bone matrices are affine, so the last element is free to carry visibility.
      data[i * 16 + 15] = node.visible ? 1 : 0;
    }
    matrices.needsUpdate = true;
  };
  return { bones, skull: manifest.skull, joints: manifest.joints, root, sync };
}

/** Merges bone meshes into one geometry, tagging each vertex with its bone's row in the matrix texture. */
function mergeBones(parts: { geometry: BufferGeometry; row: number }[]): BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const { geometry } of parts) {
    const count = geometry.getAttribute('position').count;
    nv += count;
    ni += geometry.getIndex()?.count ?? count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const row = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  let v = 0;
  let k = 0;
  for (const { geometry, row: r } of parts) {
    geometry.computeVertexNormals();
    const p = geometry.getAttribute('position');
    const n = geometry.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      const o = (v + i) * 3;
      pos[o] = p.getX(i);
      pos[o + 1] = p.getY(i);
      pos[o + 2] = p.getZ(i);
      nor[o] = n.getX(i);
      nor[o + 1] = n.getY(i);
      nor[o + 2] = n.getZ(i);
      row[v + i] = r;
    }
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) idx[k++] = v + index.getX(i);
    else for (let i = 0; i < p.count; i++) idx[k++] = v + i;
    v += p.count;
    geometry.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(pos, 3));
  merged.setAttribute('normal', new BufferAttribute(nor, 3));
  merged.setAttribute('bone', new BufferAttribute(row, 1));
  merged.setIndex(new BufferAttribute(idx, 1));
  return merged;
}
