import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { FOV_DEG } from '../core/math';
import type { FrameSource } from '../core/source';

/**
 * The 3D scene. The canvas always has the aspect ratio of the video and is
 * scaled with CSS to cover the viewport, so camera space lines up with the
 * video pixel for pixel.
 */
export class Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV_DEG, 16 / 9, 1, 5000);
  readonly renderer: WebGLRenderer;
  aspect = 16 / 9;
  mirror = false;
  private source: FrameSource | null = null;
  private readonly tmp = new Vector3();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x05070c);
    this.camera.matrixAutoUpdate = false;
  }

  setSource(source: FrameSource): void {
    this.source = source;
    this.scene.background = source.texture;
    this.mirror = source.mirror;
    this.layout();
  }

  /** True when the frame size changed (a phone was rotated) since the last layout. */
  needsLayout(): boolean {
    const s = this.source;
    return !!s && s.width > 0 && s.height > 0 && Math.abs(s.width / s.height - this.aspect) > 1e-3;
  }

  /** Fits the canvas over the viewport ("cover") and picks a render resolution. */
  layout(): void {
    const source = this.source;
    if (source && source.width > 0 && source.height > 0) {
      this.aspect = source.width / source.height;
      this.camera.aspect = this.aspect;
      this.camera.updateProjectionMatrix();
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Cover the viewport for a live camera; show the whole frame for a file.
    const cover = source?.live ?? true;
    const wide = vw / vh > this.aspect;
    const w = wide === cover ? vw : vh * this.aspect;
    const h = wide === cover ? vw / this.aspect : vh;
    const style = this.canvas.style;
    style.width = `${w}px`;
    style.height = `${h}px`;
    style.left = `${(vw - w) / 2}px`;
    style.top = `${(vh - h) / 2}px`;
    style.transform = this.mirror ? 'scaleX(-1)' : '';
    const dpr = Math.min(window.devicePixelRatio, 2);
    const maxH = source ? Math.max(source.height, 720) : 720;
    const rh = Math.min(h * dpr, maxH * 1.5);
    this.renderer.setSize(Math.round(rh * this.aspect), Math.round(rh), false);
  }

  /** Projects a camera-space point to viewport pixels, honouring mirroring. */
  toScreen(p: Vector3, out: { x: number; y: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    this.tmp.copy(p).project(this.camera);
    let u = (this.tmp.x + 1) / 2;
    if (this.mirror) u = 1 - u;
    out.x = rect.left + u * rect.width;
    out.y = rect.top + ((1 - this.tmp.y) / 2) * rect.height;
    return out;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
