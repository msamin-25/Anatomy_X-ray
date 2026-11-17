# Anatomy X-ray

A webcam "X-ray mirror": it tracks your face, hands and body and draws the
matching bones over the video, with anatomical labels. A second mode does the
same for dogs and cats, and a third is a guided skin check. Everything runs in
the browser and no video leaves your device.

## Run

```bash
npm install
npm run animal-model   # once: downloads the dog/cat pose model (about 50 MB)
npm run dev
```

Open the printed URL, pick a mode on the home screen (**Human skeleton**,
**Dog & cat skeleton** or **Skin check**) and allow camera access. You can also
open or drop an image or video file. The back arrow returns to the home screen
and switches the camera off.

In the camera view, the tabs at the top switch between **Human**, **Pet** and
**Skin**, and the chip beside them shows what is happening (live, loading,
looking for a pet). The toolbar at the bottom holds the tools for the mode. In human mode,
**Half / Full / Off** set how much of the face is revealed, **Flip side**
switches the revealed half, and **Hands**, **Body** and **Labels** toggle those
layers. In animal mode the species is detected automatically; **Dog** or
**Cat** overrides it when the detector gets it wrong.

**Skin** turns the camera into a magnifier (zoom, the phone's light where
supported, and **Save photo** to compare a spot over time) and asks a few
questions. The answer is how urgently to get help, who to see, and common
causes of skin like that, with links to NHS pages. It is guidance, not a
diagnosis: no image model is used, because none that is free was accurate
enough (see the architecture notes).

URL options, handy for testing: `?mode=animal|skin`, `?species=dog|cat`,
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
- Skin check guidance follows the [NHS website](https://www.nhs.uk/conditions/).
  It is general information, not medical advice.
