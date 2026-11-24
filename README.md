# Anatomy X-ray

A webcam "X-ray mirror": it tracks your face, hands and body and draws the
matching bones, nerves, heart and blood vessels over the video, with
anatomical labels and animated blood flow. Other modes show a dog or cat
skeleton, a 3D body you can turn and zoom without a camera, and a guided skin
check. Everything runs in the browser and no video leaves your device.

*** The Updated version with more features is coming sooooooon!

## Project layout

```
frontend/   the web app (Vite + TypeScript): everything that runs in the browser
tools/      Python scripts that generate the 3D anatomy models in frontend/public/models/human/
docs/       architecture notes
```

There is no backend server and no database: tracking, the 3D models and the
skin check all run on the device, which is why no video leaves it.

## Run

```bash
cd frontend
npm install
npm run animal-model   # once: downloads the dog/cat pose model (about 50 MB)
npm run dev
```

Open the printed URL, pick a mode on the home screen (**Human X-ray**,
**Dog & cat skeleton**, **Skin check** or **3D body explorer**) and allow camera
access (the explorer needs none). You can also open or drop an image or video
file. The back arrow returns to the home screen and switches the camera off.

In the camera view, the tabs at the top switch between **Human**, **Pet**,
**Skin** and **3D**, and the chip beside them shows what is happening (live,
loading, looking for a pet). The toolbar at the bottom holds the tools for the
mode. In human mode, **Show: Bones / Nerves / Blood** picks the body systems
(nerves and blood switch on body tracking: step back so your chest and arms are
in view), **Half / Full / Off** set how much of the face is revealed, **Flip
side** switches the revealed half, and **Hands**, **Body** and **Labels** toggle
those layers. In animal mode the species is detected automatically; **Dog** or
**Cat** overrides it when the detector gets it wrong.

**3D** shows the whole body in the anatomical position with the same systems:
drag to turn it, scroll or pinch to zoom, right-drag or two fingers to move,
double-click to reset. **Body / Head / Chest / Hand** jump to a view and
**Spin** turns it slowly. The heart beats, a pressure wave runs out along the
arteries with each beat, blood drifts back along the veins (red is oxygen-rich,
blue oxygen-poor, so the pulmonary arteries are blue), and signals run out
along the nerves.

**Skin** turns the camera into a magnifier (zoom, the phone's light where
supported, and **Save photo** to compare a spot over time) and asks a few
questions. The answer is how urgently to get help, who to see, and common
causes of skin like that, with links to NHS pages. It is guidance, not a
diagnosis: no image model is used, because none that is free was accurate
enough (see the architecture notes).

URL options, handy for testing: `?mode=animal|skin|explore`, `?nerves=1`,
`?blood=1`, `?species=dog|cat`,
`?src=/test/dog_side.jpg` (an image or video instead of the camera),
`?delegate=cpu`, `?quality=lite|full` (force the phone or desktop setup), and
`?debug` (shows tracker and pose inference times and exposes tracking
internals as `window.__animal`).

On phones the app renders at a lower resolution and uses a lighter body
tracker, and on any slow device hand and body tracking take turns between
frames, so the video stays smooth (see the architecture notes).

## Hosting

The output of `npm run build` (in `frontend/dist/`) is static. Serve it with these two headers, as
the dev server does; they let the animal pose model use several threads (about
three times faster):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Rebuilding the anatomy models

The models in `frontend/public/models/human/` are generated and committed:
`human.glb` and `human.json` (bones), and `systems.glb` and `systems.json`
(heart, vessels, nerves, brain, lungs). To rebuild them (downloads about 150 MB
of source meshes into `tools/.cache`), from the repository root:

```bash
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/build_human_assets.py   # bones
.venv/bin/python tools/build_systems.py        # heart, vessels, nerves
```

`npm run assets` (both) and `npm run systems` in `frontend/` run the same
scripts.

## Credits

- Bone, heart, great vessel, lung and brain meshes are derived from
  **BodyParts3D**, © The Database Center for Life Science, licensed under
  [CC Attribution-Share Alike 2.1 Japan](https://creativecommons.org/licenses/by-sa/2.1/jp/deed.en).
  The files in `frontend/public/models/human/` carry the same licence. BodyParts3D has
  no meshes for the vessels and nerves of the limbs, neck, face and chest wall;
  those are routed by hand along their textbook course and are schematic.
- Tracking uses [MediaPipe Tasks](https://ai.google.dev/edge/mediapipe/solutions/guide) (Apache 2.0).
- Animal pose: [RTMPose](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose)
  trained on AP-10K, by OpenMMLab (Apache 2.0), run with
  [ONNX Runtime Web](https://onnxruntime.ai/) (MIT). The dog and cat bones are
  schematic shapes generated in code, not scanned anatomy.
- Skin check guidance follows the [NHS website](https://www.nhs.uk/conditions/).
  It is general information, not medical advice.
