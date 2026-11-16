# Anatomy X-ray: architecture

A webcam "X-ray mirror". It finds body landmarks in each video frame, poses a
3D skeleton to match them, and draws the skeleton over the video with a
see-through shader and anatomical labels. Everything runs in the browser; no
video leaves the device.

## Pipeline

```
video frame (webcam or a dropped image/video file)
  └─ Tracker          landmarks for face, hands, body (per species)
       └─ Smoothing   One Euro filter per landmark, removes jitter
            └─ Rig    landmarks -> one 4x4 matrix per bone
                 └─ Renderer   video + tint mask + X-ray shaded bones (Three.js)
                      └─ Labels    bone anchors projected to screen, leader lines
```

One `requestAnimationFrame` loop drives all stages. Trackers only run when the
video has a new frame.

## Stack

| Concern | Choice | Why |
|---|---|---|
| App | Vite + TypeScript | Static output, hosts anywhere |
| Rendering | Three.js | GLB loading, custom shaders |
| Human tracking | MediaPipe Tasks Vision | Face (478 points + head pose matrix + expression weights), hands (21 points), body (33 points), all on-device |
| Animal tracking (phase 3) | RTMPose AP-10K via ONNX Runtime Web | Apache-licensed, covers dogs and cats |
| Asset pipeline | Python (`.venv`), trimesh | Converts and decimates source meshes to GLB |

## Coordinate spaces

- **Camera space** (the Three.js scene): centimetres, +X right, +Y up, camera
  at the origin looking down -Z, vertical field of view 63°. This is the space
  MediaPipe's facial transformation matrix is expressed in, so the skull can
  use that matrix directly.
- **Anatomical space** (the GLB): centimetres, +X subject's left, +Y up,
  +Z anterior. Every bone mesh stays in its rest position in this space; the
  rig only ever sets `mesh.matrix`.
- **Screen**: the video and the 3D canvas are drawn unmirrored and flipped
  together in CSS for the mirror effect. Labels are drawn on a separate,
  unflipped canvas so text reads correctly.

## Rigging

Hands and body only give 3D points relative to their own centre, not their
position in front of the camera. `solveTranslation` finds the offset that makes
those points project onto the 2D image landmarks (linear least squares), which
puts hands, body and skull in one consistent 3D scene.

Three rig types cover every bone:

| Rig | Used for | Matrix |
|---|---|---|
| Anchored | Skull | Facial matrix × a fixed fit from anatomical space to MediaPipe's canonical face. The jaw adds a hinge rotation about the two condyles, driven by the `jawOpen` expression weight. |
| Segment | Phalanges, metacarpals, limb bones | `Frame(A, B, hint) · scale · Frame(A₀, B₀, hint₀)⁻¹`, where A and B are the live joint positions and A₀, B₀ the same joints in the rest pose. |
| Block | Carpals, rib cage, pelvis | Same idea, with a frame built from three or four landmarks and per-axis scale. |

Rest joints (A₀, B₀) are computed by the asset pipeline from the bone meshes
(principal-axis end points) and stored in `human.json`.

## Rendering

1. Video as a full-screen background quad.
2. Tint mask: the face oval is filled with a dark blue tint so the skull reads
   as "inside" the head. In half mode the mask and the skull are clipped at
   the face midline.
3. Bones, three passes: depth only, a dark shade on the nearest surface, then
   an additive edge glow on every layer (thick, edge-on bone ends up brightest,
   as on a radiograph).
4. Labels: 2D canvas, leader lines from projected bone anchors to side columns.

## Species plugins

Each species implements one interface (`src/species/types.ts`):

```ts
interface SpeciesPlugin {
  id: string;
  load(stage: Stage): Promise<void>;       // models + trackers
  update(frame: FrameInput): LabelAnchor[]; // track, rig, return labels
  dispose(): void;
}
```

The human plugin is the reference. Dog and cat plugins will reuse the segment
and block rigs with 2D keypoints placed on a fixed depth plane.

## Layout

```
docs/                 this file
tools/                Python asset pipeline (run with .venv)
public/models/human/  human.glb + human.json (generated, committed)
src/
  main.ts             bootstrap, UI wiring
  core/               video source, filters, math
  render/             stage, X-ray material, labels, face mask
  species/human/      trackers, skull / hand / body rigs
```

## Phases

1. Human skull and hands (reproduces the reference video).
2. Human full body: spine, ribs, pelvis, limbs.
3. Dog and cat: species detection, animal pose model, skeleton rigs.
4. Polish: scan modes, bone details on click, recording.

## Asset credit

Human bone meshes are derived from BodyParts3D, © The Database Center for Life
Science, licensed under CC Attribution-Share Alike 2.1 Japan. The generated
files in `public/models/human/` carry the same licence.
