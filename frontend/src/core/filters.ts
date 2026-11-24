import { Quaternion, Vector3 } from 'three';

/**
 * One Euro filter: a low-pass filter whose cutoff rises with speed, so slow
 * movement is steady and fast movement is not delayed.
 */
export class OneEuro {
  private x = 0;
  private dx = 0;
  private started = false;

  constructor(private minCutoff = 1.5, private beta = 0.05, private dCutoff = 1) {}

  reset(): void {
    this.started = false;
  }

  filter(value: number, dt: number): number {
    if (!this.started || dt <= 0) {
      this.started = true;
      this.x = value;
      this.dx = 0;
      return value;
    }
    const dx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** Smooths a fixed-size list of points in place. */
export class PointSmoother {
  private filters: OneEuro[] = [];

  constructor(count: number, minCutoff = 1.5, beta = 0.05) {
    for (let i = 0; i < count * 3; i++) this.filters.push(new OneEuro(minCutoff, beta));
  }

  reset(): void {
    for (const f of this.filters) f.reset();
  }

  apply(points: Vector3[], dt: number): void {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      p.x = this.filters[i * 3].filter(p.x, dt);
      p.y = this.filters[i * 3 + 1].filter(p.y, dt);
      p.z = this.filters[i * 3 + 2].filter(p.z, dt);
    }
  }
}

/** Smooths a rotation: follows fast turns quickly and damps small jitter. */
export class RotationSmoother {
  private q = new Quaternion();
  private started = false;

  reset(): void {
    this.started = false;
  }

  apply(target: Quaternion, dt: number): Quaternion {
    if (!this.started) {
      this.started = true;
      this.q.copy(target);
      return target;
    }
    const speed = this.q.angleTo(target) / Math.max(dt, 1e-3); // rad/s
    const t = alpha(1.5 + 4 * speed, dt);
    this.q.slerp(target, t);
    return target.copy(this.q);
  }
}
