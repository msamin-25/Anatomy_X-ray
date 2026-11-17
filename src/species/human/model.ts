import { FaceMask } from '../../render/FaceMask';
import type { Stage } from '../../render/Stage';
import { XrayStyle } from '../../render/xray';
import { loadSkeleton, type Skeleton } from './skeleton';
import { loadSystems, type Systems } from './systems';

const BASE = import.meta.env.BASE_URL;

/**
 * The human anatomy shared by the live mirror and the 3D explorer: bones,
 * their X-ray looks, the face tint and (loaded on demand) the heart, vessels
 * and nerves. Only one mode poses it at a time.
 */
export class HumanModel {
  readonly skullStyle = new XrayStyle(0.8);
  readonly boneStyle = new XrayStyle(1.5);
  readonly mask = new FaceMask();
  skeleton!: Skeleton;
  systems: Systems | null = null;
  private loading: Promise<void> | null = null;
  private systemsLoading: Promise<Systems> | null = null;

  load(stage: Stage): Promise<void> {
    this.loading ??= loadSkeleton(`${BASE}models/human/`, (group) =>
      group === 'cranium' || group === 'jaw' ? this.skullStyle : this.boneStyle,
    ).then(
      (skeleton) => {
        this.skeleton = skeleton;
        stage.scene.add(this.mask.mesh, skeleton.root);
      },
      (err) => {
        this.loading = null;
        throw err;
      },
    );
    return this.loading;
  }

  /** Loads the heart, vessels, nerves, brain and lungs (about 2.5 MB) the first time they are needed. */
  loadSystems(stage: Stage): Promise<Systems> {
    this.systemsLoading ??= this.load(stage)
      .then(() => loadSystems(`${BASE}models/human/`, this.skeleton, this.skullStyle.clip))
      .then(
        (systems) => {
          this.systems = systems;
          stage.scene.add(systems.root);
          return systems;
        },
        (err) => {
          this.systemsLoading = null;
          throw err;
        },
      );
    return this.systemsLoading;
  }

  /** Bones glow at half strength while nerves or vessels are drawn over them. */
  dimBones(dim: boolean): void {
    this.boneStyle.setDim(dim ? 0.45 : 1);
    this.skullStyle.setDim(dim ? 0.55 : 1);
  }

  /** Focal length of the stage camera in render pixels. */
  static focalPixels(stage: Stage): number {
    return stage.canvas.height / 2 / Math.tan((stage.camera.fov * Math.PI) / 360);
  }
}

export const humanModel = new HumanModel();
