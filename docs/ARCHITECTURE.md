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
| Animal detection | MediaPipe Object Detector (EfficientDet-Lite0, COCO) | Finds the dog or cat box and tells the two apart |
| Animal pose | RTMPose-m AP-10K via ONNX Runtime Web (wasm) | Apache-licensed, 17 keypoints, covers dogs and cats |
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

## Body systems

`tools/build_systems.py` builds `systems.glb` and `systems.json` next to the
bones, in the same anatomical space.

- **Meshes** (BodyParts3D): heart wall, aorta and its branches, coronary
  arteries, venae cavae, jugular, subclavian, iliac and renal vessels,
  pulmonary arteries and veins, lungs, trachea and bronchi, cerebrum (white
  matter), cerebellum, brainstem, ventricles and optic nerves. The white matter
  is folded and has no cortex, so a smoothed hull per hemisphere is added as
  the brain's outer surface.
- **Routed paths**: BodyParts3D has nothing for the limbs, neck, face and chest
  wall, so about 250 vessels and nerves are written as centre lines whose
  control points are placed relative to the bones (a point along a bone's axis
  plus offsets, or on the skull surface): the spinal cord through the
  vertebral canals, spinal roots and intercostal nerves along the ribs, the
  brachial plexus and the median, ulnar, radial and musculocutaneous nerves,
  the femoral, sciatic, tibial and fibular nerves, the facial, trigeminal,
  vagus and phrenic nerves, limb, hand, foot, neck, face and brain arteries and
  veins, the dural sinuses and the azygos veins. The app turns them into tubes.
- **Binding**: each vertex and centre-line sample follows up to two skeleton
  segments (groups of bones a rig moves as one: the skull, the jaw, each neck
  and lumbar vertebra, the rib cage, the pelvis, each limb segment, the palm,
  each finger bone). Meshes bind to the nearest allowed bones (blended within
  2 cm); paths carry the binding of their control points, blended between them,
  so a vessel bends across a joint.
- **Flow distance**: centimetres along each network from the heart (arteries
  and veins, pulmonary arteries and veins) or from the brainstem (nerves),
  found with Dijkstra over the mesh edges and by arc length along the paths.

`Systems` (`src/species/human/systems.ts`) uploads the segment matrices as a
small float texture each frame (visibility in the last element), and one
shader per group skins each vertex with two of them. The shader also squeezes
the heart and the roots of its vessels with the beat, lets the lungs breathe,
keeps thin tubes at least 1.6 px wide, and animates the flow distance: a
pressure wave per heartbeat along the arteries, a slower drift back along the
veins, quick signals along the nerves. Everything is additive; the bones glow
at half strength while these layers are on. The systems model (about 2.7 MB)
loads the first time the Nerves or Blood layer, or the explorer, needs it.

The live mirror and the 3D explorer share one `HumanModel` (bones, styles,
systems). The explorer (`ExplorePlugin`) sets every bone to the same orbit
matrix, so the body stands in its rest pose; its frame source is a backdrop
the size of the window, with no camera.

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

The human plugin is the reference. `main.ts` keeps one plugin active and calls
`hide()` on the other when the mode changes. The animal plugin is loaded with
a dynamic `import()` on first use, so human mode never downloads ONNX Runtime
or the 54 MB pose model.

## Animal mode

```
frame ─ ObjectDetector (dog|cat box, species vote)
          └─ square crop, padded ×1.25, 256×256
               └─ RTMPose AP-10K (async, ONNX Runtime)   17 keypoints
                    └─ AnimalRig   keypoints -> 3D joints -> bone matrices
```

Pose inference is asynchronous: `AnimalTracker.track` starts a run only when
the previous one has finished, and the rig always poses from the latest
result, so the render loop never waits. When the detector misses a frame, the
crop falls back to the box around the last confident pose.

**Keypoint meaning.** AP-10K marks the joints visible from outside, which sit
lower than their names: its "shoulder" is at the elbow, "elbow" at the carpus,
"hip" at the stifle and "knee" at the hock. The rig uses them that way and
places the hidden shoulder and hip joints between the body line and those
points.

**Depth from one camera.** Keypoints are 2D, so the rig recovers depth from
proportions (`species.ts`, in units of the neck-to-tail-root distance):

1. Scale: the second-largest ratio of a measured to an expected segment
   length. Segments only shrink when they turn away from the camera, so the
   largest ratios are the honest ones; skipping the top one ignores a single
   misplaced keypoint.
2. Forward: the 2D neck-to-tail vector plus the depth its foreshortening
   implies. The sign comes from left-minus-right offsets of paired points (a
   subject facing the camera shows its left side on the image right).
3. Left: from those paired offsets when they are large (front views),
   otherwise dorsal × forward, with dorsal pointing away from the paws.
4. Each keypoint is lifted along its camera ray onto the sagittal plane of its
   own side of the body. The skull is placed separately: the nose stays on its
   ray at the depth that the eye-to-nose foreshortening implies.

**Bones.** There are no open-licensed dog or cat bone meshes to rig, so
`geometry.ts` builds schematic bones from lathes, ellipsoids and tubes. Each
piece is authored in its own frame (+X subject's left, +Y along the bone, +Z =
X × Y) at its expected length, and the rig stretches it between two joints:
`segmentFrame(from, to, left) · scale(s, length / authored length, s)`. No rest
pose file is needed. Thoracic vertebrae carry their ribs and a piece of the
sternum, so the rib cage bends with the spine. The tail is not tracked (AP-10K
only marks its root) and hangs from it.

Known limits: a sitting animal seen from the front is ambiguous and looks
busy; EfficientDet-Lite0 sometimes calls slim cats dogs (hence the override).

## Skin mode

`src/skin/guide.ts` holds the questionnaire, the urgency rules and the list of
common causes as plain data; `SkinCheck.ts` renders it in a side panel and
fits the plugin interface so the main loop treats it like the other modes. The
camera is only a magnifier here: CSS zoom around the screen centre, the torch
through `MediaStreamTrack.applyConstraints` where the camera supports it, and
**Save photo**, which crops the zoomed region from the full-resolution frame
(the share sheet on touch devices, a download elsewhere). Skin mode asks the
camera for 1920 pixels on the long side so zoomed photos stay sharp.

Urgency has four levels: emergency (anaphylaxis, a non-blanching rash with
feeling unwell, widespread blistering or peeling, signs of sepsis), today
(painful hot swollen skin, a band-shaped painful rash, rash with fever, a
severe rash after a new medicine), within two weeks (a mole with ABCDE warning
signs, a sore that has not healed in 4 weeks, impetigo, scabies, anything
lasting over 4 weeks) and pharmacist/self-care. The rules follow the NHS
condition pages. Common causes are ranked by how many answers match; causes
that must not be hidden behind harmless ones (skin cancer, cellulitis) are
listed first whenever they match.

**Why there is no skin classifier.** The best free on-device candidate
(Eraly-ml/Skin-AI, ConvNeXt, 22 DermNet-style classes, MIT/CC0) was quantised
to 89 MB and evaluated on 661 dermatologist-labelled phone photos from Google's
SCIN dataset:

| Measure | Result |
|---|---|
| Top-1 on conditions it has a class for (500 random cases) | 15% (always answering "eczema" scores 54%) |
| Top-3 | 26% |
| Eczema, the most common condition | 1% recall |
| Fitzpatrick 4-6 vs 1-3, top-1 | 13% vs 15% |
| Skin cancers (BCC, SCC, melanoma) | 0 of 15 caught; the melanoma was called an insect bite |
| Conditions with no class (hives, impetigo, shingles…) | confidently named as something else 43% of the time |

A model that misses every cancer and calls it a bite would do harm, so the
feature is a questionnaire instead. A classifier trained on phone photos (for
example SCIN, under its data use licence) and tested the same way could be
reconsidered.

## Layout

```
docs/                 this file
tools/                Python asset pipeline (run with .venv)
public/models/human/  human.glb + human.json, systems.glb + systems.json
                      (generated, committed)
public/models/animal/ rtmpose-ap10k.onnx (fetched by `npm run animal-model`)
src/
  main.ts             bootstrap, UI wiring, mode switching
  core/               video source, filters, math
  render/             stage, X-ray material, labels, face mask
  species/human/      trackers, skull / hand / body rigs, body systems,
                      3D explorer, shared model
  species/animal/     detector + pose tracker, species proportions,
                      procedural bone geometry, quadruped rig
  skin/               skin check questionnaire (guide.ts) and its panel
  ui/                 icons (Lucide, ISC licence) as inline SVG
  style.css           design tokens and all interface styles
```

## Interface

A home screen (mode cards, file picker, privacy notes, credits) and a camera
view with a top bar (back to home, mode tabs, status chip) and a bottom
toolbar whose tools depend on the mode. Styles are built on the tokens at the
top of `style.css`: Inter (self-hosted via `@fontsource-variable/inter`), a
dark clinical palette with a teal accent, one radius and shadow scale, 44 px
touch targets, and reduced motion when the system asks for it. Going back to
the home screen releases the camera.

## Phases

1. Human skull and hands (reproduces the reference video) (done).
2. Human full body: spine, ribs, pelvis, limbs (done).
3. Dog and cat: species detection, animal pose model, skeleton rigs (done).
4. Skin check: guided questionnaire with camera magnifier (done).
5. Body systems: nerves, heart, blood vessels with animated flow, and the 3D
   explorer (done).
6. Polish: details on click, recording, muscles and organs.

## Asset credit

Human bone, heart, vessel, lung and brain meshes are derived from BodyParts3D,
© The Database Center for Life Science, licensed under CC Attribution-Share
Alike 2.1 Japan. The generated files in `public/models/human/` carry the same
licence. The routed limb, neck, face and chest-wall vessels and nerves are
schematic.
