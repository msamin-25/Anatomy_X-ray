import type { LabelAnchor } from '../species/types';
import type { Stage } from './Stage';

interface Placed {
  text: string;
  width: number;
  /** Anchor point on screen. */
  x: number;
  y: number;
  /** Where the label text starts (left column: where it ends). */
  left: boolean;
  colX: number;
  labelY: number;
}

const LINE_HEIGHT = 20;
const GAP = 56; // distance from the body part to its label column
const PAD = 6; // space between the leader line and the text

/** Draws bone names in side columns with leader lines, on an unmirrored 2D canvas. */
export class LabelLayer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly point = { x: 0, y: 0 };

  constructor(private canvas: HTMLCanvasElement, private stage: Stage) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(anchors: LabelAnchor[]): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!anchors.length) return;
    ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    const groups = new Map<string, Placed[]>();
    for (const a of anchors) {
      const p = this.stage.toScreen(a.pos, this.point);
      const text = a.text.toUpperCase();
      if (!groups.has(a.entity)) groups.set(a.entity, []);
      groups.get(a.entity)!.push({
        text, width: ctx.measureText(text).width, x: p.x, y: p.y, left: false, colX: 0, labelY: p.y,
      });
    }
    const all: Placed[] = [];
    for (const items of groups.values()) all.push(...layoutGroup(items));
    separate(all);

    for (const it of all) {
      const dir = it.left ? -1 : 1;
      ctx.strokeStyle = 'rgba(210, 236, 255, 0.75)';
      ctx.beginPath();
      ctx.moveTo(it.x, it.y);
      ctx.lineTo(it.colX - dir * 14, it.labelY);
      ctx.lineTo(it.colX, it.labelY);
      ctx.stroke();
      ctx.fillStyle = '#e6f5ff';
      ctx.beginPath();
      ctx.arc(it.x, it.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = it.left ? 'right' : 'left';
      ctx.shadowColor = 'rgba(0, 8, 24, 0.9)';
      ctx.shadowBlur = 6;
      ctx.fillText(it.text, it.colX + dir * PAD, it.labelY);
      ctx.shadowBlur = 0;
    }
  }
}

/** Assigns each label of one body part to a left or right column and spaces them. */
function layoutGroup(items: Placed[]): Placed[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let widest = 0;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    maxX = Math.max(maxX, it.x);
    widest = Math.max(widest, it.width);
  }
  const centre = (minX + maxX) / 2;
  const room = widest + PAD + 8;
  const fitsLeft = minX - GAP - room >= 0;
  const fitsRight = maxX + GAP + room <= window.innerWidth;
  // A narrow group (a hand seen side-on) puts every label on its outer side.
  const split = maxX - minX > 40 && fitsLeft && fitsRight;
  const outerLeft = fitsLeft && (!fitsRight || centre < window.innerWidth / 2);
  for (const it of items) {
    it.left = split ? it.x < centre : outerLeft;
    it.colX = it.left ? Math.max(minX - GAP, room) : Math.min(maxX + GAP, window.innerWidth - room);
  }
  for (const left of [true, false]) {
    const column = items.filter((it) => it.left === left).sort((p, q) => p.y - q.y);
    for (let i = 1; i < column.length; i++) {
      column[i].labelY = Math.max(column[i].labelY, column[i - 1].labelY + LINE_HEIGHT);
    }
    let shift = 0;
    for (const it of column) shift += (it.labelY - it.y) / column.length;
    for (const it of column) it.labelY -= shift;
  }
  return items;
}

/** Moves labels from different body parts down until none overlap. */
function separate(all: Placed[]): void {
  const x0 = (it: Placed) => (it.left ? it.colX - PAD - it.width : it.colX + PAD);
  all.sort((p, q) => p.labelY - q.labelY);
  for (let i = 1; i < all.length; i++) {
    const cur = all[i];
    for (let j = 0; j < i; j++) {
      const other = all[j];
      const overlapX = x0(cur) < x0(other) + other.width + 8 && x0(other) < x0(cur) + cur.width + 8;
      if (overlapX && Math.abs(cur.labelY - other.labelY) < LINE_HEIGHT) {
        cur.labelY = other.labelY + LINE_HEIGHT;
        j = -1; // re-check against everything placed so far
      }
    }
  }
}
