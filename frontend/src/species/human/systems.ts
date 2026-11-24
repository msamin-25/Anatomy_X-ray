import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FloatType,
  Group,
  Mesh,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
  type Vector4,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LabelAnchor } from '../types';
import type { Bone, Skeleton } from './skeleton';

export type Layer = 'bones' | 'nerves' | 'blood';
export type Layers = Record<Layer, boolean>;

type GroupName = 'heart' | 'artery' | 'vein' | 'partery' | 'pvein' | 'lung' | 'cortex' | 'brain' | 'csf' | 'nerve';

const MODE = { artery: 0, vein: 1, nerve: 2, heart: 3, brain: 4, lung: 5 } as const;

/** How each part of the systems is drawn. Pulmonary arteries carry blue (oxygen-poor) blood, pulmonary veins red. */
const LOOKS: Record<GroupName, { layer: Layer; color: number; mode: number; strength: number }> = {
  lung: { layer: 'blood', color: 0x7dd3fc, mode: MODE.lung, strength: 0.3 },
  heart: { layer: 'blood', color: 0xff4d5e, mode: MODE.heart, strength: 1.15 },
  partery: { layer: 'blood', color: 0x4f86ff, mode: MODE.artery, strength: 0.75 },
  pvein: { layer: 'blood', color: 0xff4d5e, mode: MODE.vein, strength: 0.75 },
  artery: { layer: 'blood', color: 0xff3347, mode: MODE.artery, strength: 1 },
  vein: { layer: 'blood', color: 0x3b7bff, mode: MODE.vein, strength: 1 },
  cortex: { layer: 'nerves', color: 0xf5a3e6, mode: MODE.brain, strength: 0.75 },
  brain: { layer: 'nerves', color: 0xf5a3e6, mode: MODE.brain, strength: 0.4 },
  csf: { layer: 'nerves', color: 0x67e8f9, mode: MODE.brain, strength: 0.4 },
  nerve: { layer: 'nerves', color: 0xfacc15, mode: MODE.nerve, strength: 0.8 },
};
const ORDER: GroupName[] = ['lung', 'heart', 'partery', 'pvein', 'vein', 'artery', 'csf', 'brain', 'cortex', 'nerve'];

/** Colours for the on-screen legend and label markers. */
export const SYSTEM_COLORS = {
  artery: '#ff4d5e',
  vein: '#4f86ff',
  nerve: '#facc15',
  brain: '#f5a3e6',
};

/** The names kept on small screens, where every label would not fit. */
const KEY_LABELS = new Set([
  'Heart', 'Aorta', 'Pulmonary artery', 'Carotid artery', 'Jugular vein', 'Femoral artery', 'Great saphenous vein',
  'Brain', 'Spinal cord', 'Brachial plexus', 'Sciatic nerve', 'Median nerve',
]);

/** Resting heart rate of the animation, beats per minute. */
const BPM = 68;
const BREATHS = 14;

interface PathData {
  g: GroupName;
  /** Brightness of a minor vessel or nerve (default 1). */
  k?: number;
  /** Centre line, xyz per sample, rest pose (cm). */
  p: number[];
  r: number[];
  /** Per sample: first segment, second segment, weight of the first. */
  s: number[];
  /** Per sample: distance along the network from the heart or brain (cm). */
  d: number[];
}

interface LabelData {
  t: string;
  g: GroupName;
  l: Layer;
  e: string;
  p: number[];
  s: [number, number, number];
}

interface Manifest {
  segments: string[];
  heart: number[];
  lungs: number[];
  paths: PathData[];
  labels: LabelData[];
}

const VERT = /* glsl */ `
uniform sampler2D uBones;
uniform float uBeat;
uniform float uBreath;
uniform vec3 uHeart;
uniform vec3 uLungs;
uniform float uMode;
uniform float uHeadA;
uniform float uHeadB;
uniform float uPixel;
uniform float uMinPx;
attribute vec2 segs;
attribute float weight;
attribute float flow;
attribute vec3 center;
attribute float tone;
varying float vTone;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vRest;
varying float vFlow;
varying float vHide;
varying float vHead;

mat4 bone(float i) {
  int r = int(i + 0.5);
  return mat4(texelFetch(uBones, ivec2(0, r), 0), texelFetch(uBones, ivec2(1, r), 0),
              texelFetch(uBones, ivec2(2, r), 0), texelFetch(uBones, ivec2(3, r), 0));
}

vec3 deform(vec3 p) {
  // Heartbeat: the heart and the roots of its vessels squeeze toward its centre.
  float h = smoothstep(7.5, 3.5, distance(p, uHeart));
  p = uHeart + (p - uHeart) * (1.0 - 0.06 * uBeat * h);
  if (uMode > 4.5) p = uLungs + (p - uLungs) * (1.0 + 0.035 * uBreath);
  return p;
}

bool isHead(float s) {
  return abs(s - uHeadA) < 0.5 || abs(s - uHeadB) < 0.5;
}

void main() {
  vec3 p = deform(position);
  vec3 c = deform(center);
  mat4 A = bone(segs.x);
  mat4 B = bone(segs.y);
  // The last element of each matrix carries the bone's visibility.
  float visA = A[3][3];
  float visB = B[3][3];
  A[3][3] = 1.0;
  B[3][3] = 1.0;
  vHide = ((weight > 0.02 && visA < 0.5) || (weight < 0.98 && visB < 0.5)) ? 1.0 : 0.0;
  vec3 P = mix((B * vec4(p, 1.0)).xyz, (A * vec4(p, 1.0)).xyz, weight);
  vec3 C = mix((B * vec4(c, 1.0)).xyz, (A * vec4(c, 1.0)).xyz, weight);
  // Thin vessels and nerves keep a minimum width on screen.
  vec3 off = P - C;
  float r = length(off);
  if (r > 1e-4) {
    float px = r * uPixel / max(-C.z, 1.0);
    if (px < uMinPx) P = C + off * (uMinPx / px);
  }
  vNormal = mix(mat3(B) * normal, mat3(A) * normal, weight);
  vView = P;
  vRest = position;
  vFlow = flow;
  vTone = tone;
  vHead = (isHead(segs.x) ? weight : 0.0) + (isHead(segs.y) ? 1.0 - weight : 0.0);
  gl_Position = projectionMatrix * vec4(P, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uMode;
uniform float uStrength;
uniform float uTime;
uniform float uPeriod;
uniform float uBeat;
uniform vec4 uClip;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vRest;
varying float vFlow;
varying float vHide;
varying float vHead;
varying float vTone;

void main() {
  if (vHide > 0.001) discard;
  if (vHead > 0.5 && dot(uClip.xyz, vView) + uClip.w < 0.0) discard;
  float facing = abs(dot(normalize(vNormal), normalize(-vView)));
  float rim = pow(1.0 - facing, 1.5);
  float glow;
  if (uMode < 0.5) {
    // Arteries: a pressure wave leaves the heart with each beat, over a steady stream.
    float wave = fract(uTime / uPeriod - vFlow / 46.0);
    float pulse = exp(-pow((wave - 0.5) / 0.045, 2.0));
    float stream = smoothstep(0.6, 1.0, 0.5 + 0.5 * sin((vFlow - uTime * 28.0) * 0.7));
    glow = 0.42 + 0.4 * rim + 0.22 * stream + 1.3 * pulse;
  } else if (uMode < 1.5) {
    // Veins: slower, steady flow back toward the heart.
    float s = fract((vFlow + uTime * 11.0) / 6.0);
    float dash = smoothstep(0.0, 0.3, s) * smoothstep(0.75, 0.35, s);
    glow = 0.38 + 0.4 * rim + 0.5 * dash;
  } else if (uMode < 2.5) {
    // Nerves: quick signals running out from the brain and spinal cord.
    float s = fract((vFlow - uTime * 70.0) / 40.0);
    float spark = exp(-pow(s / 0.035, 2.0)) + exp(-pow((1.0 - s) / 0.035, 2.0));
    glow = 0.36 + 0.35 * rim + 1.6 * spark;
  } else if (uMode < 3.5) {
    glow = (0.1 + 0.8 * rim) * (0.8 + 0.7 * uBeat);
  } else if (uMode < 4.5) {
    // Brain: soft patches of activity drifting over the surface.
    float n = sin(vRest.x * 2.3 + uTime * 1.7) * sin(vRest.y * 2.1 - uTime * 1.3) * sin(vRest.z * 2.6 + uTime * 1.1);
    glow = 0.05 + 0.6 * rim + 0.35 * smoothstep(0.25, 0.85, n);
  } else {
    glow = 0.02 + 0.42 * rim;
  }
  gl_FragColor = vec4(uColor * glow * uStrength * vTone, 1.0);
}`;

/**
 * The heart, vessels, nerves, brain and lungs, posed by the same skeleton
 * segments as the bones. Each vertex follows up to two segments; the bone
 * matrices go to the GPU in a small float texture every frame.
 */
export class Systems {
  readonly root = new Group();
  private readonly bones: (Bone | undefined)[];
  private readonly data: Float32Array;
  private readonly texture: DataTexture;
  private readonly parts: { mesh: Mesh; layer: Layer }[] = [];
  private readonly shared;
  private readonly labels: {
    anchor: LabelAnchor; layer: Layer; rest: Vector3; i0: number; i1: number; w: number; head: boolean; key: boolean;
  }[] = [];
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  constructor(skeleton: Skeleton, manifest: Manifest, meshes: Map<string, BufferGeometry>, clip: Vector4) {
    const n = manifest.segments.length;
    this.bones = manifest.segments.map((key) => skeleton.bones.get(key));
    this.data = new Float32Array(n * 16);
    this.texture = new DataTexture(this.data, 4, n, RGBAFormat, FloatType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    const v3 = (p: number[]) => new Vector3(p[0], p[1], p[2]);
    this.shared = {
      uBones: { value: this.texture },
      uTime: { value: 0 },
      uPeriod: { value: 60 / BPM },
      uBeat: { value: 0 },
      uBreath: { value: 0 },
      uHeart: { value: v3(manifest.heart) },
      uLungs: { value: v3(manifest.lungs) },
      uHeadA: { value: manifest.segments.indexOf('frontal') },
      uHeadB: { value: manifest.segments.indexOf('mandible') },
      uPixel: { value: 600 },
      uMinPx: { value: 1.6 },
      uClip: { value: clip },
    };

    const tubes = new Map<GroupName, PathData[]>();
    for (const p of manifest.paths) {
      if (!tubes.has(p.g)) tubes.set(p.g, []);
      tubes.get(p.g)!.push(p);
    }
    ORDER.forEach((group, i) => {
      const pieces: BufferGeometry[] = [];
      const mesh = meshes.get(group);
      if (mesh) pieces.push(prepareMesh(mesh));
      const paths = tubes.get(group);
      if (paths) pieces.push(buildTubes(paths));
      if (!pieces.length) return;
      const geometry = pieces.length > 1 ? mergeGeometries(pieces)! : pieces[0];
      const look = LOOKS[group];
      const material = new ShaderMaterial({
        uniforms: {
          ...this.shared,
          uColor: { value: new Color(look.color) },
          uMode: { value: look.mode },
          uStrength: { value: look.strength },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: DoubleSide,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const m = new Mesh(geometry, material);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = 10 + i;
      m.visible = false;
      this.root.add(m);
      this.parts.push({ mesh: m, layer: look.layer });
    });

    for (const l of manifest.labels) {
      const color = l.g === 'vein' || l.g === 'partery' ? SYSTEM_COLORS.vein
        : l.g === 'nerve' ? SYSTEM_COLORS.nerve
          : l.g === 'brain' || l.g === 'csf' || l.g === 'cortex' ? SYSTEM_COLORS.brain : SYSTEM_COLORS.artery;
      const [i0, i1, w] = l.s;
      const head = this.isHead(manifest, i0) || this.isHead(manifest, i1);
      this.labels.push({
        anchor: { text: l.t, pos: new Vector3(), entity: l.e, color },
        layer: l.l, rest: v3(l.p), i0, i1, w, head, key: KEY_LABELS.has(l.t),
      });
    }
  }

  private isHead(manifest: Manifest, i: number): boolean {
    return manifest.segments[i] === 'frontal' || manifest.segments[i] === 'mandible';
  }

  hide(): void {
    for (const p of this.parts) p.mesh.visible = false;
  }

  /**
   * Poses and animates the systems.
   * @param time seconds
   * @param pixel focal length of the camera in render pixels, for the minimum line width
   */
  update(time: number, layers: Layers, pixel: number, labels: boolean): LabelAnchor[] {
    let any = false;
    for (const p of this.parts) {
      p.mesh.visible = layers[p.layer];
      any ||= p.mesh.visible;
    }
    if (!any) return [];

    const data = this.data;
    this.bones.forEach((bone, i) => {
      const o = i * 16;
      if (!bone) {
        data[o + 15] = 0;
        return;
      }
      data.set(bone.node.matrix.elements, o);
      data[o + 15] = bone.node.visible ? 1 : 0;
    });
    this.texture.needsUpdate = true;

    const u = this.shared;
    const period = 60 / BPM;
    const phase = (time / period) % 1;
    // Ventricles contract just before the pressure wave leaves the heart (phase 0.5); the atria a little earlier.
    u.uBeat.value = Math.exp(-(((phase - 0.45) / 0.09) ** 2)) + 0.35 * Math.exp(-(((phase - 0.22) / 0.06) ** 2));
    u.uBreath.value = 0.5 - 0.5 * Math.cos((time * 2 * Math.PI * BREATHS) / 60);
    u.uTime.value = time;
    u.uPixel.value = pixel;

    const out: LabelAnchor[] = [];
    if (!labels) return out;
    const clip = u.uClip.value;
    const compact = window.innerWidth < 700;
    for (const l of this.labels) {
      if (!layers[l.layer] || (compact && !l.key)) continue;
      const A = this.bones[l.i0];
      const B = this.bones[l.i1];
      if (!A?.node.visible || (l.w < 0.98 && !B?.node.visible)) continue;
      this.a.copy(l.rest).applyMatrix4(A.node.matrix);
      this.b.copy(l.rest).applyMatrix4(B!.node.matrix);
      l.anchor.pos.lerpVectors(this.b, this.a, l.w);
      if (l.head && clip.x * l.anchor.pos.x + clip.y * l.anchor.pos.y + clip.z * l.anchor.pos.z + clip.w < 0) continue;
      out.push(l.anchor);
    }
    return out;
  }
}

/** Gives a mesh from the GLB the attributes the shader expects. */
function prepareMesh(src: BufferGeometry): BufferGeometry {
  const g = new BufferGeometry();
  const position = src.getAttribute('position');
  g.setAttribute('position', position);
  g.setIndex(src.getIndex());
  g.computeVertexNormals();
  g.setAttribute('center', new BufferAttribute(new Float32Array(position.array as ArrayLike<number>), 3));
  g.setAttribute('segs', src.getAttribute('_segs'));
  g.setAttribute('weight', src.getAttribute('_weight'));
  g.setAttribute('flow', src.getAttribute('_flow'));
  g.setAttribute('tone', new BufferAttribute(new Float32Array(position.count).fill(1), 1));
  return g;
}

/** Turns centre lines into tubes (with a closed tip), keeping their bindings and flow distances. */
function buildTubes(paths: PathData[]): BufferGeometry {
  const sidesOf = (p: PathData) => (p.r[0] >= 0.3 ? 8 : 6);
  let nv = 0;
  let ni = 0;
  for (const p of paths) {
    const n = p.r.length;
    const sides = sidesOf(p);
    nv += (n + 1) * sides;
    ni += n * sides * 6;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const cen = new Float32Array(nv * 3);
  const seg = new Float32Array(nv * 2);
  const wt = new Float32Array(nv);
  const fl = new Float32Array(nv);
  const tn = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  const T = new Vector3();
  const N = new Vector3();
  const Bn = new Vector3();
  const P = new Vector3();
  const tmp = new Vector3();
  let v = 0;
  let k = 0;
  for (const path of paths) {
    const n = path.r.length;
    const sides = sidesOf(path);
    const at = (i: number, out: Vector3) => out.set(path.p[i * 3], path.p[i * 3 + 1], path.p[i * 3 + 2]);
    const base = v;
    for (let i = 0; i <= n; i++) {
      const j = Math.min(i, n - 1);
      at(Math.min(j + 1, n - 1), T).sub(at(Math.max(j - 1, 0), tmp));
      if (T.lengthSq() < 1e-10) T.set(0, 1, 0);
      T.normalize();
      if (i === 0) {
        N.set(Math.abs(T.y) < 0.9 ? 0 : 1, Math.abs(T.y) < 0.9 ? 1 : 0, 0).cross(T).normalize();
      } else if (i < n) {
        // Parallel transport: keep the previous normal, minus its component along the new tangent.
        N.addScaledVector(T, -N.dot(T));
        if (N.lengthSq() < 1e-8) N.set(Math.abs(T.y) < 0.9 ? 0 : 1, Math.abs(T.y) < 0.9 ? 1 : 0, 0).cross(T);
        N.normalize();
      }
      Bn.crossVectors(T, N);
      at(j, P);
      const r = i < n ? path.r[j] : 0;
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const nx = N.x * c + Bn.x * sn;
        const ny = N.y * c + Bn.y * sn;
        const nz = N.z * c + Bn.z * sn;
        pos[v * 3] = P.x + nx * r;
        pos[v * 3 + 1] = P.y + ny * r;
        pos[v * 3 + 2] = P.z + nz * r;
        nor[v * 3] = nx;
        nor[v * 3 + 1] = ny;
        nor[v * 3 + 2] = nz;
        cen[v * 3] = P.x;
        cen[v * 3 + 1] = P.y;
        cen[v * 3 + 2] = P.z;
        seg[v * 2] = path.s[j * 3];
        seg[v * 2 + 1] = path.s[j * 3 + 1];
        wt[v] = path.s[j * 3 + 2];
        fl[v] = path.d[j];
        tn[v] = path.k ?? 1;
        v++;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < sides; s++) {
        const a = base + i * sides + s;
        const b = base + i * sides + ((s + 1) % sides);
        const c = a + sides;
        const d = b + sides;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('center', new BufferAttribute(cen, 3));
  g.setAttribute('segs', new BufferAttribute(seg, 2));
  g.setAttribute('weight', new BufferAttribute(wt, 1));
  g.setAttribute('flow', new BufferAttribute(fl, 1));
  g.setAttribute('tone', new BufferAttribute(tn, 1));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

/** Loads the systems model (2–3 MB); call when a layer that needs it is first switched on. */
export async function loadSystems(base: string, skeleton: Skeleton, clip: Vector4): Promise<Systems> {
  const [gltf, manifest] = await Promise.all([
    new GLTFLoader().loadAsync(`${base}systems.glb`),
    fetch(`${base}systems.json`).then((r) => {
      if (!r.ok) throw new Error(`systems.json: ${r.status}`);
      return r.json() as Promise<Manifest>;
    }),
  ]);
  const meshes = new Map<string, BufferGeometry>();
  gltf.scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (mesh.isMesh) meshes.set(mesh.name || mesh.parent?.name || '', mesh.geometry);
  });
  return new Systems(skeleton, manifest, meshes, clip);
}
