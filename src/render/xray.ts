import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector4,
  type Texture,
} from 'three';

const VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vWorld;
#ifdef BATCHED
uniform sampler2D uBones;
attribute float bone;
#endif
void main() {
#ifdef BATCHED
  int r = int(bone + 0.5);
  mat4 m = mat4(texelFetch(uBones, ivec2(0, r), 0), texelFetch(uBones, ivec2(1, r), 0),
                texelFetch(uBones, ivec2(2, r), 0), texelFetch(uBones, ivec2(3, r), 0));
  // The last element carries the bone's visibility. A hidden bone is moved
  // outside the view, so its triangles are clipped before any pixel is shaded.
  if (m[3][3] < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  m[3][3] = 1.0;
#else
  mat4 m = mat4(1.0);
#endif
  vec4 world = modelMatrix * (m * vec4(position, 1.0));
  vWorld = world.xyz;
  vNormal = mat3(modelMatrix) * mat3(m) * normal;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
uniform float uGlow;
uniform vec4 uClip;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  if (dot(uClip.xyz, vWorld) + uClip.w < 0.0) discard;
  if (uGlow < 0.5) {
    gl_FragColor = vec4(uColor, uStrength);
    return;
  }
  // The camera sits at the origin, so the view direction is -vWorld.
  float facing = abs(dot(normalize(vNormal), normalize(-vWorld)));
  float rim = pow(1.0 - facing, 1.5);
  gl_FragColor = vec4(uColor * (0.05 + 0.42 * rim) * uStrength, 1.0);
}`;

/**
 * One X-ray look shared by a set of bones. Bones are drawn three times:
 * depth only, a dark shade on the nearest surface so the bone separates from
 * skin, then an additive glow on every layer, which brightens thick and
 * edge-on bone the way a radiograph does.
 *
 * The human skeleton merges many bones into one batch, posed on the GPU from
 * a texture of bone matrices, so it takes a few draw calls instead of three
 * per bone. The pet skeletons use one mesh per bone.
 */
export class XrayStyle {
  /** Clip plane (xyz normal, w offset) in camera space; fragments behind it are dropped. */
  readonly clip = new Vector4(0, 0, 0, 1);
  private readonly bones = { value: null as Texture | null };
  private readonly strength = { value: 1 };
  private readonly passes: Partial<Record<'single' | 'batched', ShaderMaterial[]>> = {};

  constructor(
    private readonly glowStrength = 1,
    private readonly glowColor = 0xcfe9ff,
    private readonly shadeColor = 0x06102e,
    private readonly shadeOpacity = 0.5,
  ) {
    this.strength.value = glowStrength;
  }

  /** Dims the glow (1 = full), so other body systems read clearly over the bones. */
  setDim(factor: number): void {
    this.strength.value = this.glowStrength * factor;
  }

  /** Wraps a bone geometry in a group whose `matrix` the rig sets directly. */
  makeBone(geometry: BufferGeometry, name: string): Group {
    return this.wrap(geometry, this.materials('single'), name);
  }

  /**
   * Wraps merged bone geometry, whose `bone` attribute gives the row of each
   * vertex's bone in `matrices` (four RGBA float texels per row: the bone's
   * matrix, with its visibility in the last element).
   */
  makeBatch(geometry: BufferGeometry, matrices: Texture, name: string): Group {
    this.bones.value = matrices;
    return this.wrap(geometry, this.materials('batched'), name);
  }

  private wrap(geometry: BufferGeometry, materials: ShaderMaterial[], name: string): Group {
    const group = new Group();
    group.name = name;
    group.matrixAutoUpdate = false;
    materials.forEach((material, i) => {
      const pass = new Mesh(geometry, material);
      pass.renderOrder = i + 1;
      pass.frustumCulled = false;
      pass.matrixAutoUpdate = false;
      group.add(pass);
    });
    return group;
  }

  /** The depth, shade and glow materials, made on first use. */
  private materials(kind: 'single' | 'batched'): ShaderMaterial[] {
    const make = (color: number, strength: { value: number }, isGlow: boolean) =>
      new ShaderMaterial({
        defines: kind === 'batched' ? { BATCHED: '' } : {},
        uniforms: {
          uBones: this.bones,
          uColor: { value: new Color(color) },
          uStrength: strength,
          uGlow: { value: isGlow ? 1 : 0 },
          uClip: { value: this.clip },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: DoubleSide,
      });
    this.passes[kind] ??= (() => {
      const depth = make(0, { value: 0 }, false);
      depth.colorWrite = false;
      const shade = make(this.shadeColor, { value: this.shadeOpacity }, false);
      shade.transparent = true;
      shade.depthWrite = false;
      const glow = make(this.glowColor, this.strength, true);
      glow.transparent = true;
      glow.depthWrite = false;
      glow.depthTest = false;
      glow.blending = AdditiveBlending;
      return [depth, shade, glow];
    })();
    return this.passes[kind];
  }
}
