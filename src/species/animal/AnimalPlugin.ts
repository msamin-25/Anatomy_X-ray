import type { Stage } from '../../render/Stage';
import { XrayStyle } from '../../render/xray';
import type { FrameInput, LabelAnchor, SpeciesPlugin } from '../types';
import { AnimalRig } from './AnimalRig';
import { AnimalTracker, type AnimalKind } from './AnimalTracker';
import { CAT, DOG } from './species';

/** Dogs and cats: one tracker, and a skeleton per species picked by the detector. */
export class AnimalPlugin implements SpeciesPlugin {
  readonly id = 'animal';
  /** The species currently shown, or null when no animal is in view. */
  kind: AnimalKind | null = null;
  /** Forces a species when the detector gets it wrong; null follows the detector. */
  override: AnimalKind | null = null;
  private stage!: Stage;
  readonly tracker = new AnimalTracker();
  private readonly style = new XrayStyle(1.4);
  private rigs!: Record<AnimalKind, AnimalRig>;

  async load(stage: Stage, onProgress: (message: string) => void): Promise<void> {
    this.stage = stage;
    onProgress('Building skeletons');
    this.rigs = { dog: new AnimalRig(DOG, this.style), cat: new AnimalRig(CAT, this.style) };
    await this.tracker.load(onProgress);
    stage.scene.add(this.rigs.dog.root, this.rigs.cat.root);
  }

  update(frame: FrameInput): LabelAnchor[] {
    this.tracker.track(frame.source.el, frame.time);
    const pose = this.tracker.latest;
    this.kind = pose ? (this.override ?? pose.kind) : null;
    for (const kind of ['dog', 'cat'] as AnimalKind[]) {
      if (kind !== this.kind) this.rigs[kind].hide();
    }
    if (!pose || !this.kind) return [];
    return this.rigs[this.kind].update(pose.points, frame.aspect, frame.dt);
  }

  /** Hides the skeletons while another plugin is active. */
  hide(): void {
    this.rigs?.dog.hide();
    this.rigs?.cat.hide();
  }

  dispose(): void {
    this.stage.scene.remove(this.rigs.dog.root, this.rigs.cat.root);
    this.tracker.dispose();
  }
}
