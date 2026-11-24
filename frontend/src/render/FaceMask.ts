import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  ShaderMaterial,
  Vector4,
} from 'three';
import type { Point2 } from '../core/math';

/** MediaPipe face landmarks around the edge of the face, in loop order. */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

const N = FACE_OVAL.length;
const INNER = 0.82; // the tint is solid inside this fraction of the oval and fades out to the edge

/**
 * A dark tint over the face so the skull reads as being inside the head.
 * Drawn directly in NDC, between the video and the bones.
 */
export class FaceMask {
  readonly mesh: Mesh;
  /** 2D half-plane (a, b, c): fragments with a*x + b*y + c < 0 are dropped. */
  readonly clip = new Vector4(0, 0, 1, 0);
  private readonly positions = new Float32Array((2 * N + 1) * 3);

  constructor(color = 0x030a1f, opacity = 0.62) {
    const alpha = new Float32Array(2 * N + 1);
    alpha.fill(1, N); // outer ring 0, inner ring and centre 1
    const index: number[] = [];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      index.push(i, j, N + i, j, N + j, N + i); // fading band
      index.push(N + i, N + j, 2 * N); // solid centre fan
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    geometry.setAttribute('alpha', new BufferAttribute(alpha, 1));
    geometry.setIndex(index);
    const material = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color(color) },
        uOpacity: { value: opacity },
        uClip: { value: this.clip },
      },
      vertexShader: /* glsl */ `
        attribute float alpha;
        varying float vAlpha;
        varying vec2 vNdc;
        void main() {
          vAlpha = alpha;
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform vec4 uClip;
        varying float vAlpha;
        varying vec2 vNdc;
        void main() {
          float side = dot(uClip.xy, vNdc) + uClip.z;
          if (side < 0.0) discard;
          gl_FragColor = vec4(uColor, uOpacity * smoothstep(0.0, 1.0, vAlpha));
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    this.mesh.visible = false;
  }

  /** Updates the outline from face landmarks already converted to NDC. */
  update(ndc: Point2[]): void {
    let cx = 0;
    let cy = 0;
    for (const i of FACE_OVAL) {
      cx += ndc[i].x / N;
      cy += ndc[i].y / N;
    }
    const p = this.positions;
    for (let k = 0; k < N; k++) {
      const { x, y } = ndc[FACE_OVAL[k]];
      p[k * 3] = x;
      p[k * 3 + 1] = y;
      p[(N + k) * 3] = cx + (x - cx) * INNER;
      p[(N + k) * 3 + 1] = cy + (y - cy) * INNER;
    }
    p[2 * N * 3] = cx;
    p[2 * N * 3 + 1] = cy;
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }
}
