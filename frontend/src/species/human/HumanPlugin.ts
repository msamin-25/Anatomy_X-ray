import { FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { LITE } from '../../core/device';
import type { Stage } from '../../render/Stage';
import type { FrameInput, LabelAnchor, SpeciesPlugin, ViewOptions } from '../types';
import { BodyRig } from './BodyRig';
import { HandRig } from './HandRig';
import { HumanModel, humanModel } from './model';
import { SkullRig } from './SkullRig';

const MODELS = 'https://storage.googleapis.com/mediapipe-models';
const BASE = import.meta.env.BASE_URL;
/** Phones use the lighter body model: about twice as fast, slightly less precise. */
const POSE_MODEL = LITE ? 'pose_landmarker_lite' : 'pose_landmarker_full';

/**
 * Main-thread time (ms) the trackers may take per camera frame. Above it,
 * hand and body tracking take turns so the video and face stay smooth.
 */
const TRACK_BUDGET_MS = 24;
/** While taking turns and no hand is in view, the costly hand search gets one turn in this many. */
const HAND_SEARCH_EVERY = 4;

type Tracker = 'face' | 'hands' | 'pose';

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
  /** Smoothed main-thread time of each tracker (ms per run). */
  readonly cost: Record<Tracker, number> = { face: 0, hands: 0, pose: 0 };
  /** When each tracker last ran (ms), so its rig gets its own time step. */
  private readonly lastRun: Record<Tracker, number> = { face: 0, hands: 0, pose: 0 };
  private turn = 0;
  private runStart = 0;
  private readonly seen = { L: false, R: false };
  private handLabels: LabelAnchor[] = [];
  private bodyLabels: LabelAnchor[] = [];

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
        baseOptions: { modelAssetPath: `${MODELS}/pose_landmarker/${POSE_MODEL}/float16/1/${POSE_MODEL}.task`, delegate },
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
    const { source, time, aspect } = frame;
    const labels: LabelAnchor[] = [];
    const { layers } = options;
    this.model.skeleton.root.visible = layers.bones;
    const { runHands, runPose } = this.schedule(options);

    if (options.face === 'off') {
      this.skull.reset();
    } else {
      const dt = this.started('face', time);
      const result = this.face.detectForVideo(source.el, time);
      this.finished('face');
      labels.push(...this.skull.update(result, aspect, dt, options.face));
    }

    // A tracker sitting out this frame keeps its bones where they were.
    if (!options.hands) {
      this.seen.L = this.seen.R = false;
      this.handLabels = [];
    } else if (runHands) {
      const dt = this.started('hands', time);
      const result = this.handTracker.detectForVideo(source.el, time);
      this.finished('hands');
      const seen = { L: false, R: false };
      this.handLabels = [];
      for (let i = 0; i < result.landmarks.length; i++) {
        // Handedness is the subject's own left/right for an unmirrored frame.
        let side: 'L' | 'R' = result.handedness[i]?.[0]?.categoryName === 'Left' ? 'L' : 'R';
        if (seen[side]) side = side === 'L' ? 'R' : 'L';
        if (seen[side]) continue;
        seen[side] = true;
        this.handLabels.push(...this.hands[side].update(result.landmarks[i], result.worldLandmarks[i], aspect, dt));
      }
      this.seen.L = seen.L;
      this.seen.R = seen.R;
    }
    if (!this.seen.L) this.hands.L.hide();
    if (!this.seen.R) this.hands.R.hide();
    labels.push(...this.handLabels);

    if (!options.body) {
      this.body.hide();
      this.bodyLabels = [];
    } else if (runPose) {
      const dt = this.started('pose', time);
      const pose = this.poseTracker.detectForVideo(source.el, time);
      this.finished('pose');
      if (pose.landmarks[0]) {
        this.body.handWrist.L = this.seen.L ? this.hands.L.joints[0] : null;
        this.body.handWrist.R = this.seen.R ? this.hands.R.joints[0] : null;
        const skullBase = this.skull.tracked ? this.skull.base : null;
        this.bodyLabels = this.body.update(pose.landmarks[0], pose.worldLandmarks[0], aspect, dt, skullBase);
      } else {
        this.body.hide();
        this.bodyLabels = [];
      }
    }
    labels.push(...this.bodyLabels);

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
    this.seen.L = this.seen.R = false;
    this.handLabels = [];
    this.bodyLabels = [];
    this.lastRun.face = this.lastRun.hands = this.lastRun.pose = 0;
  }

  /**
   * Decides which of the hand and body trackers run this frame. Normally
   * both do. When the three trackers together take longer than the budget
   * (on a slow phone), hands and body take turns, and while no hand is in
   * view the hand search, which costs the most, gets fewer turns.
   */
  private schedule(options: ViewOptions): { runHands: boolean; runPose: boolean } {
    const c = this.cost;
    const total = (options.face === 'off' ? 0 : c.face) + (options.hands ? c.hands : 0) + (options.body ? c.pose : 0);
    if (total <= TRACK_BUDGET_MS || !options.hands) return { runHands: options.hands, runPose: options.body };
    const turn = this.turn++;
    const searching = !this.seen.L && !this.seen.R;
    if (!options.body) return { runHands: !searching || turn % 2 === 0, runPose: false };
    const handTurn = turn % (searching ? HAND_SEARCH_EVERY : 2) === 0;
    return { runHands: handTurn, runPose: !handTurn };
  }

  /** Marks the start of a tracker run; returns the seconds since its previous run, for its rig's smoothing. */
  private started(tracker: Tracker, time: number): number {
    const last = this.lastRun[tracker];
    this.lastRun[tracker] = time;
    this.runStart = performance.now();
    return last ? (time - last) / 1000 : 0;
  }

  private finished(tracker: Tracker): void {
    const ms = performance.now() - this.runStart;
    const c = this.cost;
    c[tracker] = c[tracker] ? c[tracker] + (ms - c[tracker]) * 0.1 : ms;
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
