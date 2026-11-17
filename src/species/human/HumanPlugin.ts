import { FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Stage } from '../../render/Stage';
import type { FrameInput, LabelAnchor, SpeciesPlugin, ViewOptions } from '../types';
import { BodyRig } from './BodyRig';
import { HandRig } from './HandRig';
import { HumanModel, humanModel } from './model';
import { SkullRig } from './SkullRig';

const MODELS = 'https://storage.googleapis.com/mediapipe-models';
const BASE = import.meta.env.BASE_URL;

export class HumanPlugin implements SpeciesPlugin {
  readonly id = 'human';
  private stage!: Stage;
  readonly model = humanModel;
  private face!: FaceLandmarker;
  private handTracker!: HandLandmarker;
  private poseTracker!: PoseLandmarker;
  private body!: BodyRig;
  private skull!: SkullRig;
  private hands!: { L: HandRig; R: HandRig };

  async load(stage: Stage, onProgress: (message: string) => void): Promise<void> {
    this.stage = stage;
    onProgress('Loading skeleton');
    const model = this.model;
    await model.load(stage);
    this.skull = new SkullRig(model.skeleton, model.skullStyle, model.mask);
    this.hands = { L: new HandRig(model.skeleton, 'L'), R: new HandRig(model.skeleton, 'R') };
    this.body = new BodyRig(model.skeleton);

    onProgress('Loading trackers');
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    const preferred = new URLSearchParams(location.search).get('delegate') === 'cpu' ? 'CPU' : 'GPU';
    const create = async (delegate: 'CPU' | 'GPU') => {
      this.face = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      this.handTracker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
      });
      this.poseTracker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${MODELS}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    };
    try {
      await create(preferred);
    } catch (err) {
      if (preferred === 'CPU') throw err;
      console.warn('GPU tracking unavailable, using CPU', err);
      await create('CPU');
    }
  }

  update(frame: FrameInput, options: ViewOptions): LabelAnchor[] {
    const { source, time, dt, aspect } = frame;
    const labels: LabelAnchor[] = [];
    const { layers } = options;
    this.model.skeleton.root.visible = layers.bones;

    if (options.face === 'off') {
      this.skull.reset();
    } else {
      labels.push(...this.skull.update(this.face.detectForVideo(source.el, time), aspect, dt, options.face));
    }

    const seen = { L: false, R: false };
    if (options.hands) {
      const result = this.handTracker.detectForVideo(source.el, time);
      for (let i = 0; i < result.landmarks.length; i++) {
        // Handedness is the subject's own left/right for an unmirrored frame.
        let side: 'L' | 'R' = result.handedness[i]?.[0]?.categoryName === 'Left' ? 'L' : 'R';
        if (seen[side]) side = side === 'L' ? 'R' : 'L';
        if (seen[side]) continue;
        seen[side] = true;
        labels.push(...this.hands[side].update(result.landmarks[i], result.worldLandmarks[i], aspect, dt));
      }
    }
    if (!seen.L) this.hands.L.hide();
    if (!seen.R) this.hands.R.hide();

    const pose = options.body ? this.poseTracker.detectForVideo(source.el, time) : null;
    if (pose?.landmarks[0]) {
      this.body.handWrist.L = seen.L ? this.hands.L.joints[0] : null;
      this.body.handWrist.R = seen.R ? this.hands.R.joints[0] : null;
      const skullBase = this.skull.tracked ? this.skull.base : null;
      labels.push(...this.body.update(pose.landmarks[0], pose.worldLandmarks[0], aspect, dt, skullBase));
    } else {
      this.body.hide();
    }

    // Heart, vessels and nerves follow the bones the rigs just posed. Their
    // names replace the bone names while they are shown.
    const systems = this.model.systems;
    this.model.dimBones(!!systems && (layers.nerves || layers.blood));
    if (systems && (layers.nerves || layers.blood)) {
      return systems.update(time / 1000, layers, HumanModel.focalPixels(this.stage), true);
    }
    systems?.hide();
    return layers.bones ? labels : [];
  }

  hide(): void {
    this.skull?.reset();
    this.hands?.L.hide();
    this.hands?.R.hide();
    this.body?.hide();
    this.model.systems?.hide();
  }

  flipFaceSide(): void {
    this.skull.side = this.skull.side === 'L' ? 'R' : 'L';
  }

  dispose(): void {
    this.hide();
    this.face.close();
    this.handTracker.close();
    this.poseTracker.close();
  }
}
