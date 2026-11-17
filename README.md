# Anatomy X-ray

A webcam "X-ray mirror": it tracks your face, hands and body and draws the
matching bones over the video, with anatomical labels. A second mode does the
same for dogs and cats. Everything runs in the browser and no video leaves
your device.

## Run

```bash
npm install
npm run animal-model   # once: downloads the dog/cat pose model (about 50 MB)
npm run dev
```

Open the printed URL, press **Start camera** and allow camera access. You can
also drop an image or video file onto the page.

Controls: **Human / Dog / Cat** switches the subject. In human mode,
**Half / Full / Off** set how much of the face is revealed, **Flip side**
switches the revealed half, and **Hands**, **Body** and **Labels** toggle those
layers. In animal mode the species is detected automatically; **Dog** or
**Cat** overrides it when the detector gets it wrong.

URL options, handy for testing: `?mode=animal`, `?species=dog|cat`,
`?src=/test/dog_side.jpg` (an image or video instead of the camera),
`?delegate=cpu`, and `?debug` (shows pose inference time and exposes
tracking internals as `window.__animal`).

## Hosting

The output of `npm run build` is static. Serve it with these two headers, as
the dev server does; they let the animal pose model use several threads (about
three times faster):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Rebuilding the bone models

The models in `public/models/human/` are generated and committed. To rebuild
them (downloads about 130 MB of source meshes into `tools/.cache`):

```bash
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
npm run assets
```

## Credits

- Bone meshes are derived from **BodyParts3D**, © The Database Center for Life
  Science, licensed under
  [CC Attribution-Share Alike 2.1 Japan](https://creativecommons.org/licenses/by-sa/2.1/jp/deed.en).
  The files in `public/models/human/` carry the same licence.
- Tracking uses [MediaPipe Tasks](https://ai.google.dev/edge/mediapipe/solutions/guide) (Apache 2.0).
- Animal pose: [RTMPose](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose)
  trained on AP-10K, by OpenMMLab (Apache 2.0), run with
  [ONNX Runtime Web](https://onnxruntime.ai/) (MIT). The dog and cat bones are
  schematic shapes generated in code, not scanned anatomy.
