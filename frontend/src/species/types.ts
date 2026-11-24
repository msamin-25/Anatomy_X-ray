import type { Vector3 } from 'three';
import type { FrameSource } from '../core/source';
import type { Stage } from '../render/Stage';
import type { Layers } from './human/systems';

/** A bone name pinned to a point in camera space. */
export interface LabelAnchor {
  text: string;
  pos: Vector3;
  /** Labels with the same entity are laid out together (one face, one hand). */
  entity: string;
  /** Marker colour; the accent colour when absent. */
  color?: string;
}

export interface FrameInput {
  source: FrameSource;
  /** Monotonic time in milliseconds. */
  time: number;
  /** Seconds since the previous tracked frame. */
  dt: number;
  aspect: number;
}

export type FaceMode = 'half' | 'full' | 'off';

export interface ViewOptions {
  face: FaceMode;
  hands: boolean;
  body: boolean;
  /** Which body systems to draw: bones, nerves, heart and blood vessels. */
  layers: Layers;
}

/** One species: its trackers, its skeleton and the rigs that connect them. */
export interface SpeciesPlugin {
  readonly id: string;
  load(stage: Stage, onProgress: (message: string) => void): Promise<void>;
  /** Tracks the frame, poses the skeleton and returns the labels to draw. */
  update(frame: FrameInput, options: ViewOptions): LabelAnchor[];
  /** Hides everything this plugin draws, while another plugin is active. */
  hide(): void;
  dispose(): void;
}
