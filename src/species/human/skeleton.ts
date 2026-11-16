import { Group, Mesh, Vector3 } from 'three';
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
  /** Set `node.matrix` to pose the bone; geometry stays in rest coordinates. */
  node: Group;
}

export interface Skeleton {
  bones: Map<string, Bone>;
  skull: { fit: number[]; jawHinge: [number[], number[]]; midX: number };
  root: Group;
}

type Raw = { name: string; group: string; side: '' | 'L' | 'R'; a: number[]; b: number[]; c: number[]; anchor: number[] };

/** Loads the bone meshes and rest-pose manifest. `styleFor` picks the look per bone. */
export async function loadSkeleton(base: string, styleFor: (group: string) => XrayStyle): Promise<Skeleton> {
  const [gltf, manifest] = await Promise.all([
    new GLTFLoader().loadAsync(`${base}human.glb`),
    fetch(`${base}human.json`).then((r) => r.json()),
  ]);
  const root = new Group();
  const bones = new Map<string, Bone>();
  const v = (p: number[]) => new Vector3(p[0], p[1], p[2]);
  gltf.scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const key = mesh.name || mesh.parent?.name || '';
    const raw = manifest.bones[key] as Raw | undefined;
    if (!raw) return;
    mesh.geometry.computeVertexNormals();
    const node = styleFor(raw.group).makeBone(mesh.geometry, key);
    node.visible = false;
    root.add(node);
    bones.set(key, {
      key,
      node,
      info: { name: raw.name, group: raw.group, side: raw.side, a: v(raw.a), b: v(raw.b), c: v(raw.c), anchor: v(raw.anchor) },
    });
  });
  return { bones, skull: manifest.skull, root };
}
