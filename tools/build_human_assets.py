"""Build frontend/public/models/human/human.glb and human.json from BodyParts3D.

Downloads the bone meshes it needs (cached in tools/.cache), converts them to
anatomical space (cm, +X subject's left, +Y up, +Z anterior), decimates them
and writes one GLB with a node per bone plus a JSON manifest with the rest
pose data the rigs need.

    .venv/bin/python tools/build_human_assets.py

Source: BodyParts3D, (c) The Database Center for Life Science, licensed under
CC Attribution-Share Alike 2.1 Japan. The output carries the same licence.
"""

from __future__ import annotations

import json
import re
import struct
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import fast_simplification
import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / ".cache" / "bodyparts3d"
OUT = ROOT / "frontend" / "public" / "models" / "human"
BASE = (
    "https://raw.githubusercontent.com/Kevin-Mattheus-Moerman/BodyParts3D/"
    "main/assets/BodyParts3D_data"
)

DIGITS = {"thumb": 1, "index": 2, "middle": 3, "ring": 4, "little": 5,
          "big": 1, "second": 2, "third": 3, "fourth": 4}
ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
            "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
            "eleventh": 11, "twelfth": 12}
CARPALS = ("scaphoid", "lunate", "triquetral", "pisiform", "trapezium",
           "trapezoid", "capitate", "hamate")
# Outward direction (x left, y up, z front) used to pick a label point on midline bones.
CENTRAL_ANCHOR = {"frontal": (0.35, 0.6, 0.7), "sphenoid": (1.0, 0.1, 0.4),
                  "mandible": (0.55, -0.6, 0.55), "occipital": (0.6, -0.2, -0.8)}
SKIP = re.compile(
    r"extensor|flexor|hyoid|trapezius|levator|subscapularis|tibialis|"
    r"fibularis|iliotibial|pronator|sesamoid|disk of (axis|.*cervical)"
)


def classify(name: str):
    """Return (key, group, side, display name, triangle budget) or None."""
    if SKIP.search(name):
        return None
    side = "R" if re.search(r"\bright\b", name) else "L" if re.search(r"\bleft\b", name) else ""
    bare = re.sub(r"\b(right|left)\s+", "", name).strip()
    sfx = f"_{side}" if side else ""
    display = bare[0].upper() + bare[1:]

    m = re.match(r"(proximal|middle|distal) phalanx of (\w+) (finger|thumb|toe)", bare)
    if not m:
        m2 = re.match(r"(proximal|middle|distal) phalanx of (thumb)", bare)
        if m2:
            m = re.match(r"(proximal|middle|distal) phalanx of (thumb)()", bare)
    if m:
        seg = {"proximal": "pp", "middle": "mp", "distal": "dp"}[m.group(1)]
        digit = DIGITS[m.group(2)]
        if m.group(3) == "toe":
            return f"t{seg}{digit}{sfx}", "foot", side, display, 300
        return f"{seg}{digit}{sfx}", "hand", side, display, 900
    m = re.match(r"(\w+) metacarpal bone", bare)
    if m:
        return f"mc{ORDINALS[m.group(1)]}{sfx}", "hand", side, display, 1200
    m = re.match(r"(\w+) metatarsal bone", bare)
    if m:
        return f"mt{ORDINALS[m.group(1)]}{sfx}", "foot", side, display, 500
    if bare in CARPALS:
        return f"{bare}{sfx}", "hand", side, display, 700
    if "tooth" in bare:
        jaw = "jaw" if "lower" in bare else "cranium"
        key = re.sub(r"\W+", "_", bare.replace(" secondary", "").replace(" tooth", ""))
        return f"tooth_{key}{sfx}", jaw, side, "Teeth", 220
    if bare == "mandible":
        return "mandible", "jaw", "", display, 6000
    cranial = ("frontal bone", "occipital bone", "sphenoid bone", "vomer", "parietal bone",
               "temporal bone", "zygomatic bone", "lacrimal bone", "nasal bone", "maxilla",
               "palatine bone", "inferior nasal concha")
    if bare in cranial:
        budget = {"frontal bone": 8000, "occipital bone": 6000, "parietal bone": 6000,
                  "sphenoid bone": 4000, "temporal bone": 3500, "maxilla": 4000,
                  "zygomatic bone": 1500}.get(bare, 700)
        return re.sub(r"\W+", "_", bare.replace(" bone", "")) + sfx, "cranium", side, display, budget
    m = re.match(r"(\w+) rib$", bare)
    if m:
        return f"rib{ORDINALS[m.group(1)]}{sfx}", "thorax", side, display, 1800
    if bare in ("manubrium", "body of sternum", "xiphoid process"):
        return re.sub(r"\W+", "_", bare), "thorax", "", display, 1200
    m = re.match(r"(\w+) (cervical|thoracic|lumbar) vertebra$", bare)
    if m:
        return f"{m.group(2)[0]}{ORDINALS[m.group(1)]}", "spine", "", display, 1500
    if bare in ("atlas", "axis"):
        return bare, "spine", "", display, 1500
    m = re.match(r"intervertebral disk of (\w+) (thoracic|lumbar) vertebra$", bare)
    if m:
        return f"disc_{m.group(2)[0]}{ORDINALS[m.group(1)]}", "spine", "", "Intervertebral disc", 200
    if bare == "sacrum":
        return "sacrum", "pelvis", "", display, 4000
    if bare == "hip bone":
        return f"hip{sfx}", "pelvis", side, display, 5000
    simple = {"clavicle": ("shoulder", 1500), "scapula": ("shoulder", 4500),
              "humerus": ("arm", 3500), "radius": ("forearm", 2500), "ulna": ("forearm", 2500),
              "femur": ("thigh", 4000), "patella": ("shin", 400), "tibia": ("shin", 3500),
              "fibula": ("shin", 2000), "talus": ("foot", 600), "calcaneus": ("foot", 800)}
    if bare in simple:
        group, budget = simple[bare]
        return f"{bare}{sfx}", group, side, display, budget
    m = re.match(r"(navicular|cuboid|medial cuneiform|intermediate cuneiform|lateral cuneiform) bone", bare)
    if m:
        return re.sub(r"\W+", "_", m.group(1)) + sfx, "foot", side, display.replace(" of foot", ""), 400
    return None


def fetch(rel: str) -> Path:
    path = CACHE / rel
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(f"{BASE}/{rel}") as r:
            path.write_bytes(r.read())
    return path


def load_bone(fma: str, budget: int):
    mesh = trimesh.load(fetch(f"stl/{fma}.stl"), force="mesh")
    v = np.asarray(mesh.vertices, dtype=np.float64)
    f = np.asarray(mesh.faces, dtype=np.int64)
    # BodyParts3D: mm, +x left, +y posterior, +z up  ->  cm, +x left, +y up, +z anterior
    v = np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=1) / 10.0
    if len(f) > budget:
        v, f = fast_simplification.simplify(v.astype(np.float32), f, target_count=budget)
    return np.asarray(v, dtype=np.float32), np.asarray(f, dtype=np.uint32)


def principal_ends(v: np.ndarray):
    """End points of the bone along its principal axis, higher end first."""
    c = v.mean(0)
    _, _, vt = np.linalg.svd(v - c, full_matrices=False)
    t = (v - c) @ vt[0]
    a, b = c + vt[0] * t.max(), c + vt[0] * t.min()
    return (a, b) if a[1] >= b[1] else (b, a)


def write_glb(path: Path, bones: list[dict]):
    blob = bytearray()
    views, accessors, meshes, nodes = [], [], [], []

    def push(data: bytes, target: int) -> int:
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), "target": target})
        blob.extend(data)
        return len(views) - 1

    for bone in bones:
        v, f = bone["v"], bone["f"]
        small = len(v) < 65536
        idx = f.astype(np.uint16 if small else np.uint32)
        accessors.append({"bufferView": push(v.tobytes(), 34962), "componentType": 5126,
                          "count": len(v), "type": "VEC3",
                          "min": v.min(0).tolist(), "max": v.max(0).tolist()})
        accessors.append({"bufferView": push(idx.tobytes(), 34963),
                          "componentType": 5123 if small else 5125,
                          "count": int(idx.size), "type": "SCALAR"})
        meshes.append({"primitives": [{"attributes": {"POSITION": len(accessors) - 2},
                                       "indices": len(accessors) - 1}]})
        nodes.append({"name": bone["key"], "mesh": len(meshes) - 1})
    while len(blob) % 4:
        blob.append(0)
    doc = {"asset": {"version": "2.0", "generator": "anatomy-xray build_human_assets.py",
                     "copyright": "BodyParts3D, (c) The Database Center for Life Science, CC BY-SA 2.1 JP"},
           "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
           "nodes": nodes, "meshes": meshes, "accessors": accessors,
           "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(blob)))
        fh.write(struct.pack("<I4s", len(js), b"JSON") + js)
        fh.write(struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob))


def skull_fit(by_key: dict) -> dict:
    """Similarity transform from anatomical space to MediaPipe's canonical face.

    Matches two midline bone points (nasion, menton) to canonical face
    landmarks 168 and 152 moved inward by typical soft tissue depth.
    """
    nasal = np.concatenate([by_key["nasal_L"]["v"], by_key["nasal_R"]["v"]])
    top = nasal[nasal[:, 1] > np.quantile(nasal[:, 1], 0.95)]
    nasion = top.mean(0)
    man = by_key["mandible"]["v"]
    mid = man[np.abs(man[:, 0] - nasion[0]) < 0.8]
    menton = mid[mid[:, 1] < np.quantile(mid[:, 1], 0.03)].mean(0)

    tgt_nasion = np.array([0.0, 3.27, 5.24 - 0.65])
    tgt_menton = np.array([0.0, -9.40 + 0.70, 4.26 - 0.35])
    src, tgt = (menton - nasion)[1:], (tgt_menton - tgt_nasion)[1:]
    s = np.linalg.norm(tgt) / np.linalg.norm(src)
    ang = np.arctan2(tgt[1], tgt[0]) - np.arctan2(src[1], src[0])  # in the (y, z) plane
    c, sn = np.cos(ang), np.sin(ang)
    rot = np.array([[1, 0, 0], [0, c, -sn], [0, sn, c]])
    m = np.eye(4)
    m[:3, :3] = rot * s
    m[:3, 3] = tgt_nasion - m[:3, :3] @ np.array([nasion[0], nasion[1], nasion[2]])

    # Jaw hinge: the two condyles (top, posterior part of each mandible half).
    hinge = []
    for sign in (1, -1):
        half = man[(man[:, 0] - nasion[0]) * sign > 2.0]
        high = half[half[:, 1] > np.quantile(half[:, 1], 0.90)]
        cond = high[high[:, 2] <= np.median(high[:, 2])]
        hinge.append(cond.mean(0).round(3).tolist())

    zyg = np.concatenate([by_key["zygomatic_L"]["v"], by_key["zygomatic_R"]["v"]])
    width = (zyg[:, 0].max() - zyg[:, 0].min()) * s
    print(f"skull fit: scale {s:.3f}, pitch {np.degrees(ang):.1f} deg, "
          f"bizygomatic {width:.1f} cm (canonical face is 15.3 cm skin to skin)")
    return {"fit": m.T.flatten().round(5).tolist(), "jawHinge": hinge}  # column-major


def rest_joints(by_key: dict, mid_x: float) -> dict:
    """Rest-pose positions of the body joints MediaPipe Pose reports."""
    def ext(v, axis, q, top):
        lim = np.quantile(v[:, axis], 1 - q if top else q)
        return v[v[:, axis] >= lim] if top else v[v[:, axis] <= lim]

    joints = {}
    for s in ("L", "R"):
        v = lambda key: by_key[f"{key}_{s}"]["v"].astype(np.float64)
        hum, fem, tib = v("humerus"), v("femur"), v("tibia")
        head = ext(fem, 1, 0.08, True)
        medial = head[np.argsort(np.abs(head[:, 0] - mid_x))[: len(head) // 2]]
        pts = {
            "shoulder": ext(hum, 1, 0.04, True).mean(0),
            "elbow": ext(hum, 1, 0.04, False).mean(0),
            "wrist": np.mean([v(k).mean(0) for k in ("scaphoid", "lunate", "triquetral")], axis=0),
            "hip": medial.mean(0),
            "knee": (ext(fem, 1, 0.03, False).mean(0) + ext(tib, 1, 0.03, True).mean(0)) / 2,
            "ankle": v("talus").mean(0),
            "heel": ext(v("calcaneus"), 2, 0.05, False).mean(0),
            "toe": ext(v("tdp1"), 2, 0.10, True).mean(0),
        }
        for name, p in pts.items():
            joints[f"{name}_{s}"] = np.round(p, 3).tolist()
    return joints


def main():
    rows = [line.rstrip("\n").split("\t") for line in open(fetch("parts_list_e.txt"))][1:]
    wanted = {}
    for fma, name in rows:
        info = classify(name)
        if info and info[0] not in wanted:
            wanted[info[0]] = (fma, *info)
    print(f"{len(wanted)} bones selected")

    def work(item):
        fma, key, group, side, display, budget = item
        try:
            v, f = load_bone(fma, budget)
        except Exception as err:  # some listed parts have no mesh
            print(f"  skipped {key} ({fma}): {err}", file=sys.stderr)
            return None
        return {"key": key, "fma": fma, "group": group, "side": side, "name": display, "v": v, "f": f}

    with ThreadPoolExecutor(8) as pool:
        bones = [b for b in pool.map(work, wanted.values()) if b]
    bones.sort(key=lambda b: (b["group"], b["key"]))
    by_key = {b["key"]: b for b in bones}

    cranium = np.concatenate([b["v"] for b in bones if b["group"] == "cranium"])
    skull_centre = (cranium.min(0) + cranium.max(0)) / 2
    mid_x = float(by_key["nasal_L"]["v"][:, 0].min() + by_key["nasal_R"]["v"][:, 0].max()) / 2
    manifest = {"credit": "BodyParts3D, (c) The Database Center for Life Science, "
                          "licensed under CC Attribution-Share Alike 2.1 Japan",
                "units": "cm", "skull": {**skull_fit(by_key), "midX": round(mid_x, 3)},
                "joints": rest_joints(by_key, mid_x), "bones": {}}
    for b in bones:
        v = b["v"].astype(np.float64)
        a, e = principal_ends(v)
        c = v.mean(0)
        if b["group"] in ("cranium", "jaw"):
            if b["key"] in CENTRAL_ANCHOR:
                # Midline bones get a label point on the subject's left half;
                # the app mirrors it when the right half is revealed.
                half = v[v[:, 0] > mid_x + 1.0]
                anchor = half[np.argmax(half @ np.array(CENTRAL_ANCHOR[b["key"]]))]
            else:
                d = c - skull_centre
                d[2] += 0.35 * np.linalg.norm(d)  # prefer points visible from the front
                anchor = v[np.argmax(v @ d)]
        else:
            anchor = v[np.argmin(np.linalg.norm(v - c, axis=1))]
        manifest["bones"][b["key"]] = {
            "name": b["name"], "group": b["group"], "side": b["side"],
            "a": a.round(3).tolist(), "b": e.round(3).tolist(),
            "c": c.round(3).tolist(), "anchor": anchor.round(3).tolist(),
        }

    OUT.mkdir(parents=True, exist_ok=True)
    write_glb(OUT / "human.glb", bones)
    (OUT / "human.json").write_text(json.dumps(manifest, separators=(",", ":")))
    tris = sum(len(b["f"]) for b in bones)
    size = (OUT / "human.glb").stat().st_size / 1e6
    groups = {}
    for b in bones:
        groups[b["group"]] = groups.get(b["group"], 0) + 1
    print(f"wrote {len(bones)} bones, {tris} triangles, {size:.1f} MB: {groups}")


if __name__ == "__main__":
    main()
