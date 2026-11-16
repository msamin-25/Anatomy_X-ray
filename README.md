# Anatomy X-ray

A webcam "X-ray mirror": it tracks your face and hands and draws the matching
skull and hand bones over the video, with anatomical labels. Everything runs
in the browser and no video leaves your device.

## Run

```bash
npm install
npm run dev
```

Open the printed URL, press **Start camera** and allow camera access. You can
also drop an image or video file onto the page.

Controls: **Half / Full / Off** set how much of the face is revealed,
**Flip side** switches the revealed half, and **Hands**, **Body** and
**Labels** toggle those layers.

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
