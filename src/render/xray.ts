import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector4,
} from 'three';

const VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(modelMatrix) * normal;
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
 * One X-ray look shared by a set of bones. Each bone is drawn three times:
 * depth only, a dark shade on the nearest surface so the bone separates from
 * skin, then an additive glow on every layer, which brightens thick and
 * edge-on bone the way a radiograph does.
 */
export class XrayStyle {
  /** Clip plane (xyz normal, w offset) in camera space; fragments behind it are dropped. */
  readonly clip = new Vector4(0, 0, 0, 1);
  private readonly depth: ShaderMaterial;
  private readonly shade: ShaderMaterial;
  private readonly glow: ShaderMaterial;
  private readonly glowStrength: number;

  constructor(glowStrength = 1, glow = 0xcfe9ff, shade = 0x06102e, shadeOpacity = 0.5) {
    this.glowStrength = glowStrength;
    const make = (color: number, strength: number, isGlow: boolean) =>
      new ShaderMaterial({
        uniforms: {
          uColor: { value: new Color(color) },
          uStrength: { value: strength },
          uGlow: { value: isGlow ? 1 : 0 },
          uClip: { value: this.clip },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: DoubleSide,
      });
    this.depth = make(0, 0, false);
    this.depth.colorWrite = false;
    this.shade = make(shade, shadeOpacity, false);
    this.shade.transparent = true;
    this.shade.depthWrite = false;
    this.glow = make(glow, glowStrength, true);
    this.glow.transparent = true;
    this.glow.depthWrite = false;
    this.glow.depthTest = false;
    this.glow.blending = AdditiveBlending;
  }

  /** Dims the glow (1 = full), so other body systems read clearly over the bones. */
  setDim(factor: number): void {
    this.glow.uniforms.uStrength.value = this.glowStrength * factor;
  }

  /** Wraps a bone geometry in a group whose `matrix` the rig sets directly. */
  makeBone(geometry: BufferGeometry, name: string): Group {
    const bone = new Group();
    bone.name = name;
    bone.matrixAutoUpdate = false;
    [this.depth, this.shade, this.glow].forEach((material, i) => {
      const pass = new Mesh(geometry, material);
      pass.renderOrder = i + 1;
      pass.frustumCulled = false;
      pass.matrixAutoUpdate = false;
      bone.add(pass);
    });
    return bone;
  }
}
