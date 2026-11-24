"""Build frontend/public/models/human/systems.glb and systems.json: heart, vessels, nerves.

The heart, great vessels, lungs and brain are BodyParts3D meshes. BodyParts3D
has no meshes for the vessels and nerves of the limbs, neck, face and chest
wall, so those are routed here along the skeleton, following their textbook
course, and written as centre lines that the app turns into tubes.

Every vertex and centre-line sample is bound to up to two skeleton segments
(the groups of bones the rigs move as one), so the soft tissue follows the
tracked body. Each also carries a flow distance: centimetres along its network
from the heart (vessels) or the brainstem (nerves), which drives the blood
flow and nerve signal animation.

Run after build_human_assets.py (it reads human.json):

    .venv/bin/python tools/build_systems.py

Source meshes: BodyParts3D, (c) The Database Center for Life Science, licensed
under CC Attribution-Share Alike 2.1 Japan. The output carries the same licence.
"""

from __future__ import annotations

import json
import re
import struct
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_human_assets as bh  # noqa: E402

OUT = bh.OUT
NECK = ["atlas", "axis", "c3", "c4", "c5", "c6", "c7"]
LUMBAR = ["l1", "l2", "l3", "l4", "l5"]
CHEST = "body_of_sternum"
HEAD = "frontal"
JAW = "mandible"
PELVIS = "sacrum"
BLEND = 2.0  # cm: how far apart two bones must be before a vertex follows only the nearer one

# Soft-tissue meshes: key, FMA id, render group, triangle budget, bones to follow, flow network, root.
# A root vessel starts at the heart; the others start where they meet a vessel built before them.
MESHES = [
    ("heart", "FMA7274", "heart", 9000, "chest", None, False),
    ("ascending_aorta", "FMA3736", "artery", 700, "chest", "art", True),
    ("aortic_arch", "FMA3768", "artery", 1000, "chest", "art", False),
    ("descending_aorta", "FMA3784", "artery", 2600, "trunk", "art", False),
    ("brachiocephalic_artery", "FMA3932nsn", "artery", 400, "chest", "art", False),
    ("common_carotid_R", "FMA3941", "artery", 500, "neck", "art", False),
    ("subclavian_artery_R", "FMA3953", "artery", 500, "chest", "art", False),
    ("common_carotid_L", "FMA4058", "artery", 400, "neck", "art", False),
    ("subclavian_artery_L", "FMA4694", "artery", 500, "chest", "art", False),
    ("celiac_artery", "FMA50737", "artery", 200, "trunk", "art", False),
    ("common_hepatic_artery", "FMA14771", "artery", 300, "trunk", "art", False),
    ("splenic_artery", "FMA14773", "artery", 400, "trunk", "art", False),
    ("left_gastric_artery", "FMA14768", "artery", 200, "trunk", "art", False),
    ("superior_mesenteric_artery", "FMA14749", "artery", 200, "trunk", "art", False),
    ("inferior_mesenteric_artery", "FMA14750", "artery", 200, "trunk", "art", False),
    ("renal_artery_R", "FMA14752", "artery", 400, "trunk", "art", False),
    ("renal_artery_L", "FMA14753", "artery", 400, "trunk", "art", False),
    ("common_iliac_artery_R", "FMA14765", "artery", 300, "pelvis", "art", False),
    ("common_iliac_artery_L", "FMA14766", "artery", 300, "pelvis", "art", False),
    ("external_iliac_artery_R", "FMA18806", "artery", 400, "pelvis", "art", False),
    ("external_iliac_artery_L", "FMA18807", "artery", 400, "pelvis", "art", False),
    ("internal_iliac_artery_R", "FMA18809", "artery", 300, "pelvis", "art", False),
    ("internal_iliac_artery_L", "FMA18810", "artery", 300, "pelvis", "art", False),
    ("left_coronary_artery", "FMA4685", "artery", 120, "chest", "art", False),
    ("right_coronary_artery", "FMA3802", "artery", 700, "chest", "art", False),
    ("anterior_interventricular_artery", "FMA3862nsn", "artery", 900, "chest", "art", False),
    ("circumflex_artery", "FMA3895", "artery", 500, "chest", "art", False),
    ("marginal_artery", "FMA3818", "artery", 300, "chest", "art", False),
    ("posterior_interventricular_artery", "FMA3840nsn", "artery", 300, "chest", "art", False),
    ("superior_vena_cava", "FMA4720", "vein", 400, "chest", "vein", True),
    ("inferior_vena_cava", "FMA10951", "vein", 1200, "trunk", "vein", True),
    ("brachiocephalic_vein_R", "FMA4751", "vein", 400, "chest", "vein", False),
    ("brachiocephalic_vein_L", "FMA4761", "vein", 500, "chest", "vein", False),
    ("internal_jugular_vein_R", "FMA4754", "vein", 300, "neck", "vein", False),
    ("internal_jugular_vein_L", "FMA4762", "vein", 300, "neck", "vein", False),
    ("subclavian_vein_R", "FMA4755", "vein", 400, "chest", "vein", False),
    ("subclavian_vein_L", "FMA4763", "vein", 400, "chest", "vein", False),
    ("renal_vein_R", "FMA14335", "vein", 400, "trunk", "vein", False),
    ("renal_vein_L", "FMA14336", "vein", 300, "trunk", "vein", False),
    ("common_iliac_vein_R", "FMA21387", "vein", 300, "pelvis", "vein", False),
    ("common_iliac_vein_L", "FMA21388", "vein", 300, "pelvis", "vein", False),
    ("external_iliac_vein_R", "FMA18885", "vein", 400, "pelvis", "vein", False),
    ("external_iliac_vein_L", "FMA18886", "vein", 400, "pelvis", "vein", False),
    ("internal_iliac_vein_R", "FMA18887", "vein", 300, "pelvis", "vein", False),
    ("internal_iliac_vein_L", "FMA18888", "vein", 300, "pelvis", "vein", False),
    ("great_cardiac_vein", "FMA4707", "vein", 700, "chest", "vein", False),
    ("posterior_veins_of_left_ventricle", "FMA76751", "vein", 300, "chest", "vein", False),
    # Pulmonary circulation: blue blood out to the lungs, red blood back.
    ("pulmonary_artery", "FMA66326", "partery", 9000, "chest", "partery", True),
    ("pulmonary_veins", "FMA66643", "pvein", 7000, "chest", "pvein", True),
    ("lung_upper_R", "FMA7333", "lung", 1600, "chest", None, False),
    ("lung_middle_R", "FMA7383", "lung", 1200, "chest", None, False),
    ("lung_lower_R", "FMA7337", "lung", 1800, "chest", None, False),
    ("lung_upper_L", "FMA7370", "lung", 1800, "chest", None, False),
    ("lung_lower_L", "FMA7371", "lung", 1800, "chest", None, False),
    ("trachea", "FMA7394", "lung", 700, "neck", None, False),
    ("bronchi", "FMA7409", "lung", 5000, "chest", None, False),
    # Central nervous system.
    ("cerebrum", "FMA61822", "brain", 9000, "head", None, False),
    ("cerebellum", "FMA67944", "brain", 5000, "head", None, False),
    ("midbrain", "FMA61993nsn", "brain", 800, "head", None, False),
    ("pons", "FMA67943", "brain", 1200, "head", None, False),
    ("medulla", "FMA62004", "brain", 900, "head", None, False),
    ("lateral_ventricle_R", "FMA78449", "csf", 1000, "head", None, False),
    ("lateral_ventricle_L", "FMA78450", "csf", 1000, "head", None, False),
    ("third_ventricle", "FMA78454", "csf", 400, "head", None, False),
    ("fourth_ventricle", "FMA78469", "csf", 400, "head", None, False),
    ("optic_nerve_R", "FMA50875", "nerve", 300, "head", "nerve", True),
    ("optic_nerve_L", "FMA50878", "nerve", 300, "head", "nerve", True),
]
NETWORK = {"artery": "art", "vein": "vein", "nerve": "nerve"}


# ------------------------------------------------------------------ skeleton

def seg_of(key: str, group: str) -> str | None:
    """The segment (named after one of its bones) that the rigs move a bone with."""
    side = key[-2:] if key[-2:] in ("_L", "_R") else ""
    if group == "cranium":
        return HEAD
    if group == "jaw":
        return JAW
    if group in ("thorax", "shoulder") or re.match(r"^(t\d+|disc_t\d+)$", key):
        return CHEST
    if group == "pelvis":
        return PELVIS
    m = re.match(r"^(?:disc_)?(l\d)$", key)
    if m:
        return m.group(1)
    if key in NECK:
        return key
    limb = {"arm": "humerus", "forearm": "radius", "thigh": "femur", "shin": "tibia", "foot": "calcaneus"}
    if group in limb:
        return limb[group] + side
    if group == "hand":
        return "capitate" + side if key[:-2] in bh.CARPALS else key
    return None


def load_bones() -> dict:
    rows = [line.rstrip("\n").split("\t") for line in open(bh.fetch("parts_list_e.txt"))][1:]
    wanted = {}
    for fma, name in rows:
        info = bh.classify(name)
        if info and info[0] not in wanted:
            wanted[info[0]] = (fma, *info)

    def work(item):
        fma, key, group, side, _display, budget = item
        try:
            v, f = bh.load_bone(fma, budget)
        except Exception:
            return None
        v = v.astype(np.float64)
        a, b = bh.principal_ends(v)
        return key, {"group": group, "v": v, "f": f, "a": a, "b": b, "c": v.mean(0)}

    with ThreadPoolExecutor(8) as pool:
        return dict(x for x in pool.map(work, wanted.values()) if x)


# ------------------------------------------------------------------ geometry helpers

def edges_graph(v: np.ndarray, f: np.ndarray):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]).astype(np.int64)
    w = np.linalg.norm(v[e[:, 0]] - v[e[:, 1]], axis=1) + 1e-6
    n = len(v)
    return coo_matrix((np.concatenate([w, w]), (np.concatenate([e[:, 0], e[:, 1]]),
                                                np.concatenate([e[:, 1], e[:, 0]]))), shape=(n, n)).tocsr()


def centre_line(v: np.ndarray, f: np.ndarray, step: float = 1.0) -> np.ndarray:
    """Centre line of a tube-shaped mesh (a rib), from its most posterior end."""
    g = edges_graph(v, f)
    _, labels = connected_components(g, directed=False)
    main = np.argmax(np.bincount(labels))
    idx = np.flatnonzero(labels == main)
    d0 = dijkstra(g, indices=idx[0])
    e1 = idx[np.argmax(d0[idx])]
    d1 = dijkstra(g, indices=e1)
    e2 = idx[np.argmax(d1[idx])]
    if v[e2, 2] < v[e1, 2]:  # start at the posterior (vertebral) end
        e1 = e2
        d1 = dijkstra(g, indices=e1)
    dist = d1[idx]
    bins = np.floor(dist / step).astype(int)
    pts = np.array([v[idx[bins == k]].mean(0) for k in range(bins.max() + 1) if np.any(bins == k)])
    # Light smoothing; keep the ends.
    sm = pts.copy()
    sm[1:-1] = (pts[:-2] + 2 * pts[1:-1] + pts[2:]) / 4
    return sm


def catmull_rom(points: np.ndarray, spacing: float):
    """Centripetal Catmull-Rom through the points; returns samples and their control-point parameter."""
    P = np.asarray(points, dtype=np.float64)
    if len(P) < 2:
        raise ValueError("a path needs two points")
    ext = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    pts, us = [], []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1:i + 3]
        t0 = 0.0
        t1 = t0 + max(np.linalg.norm(p1 - p0), 1e-4) ** 0.5
        t2 = t1 + max(np.linalg.norm(p2 - p1), 1e-4) ** 0.5
        t3 = t2 + max(np.linalg.norm(p3 - p2), 1e-4) ** 0.5
        n = max(2, int(np.ceil(np.linalg.norm(p2 - p1) / spacing)))
        for k in range(n):
            t = t1 + (t2 - t1) * k / n
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            pts.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
            us.append(i - 1 + k / n)
    pts.append(P[-1])
    us.append(len(P) - 1)
    return np.array(pts), np.array(us)


# ------------------------------------------------------------------ the build

class Builder:
    def __init__(self):
        manifest = json.loads((OUT / "human.json").read_text())
        self.mid = manifest["skull"]["midX"]
        self.hinge = [np.array(p) for p in manifest["skull"]["jawHinge"]]  # [subject left, subject right]
        print("loading bones")
        self.bones = load_bones()
        self.segments: list[str] = []
        clouds: dict[str, list] = {}
        for key, b in self.bones.items():
            s = seg_of(key, b["group"])
            if s is None:
                continue
            if s not in self.segments:
                self.segments.append(s)
            clouds.setdefault(s, []).append(b["v"])
        self.seg_tree = {s: cKDTree(np.concatenate(c)) for s, c in clouds.items()}
        head = [b["v"] for b in self.bones.values() if b["group"] in ("cranium", "jaw")]
        self.head_pts = np.concatenate(head)
        self.canal = self.find_canal()
        self.meshes: dict[str, dict] = {}
        self.groups: dict[str, list] = {}
        self.paths: list[dict] = []
        self.labels: list[dict] = []
        # Flow networks: points already built and their flow distances.
        self.net: dict[str, tuple[list, list]] = {k: ([], []) for k in ("art", "vein", "partery", "pvein", "nerve")}

    # ---- bindings
    def seg(self, key: str) -> dict:
        return {seg_of(key, self.bones[key]["group"]): 1.0}

    def spine_bind(self, y: float) -> dict:
        """Binding for a point beside the spine at height y: the nearest two vertebrae."""
        levels = sorted(((self.canal[k][1], seg_of(k, self.bones[k]["group"])) for k in self.canal), reverse=True)
        if y >= levels[0][0]:
            return {levels[0][1]: 1.0}
        for (y0, s0), (y1, s1) in zip(levels, levels[1:]):
            if y1 <= y <= y0:
                w = (y - y1) / (y0 - y1)
                out = {s0: w}
                out[s1] = out.get(s1, 0) + 1 - w
                return out
        return {PELVIS: 1.0}

    def auto_bind(self, pts: np.ndarray, cands: list[str]):
        dist = np.stack([self.seg_tree[c].query(pts)[0] for c in cands], 1)
        order = np.argsort(dist, 1)
        rows = np.arange(len(pts))
        i0 = order[:, 0]
        i1 = order[:, 1] if len(cands) > 1 else i0
        d0, d1 = dist[rows, i0], dist[rows, i1]
        w = 0.5 + 0.5 * np.clip((d1 - d0) / BLEND, 0, 1)
        idx = np.array([self.segments.index(c) for c in cands])
        return np.stack([idx[i0], idx[i1]], 1).astype(np.float32), w.astype(np.float32)

    def cands(self, name: str) -> list[str]:
        return {
            "chest": [CHEST],
            "head": [HEAD],
            "neck": [CHEST, "c7", "c6", "c5", "c4", "c3"],
            "trunk": [CHEST, *LUMBAR, PELVIS],
            "pelvis": ["l4", "l5", PELVIS],
        }[name]

    # ---- landmarks
    def find_canal(self) -> dict:
        """Centre of the vertebral canal at each vertebra: the gap in the midline behind the body."""
        out = {}
        for key in [*NECK, *[f"t{i}" for i in range(1, 13)], *LUMBAR]:
            v = self.bones[key]["v"]
            band = v[np.abs(v[:, 0] - self.mid) < 0.6]
            yc = np.median(band[:, 1])
            band = band[np.abs(band[:, 1] - yc) < 1.0]
            z = np.sort(band[:, 2])
            i = np.argmax(np.diff(z))
            zc = (z[i] + z[i + 1]) / 2
            if key == "atlas":
                zc = z[i] + 0.9  # the dens fills the front of the atlas ring
            out[key] = np.array([self.mid, self.bones[key]["c"][1], zc])
        return out

    def canal_at(self, y: float) -> np.ndarray:
        keys = sorted(self.canal, key=lambda k: -self.canal[k][1])
        ys = np.array([self.canal[k][1] for k in keys])
        zs = np.array([self.canal[k][2] for k in keys])
        return np.array([self.mid, y, np.interp(-y, -ys, zs)])

    def ax(self, key: str, t: float) -> np.ndarray:
        b = self.bones[key]
        return b["a"] + (b["b"] - b["a"]) * t

    def surface(self, pts: np.ndarray, centre: np.ndarray, axes: tuple[int, int], out_axis: int, sign: float,
                depth: float, r: float = 0.5) -> np.ndarray:
        """Point on the outside of a bone cloud along one axis, pushed `depth` cm further out."""
        a, b = axes
        near = pts[(np.abs(pts[:, a] - centre[a]) < r) & (np.abs(pts[:, b] - centre[b]) < r)]
        if len(near) == 0:
            raise ValueError(f"no surface near {centre}")
        p = centre.copy()
        p[out_axis] = (near[:, out_axis].max() if sign > 0 else near[:, out_axis].min()) + sign * depth
        return p

    def mesh_end(self, key: str, direction) -> np.ndarray:
        """Centre of the end of a vessel mesh that points in `direction`."""
        v = self.meshes[key]["v"]
        d = np.asarray(direction, float)
        d /= np.linalg.norm(d)
        s = v @ d
        return v[s > s.max() - 0.5].mean(0)

    # ---- meshes
    def add_mesh(self, key, fma, group, budget, cand, net, root):
        v, f = fma if isinstance(fma, tuple) else bh.load_bone(fma, budget)
        v = v.astype(np.float64)
        f = f.astype(np.int64)
        segs, w = self.auto_bind(v, self.cands(cand))
        flow = np.zeros(len(v))
        if net:
            g = edges_graph(v, f)
            n_comp, comp = connected_components(g, directed=False)
            if root:
                ref = self.meshes["heart"]["v"] if net != "nerve" else self.brain_cloud()
                ref_d = np.zeros(len(ref))
            else:
                ref, ref_d = (np.array(x) for x in self.net[net])
            tree = cKDTree(ref)
            dist, near = tree.query(v)
            for c in range(n_comp):
                ids = np.flatnonzero(comp == c)
                m = dist[ids].min()
                src = ids[dist[ids] <= m + 0.6]
                offset = ref_d[near[ids[np.argmin(dist[ids])]]] + m
                g_d = dijkstra(g, indices=src, min_only=True)
                flow[ids] = offset + g_d[ids]
            flow[~np.isfinite(flow)] = 0
            self.net[net][0].extend(v.tolist())
            self.net[net][1].extend(flow.tolist())
        if group == "brain":  # nerve signals are timed from the brain
            self.net["nerve"][0].extend(v.tolist())
            self.net["nerve"][1].extend([0.0] * len(v))
        self.meshes[key] = {"v": v, "f": f, "group": group}
        self.groups.setdefault(group, []).append({"v": v, "f": f, "segs": segs, "w": w, "flow": flow})

    def add_cortex(self):
        """A smooth outer surface for each cerebral hemisphere.

        BodyParts3D's cerebrum is the folded white matter; its rounded hull per
        side stands in for the cortex, so the brain reads as two hemispheres.
        """
        cv = self.meshes["cerebrum"]["v"]
        for side, sel in (("L", cv[:, 0] > self.mid + 0.15), ("R", cv[:, 0] < self.mid - 0.15)):
            hull = trimesh.convex.convex_hull(cv[sel])
            v, f = trimesh.remesh.subdivide_to_size(hull.vertices, hull.faces, max_edge=1.0)
            m = trimesh.Trimesh(v, f, process=True)
            trimesh.smoothing.filter_taubin(m, iterations=30)
            self.add_mesh(f"hemisphere_{side}", (np.asarray(m.vertices, np.float64), np.asarray(m.faces, np.int64)),
                          "cortex", 0, "head", None, False)

    def brain_cloud(self) -> np.ndarray:
        return np.concatenate([self.meshes[k]["v"] for k in ("medulla", "pons", "midbrain", "cerebrum")])

    def mesh_label(self, key: str, text: str, layer: str, entity: str, toward=None):
        v = self.meshes[key]["v"]
        c = v.mean(0)
        if toward is None:
            p = v[np.argmin(np.linalg.norm(v - c, axis=1))]
        else:
            p = v[np.argmax(v @ np.asarray(toward, float))]
        group = self.meshes[key]["group"]
        segs, w = self.auto_bind(p[None], self.cands({"brain": "head", "csf": "head", "cortex": "head"}.get(group, "chest"))
                                 if group in ("brain", "csf", "cortex", "heart", "lung", "partery", "pvein") else
                                 self.cands("trunk"))
        self.labels.append({"t": text, "g": group, "l": layer, "e": entity, "p": np.round(p, 2).tolist(),
                            "s": [int(segs[0, 0]), int(segs[0, 1]), round(float(w[0]), 3)]})

    # ---- paths
    def path(self, group: str, pts: list, r, label: tuple | None = None, spacing: float = 0.6, tone: float = 1.0):
        """A vessel or nerve through control points [(position, binding), ...]; `tone` dims minor ones."""
        P = np.array([p for p, _ in pts])
        binds = [b for _, b in pts]
        samples, us = catmull_rom(P, spacing)
        keep = np.concatenate([[True], np.linalg.norm(np.diff(samples, axis=0), axis=1) > 0.05])
        samples, us = samples[keep], us[keep]
        radii = np.atleast_1d(np.asarray(r, float))
        if len(radii) == 1:
            radii = np.repeat(radii, len(P))
        elif len(radii) == 2 and len(P) != 2:
            radii = np.interp(np.arange(len(P)), [0, len(P) - 1], radii)
        rs, sg = [], []
        for u in us:
            j = min(int(np.floor(u)), len(P) - 2)
            t = u - j
            rs.append(radii[j] * (1 - t) + radii[j + 1] * t)
            mix: dict[str, float] = {}
            for k, val in binds[j].items():
                mix[k] = mix.get(k, 0) + val * (1 - t)
            for k, val in binds[j + 1].items():
                mix[k] = mix.get(k, 0) + val * t
            top = sorted(mix.items(), key=lambda kv: -kv[1])[:2]
            if len(top) == 1 or top[1][1] < 1e-3:
                sg.append([self.segments.index(top[0][0])] * 2 + [1.0])
            else:
                tot = top[0][1] + top[1][1]
                sg.append([self.segments.index(top[0][0]), self.segments.index(top[1][0]), top[0][1] / tot])
        net = NETWORK[group]
        seg_len = np.linalg.norm(np.diff(samples, axis=0), axis=1)
        arc = np.concatenate([[0], np.cumsum(seg_len)])
        ref, ref_d = self.net[net]
        if ref:
            dist, near = cKDTree(np.array(ref)).query(samples[0])
            offset = ref_d[near] + dist
        else:
            offset = 0.0
        flow = offset + arc
        self.net[net][0].extend(samples.tolist())
        self.net[net][1].extend(flow.tolist())
        self.paths.append({
            **({"k": tone} if tone != 1.0 else {}),
            "g": group,
            "p": np.round(samples, 2).ravel().tolist(),
            "r": np.round(rs, 3).tolist(),
            "s": [round(x, 3) if i % 3 == 2 else int(x) for row in sg for i, x in enumerate(row)],
            "d": np.round(flow, 1).tolist(),
        })
        if label:
            text, layer, entity, frac = label
            i = int(round(frac * (len(samples) - 1)))
            self.labels.append({"t": text, "g": group, "l": layer, "e": entity, "p": np.round(samples[i], 2).tolist(),
                                "s": [int(sg[i][0]), int(sg[i][1]), round(float(sg[i][2]), 3)]})

    # ---- output
    def write(self):
        OUT.mkdir(parents=True, exist_ok=True)
        blob = bytearray()
        views, accessors, meshes, nodes = [], [], [], []

        def push(data: bytes, target: int | None) -> int:
            while len(blob) % 4:
                blob.append(0)
            view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
            if target:
                view["target"] = target
            views.append(view)
            blob.extend(data)
            return len(views) - 1

        def accessor(arr: np.ndarray, kind: str, comp: int, target: int, minmax=False) -> int:
            acc = {"bufferView": push(arr.tobytes(), target), "componentType": comp,
                   "count": int(arr.shape[0] if arr.ndim > 1 else arr.size), "type": kind}
            if minmax:
                acc["min"] = arr.min(0).tolist()
                acc["max"] = arr.max(0).tolist()
            accessors.append(acc)
            return len(accessors) - 1

        stats = {}
        for group, parts in self.groups.items():
            vs, fs, segs, ws, flows = [], [], [], [], []
            base = 0
            for p in parts:
                vs.append(p["v"])
                fs.append(p["f"] + base)
                segs.append(p["segs"])
                ws.append(p["w"])
                flows.append(p["flow"])
                base += len(p["v"])
            v = np.concatenate(vs).astype(np.float32)
            f = np.concatenate(fs).astype(np.uint32)
            attrs = {
                "POSITION": accessor(v, "VEC3", 5126, 34962, True),
                "_SEGS": accessor(np.concatenate(segs).astype(np.float32), "VEC2", 5126, 34962),
                "_WEIGHT": accessor(np.concatenate(ws).astype(np.float32), "SCALAR", 5126, 34962),
                "_FLOW": accessor(np.concatenate(flows).astype(np.float32), "SCALAR", 5126, 34962),
            }
            ind = accessor(f.ravel(), "SCALAR", 5125, 34963)
            meshes.append({"primitives": [{"attributes": attrs, "indices": ind}]})
            nodes.append({"name": group, "mesh": len(meshes) - 1})
            stats[group] = len(f)
        while len(blob) % 4:
            blob.append(0)
        doc = {"asset": {"version": "2.0", "generator": "anatomy-xray build_systems.py",
                         "copyright": "BodyParts3D, (c) The Database Center for Life Science, CC BY-SA 2.1 JP"},
               "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
               "nodes": nodes, "meshes": meshes, "accessors": accessors,
               "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
        js = json.dumps(doc, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        with open(OUT / "systems.glb", "wb") as fh:
            fh.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(blob)))
            fh.write(struct.pack("<I4s", len(js), b"JSON") + js)
            fh.write(struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob))

        heart = self.meshes["heart"]["v"]
        lungs = np.concatenate([self.meshes[k]["v"] for k in self.meshes if k.startswith("lung_")])
        manifest = {
            "credit": "BodyParts3D, (c) The Database Center for Life Science, licensed under CC Attribution-Share "
                      "Alike 2.1 Japan; limb, neck, face and chest-wall vessels and nerves routed schematically",
            "segments": self.segments,
            "heart": np.round(heart.mean(0), 2).tolist(),
            "lungs": np.round((lungs.min(0) + lungs.max(0)) / 2, 2).tolist(),
            "paths": self.paths,
            "labels": self.labels,
        }
        (OUT / "systems.json").write_text(json.dumps(manifest, separators=(",", ":")))
        size = (OUT / "systems.glb").stat().st_size / 1e6
        jsize = (OUT / "systems.json").stat().st_size / 1e6
        n_samples = sum(len(p["d"]) for p in self.paths)
        by_group = {}
        for p in self.paths:
            by_group[p["g"]] = by_group.get(p["g"], 0) + 1
        print(f"wrote systems.glb {size:.1f} MB (triangles per group {stats}) and systems.json {jsize:.2f} MB "
              f"({len(self.paths)} paths {by_group}, {n_samples} samples, {len(self.labels)} labels)")


# ------------------------------------------------------------------ routes

def route_all(B: Builder):
    mid = B.mid
    seg = B.seg

    def mix(p, q, w=0.5):
        pos = p[0] * (1 - w) + q[0] * w
        out: dict[str, float] = {}
        for k, val in p[1].items():
            out[k] = out.get(k, 0) + val * (1 - w)
        for k, val in q[1].items():
            out[k] = out.get(k, 0) + val * w
        return pos, out

    def blend(*pairs):
        out: dict[str, float] = {}
        for key, w in pairs:
            out[key] = out.get(key, 0) + w
        return out

    # ---------------- spinal cord, cauda equina and spinal nerve roots
    cord_keys = [*NECK, *[f"t{i}" for i in range(1, 13)], "l1"]
    cord = [(np.array([mid, 148.9, 7.6]), {"atlas": 1.0})]
    radius = [0.5]
    for k in cord_keys:
        c = B.canal[k]
        cord.append((c, B.spine_bind(c[1])))
        n = k
        radius.append(0.62 if n in ("c5", "c6", "c7", "t1") else 0.55 if n in NECK else
                      0.52 if n in ("t11", "t12") else 0.45 if n != "l1" else 0.36)
    conus = B.canal_at(B.canal["l1"][1] - 2.3)
    cord.append((conus, B.spine_bind(conus[1])))
    radius.append(0.14)
    B.path("nerve", cord, radius, label=("Spinal cord", "nerves", "body", 0.45))

    def foramen(y: float, sg: int, lateral: float = 1.7, fwd: float = 0.5):
        c = B.canal_at(y)
        return np.array([mid + sg * lateral, y, c[2] + fwd])

    levels = {}  # nerve exit heights by root name
    for i, k in enumerate(NECK):
        y_above = B.canal[k][1] + (B.bones[k]["v"][:, 1].max() - B.canal[k][1]) * 0.15
        levels[f"C{i + 1}"] = y_above if i > 0 else 148.8
    levels["C2"] = (B.canal["atlas"][1] + B.canal["axis"][1]) / 2
    for i in range(2, 7):
        levels[f"C{i + 1}"] = (B.canal[NECK[i - 1]][1] + B.canal[NECK[i]][1]) / 2
    levels["C8"] = (B.canal["c7"][1] + B.canal["t1"][1]) / 2
    for i in range(1, 12):
        levels[f"T{i}"] = (B.canal[f"t{i}"][1] + B.canal[f"t{i + 1}"][1]) / 2
    levels["T12"] = (B.canal["t12"][1] + B.canal["l1"][1]) / 2
    for i in range(1, 5):
        levels[f"L{i}"] = (B.canal[f"l{i}"][1] + B.canal[f"l{i + 1}"][1]) / 2
    sac = B.bones["sacrum"]["v"]
    levels["L5"] = (B.canal["l5"][1] + sac[:, 1].max()) / 2 - 0.6

    def sacral_foramen(n: int, sg: int):
        """Anterior sacral foramen S1..S4 on the pelvic surface of the sacrum."""
        top, bot = sac[:, 1].max(), sac[:, 1].min()
        y = top - (top - bot) * (0.2 + 0.16 * (n - 1))
        x = mid + sg * (1.7 - 0.12 * n)
        return B.surface(sac, np.array([x, y, 0.0]), (0, 1), 2, +1, -0.4, r=0.6)

    for s, sg in (("L", 1), ("R", -1)):
        # Cervical and thoracic roots leave the cord at their own level.
        for name in [f"C{i}" for i in range(1, 9)] + [f"T{i}" for i in range(1, 13)]:
            y = levels[name]
            start = B.canal_at(y + 0.6)
            ex = foramen(y, sg, 1.9 if name.startswith("C") else 1.6)
            pts = [(start, B.spine_bind(start[1])), (ex, B.spine_bind(y))]
            if name in ("C1", "C2", "C3", "C4"):
                pts.append((ex + np.array([sg * 1.8, -0.6, 1.2]), B.spine_bind(y)))
            if name in ("C5", "C6", "C7", "C8", "T1"):
                pts.append((ex + np.array([sg * 2.2, -0.9, 1.2]), B.spine_bind(y - 0.9)))
                pts.append((np.array([mid + sg * 6.5, 137.0, 8.6]), {CHEST: 1.0}))
            if name.startswith("T"):
                n = int(name[1:])
                line = B.rib_lines[f"rib{n}_{s}"]
                inward = np.array([mid, 0, 10.0])
                for q in line[1::2]:
                    d = inward - q
                    d[1] = 0
                    d /= np.linalg.norm(d) + 1e-9
                    pts.append((q + np.array([0, -0.75, 0]) + d * 0.25, {CHEST: 1.0}))
            lab = None
            if s == "L" and name == "T7":
                lab = ("Intercostal nerves", "nerves", "body", 0.55)
            tone = 0.42 if name.startswith("T") else 0.6 if name in ("C1", "C2", "C3", "C4") else 0.8
            B.path("nerve", pts, [0.13, 0.09] if name.startswith("T") else 0.17, label=lab, tone=tone)
        # Lumbar and sacral roots run down the cauda equina first.
        for i, name in enumerate(["L1", "L2", "L3", "L4", "L5", "S1", "S2", "S3", "S4"]):
            top = conus + np.array([sg * (0.15 + 0.06 * i), 0.4, 0])
            if name.startswith("L"):
                y = levels[name]
                inside = B.canal_at(y + 1.6) + np.array([sg * (0.35 + 0.05 * i), 0, 0])
                ex = foramen(y, sg, 1.8, 0.6)
                pts = [(top, B.spine_bind(top[1])), (inside, B.spine_bind(inside[1])), (ex, B.spine_bind(y))]
            else:
                n = int(name[1:])
                f_pt = sacral_foramen(n, sg)
                inside = B.canal_at(B.canal["l5"][1] - 1.0) + np.array([sg * (0.3 + 0.07 * i), -0.5 * n, -0.4])
                pts = [(top, B.spine_bind(top[1])), (inside, {"l5": 0.5, PELVIS: 0.5}),
                       (f_pt + np.array([0, 0, -0.9]), {PELVIS: 1.0}), (f_pt, {PELVIS: 1.0})]
            B.path("nerve", pts, 0.12, tone=0.55)

    # Rib landmarks for the intercostal vessels and nerves are built in B.rib_lines.

    # ---------------- neck and head vessels and nerves
    def face(dx: float, y: float, depth: float = 0.7, sg: int = 1):
        return B.surface(B.head_pts, np.array([mid + sg * dx, y, 0.0]), (0, 1), 2, +1, depth)

    def side(y: float, z: float, depth: float = 0.6, sg: int = 1):
        return B.surface(B.head_pts, np.array([0.0, y, z]), (1, 2), 0, sg, depth * 1.0)

    def crown(dx: float, z: float, depth: float, sg: int = 1):
        return B.surface(B.head_pts, np.array([mid + sg * dx, 0.0, z]), (0, 2), 1, +1, depth)

    def back(dx: float, y: float, depth: float, sg: int = 1):
        return B.surface(B.head_pts, np.array([mid + sg * dx, y, 0.0]), (0, 1), 2, -1, depth)

    head = {HEAD: 1.0}
    jaw = {JAW: 1.0}
    nb = B.spine_bind

    def M(dx, y, z, sg):
        return np.array([mid + sg * dx, y, z])

    for s, sg in (("L", 1), ("R", -1)):
        cca_top = B.mesh_end(f"common_carotid_{s}", [0, 1, 0])
        bif = M(2.4, 143.7, cca_top[2] + 0.3, sg)
        B.path("artery", [(cca_top, nb(cca_top[1])), (M(2.3, 141.0, cca_top[2] + 0.2, sg), nb(141.0)), (bif, nb(143.7))],
               0.42, label=("Carotid artery", "blood", "body", 0.6) if s == "L" else None)
        # Internal carotid: up the neck, through the skull base, to the brain.
        ica_pts = [(bif, nb(143.7)), (M(2.7, 146.2, bif[2] - 0.9, sg), nb(146.2)),
                   (M(2.6, 148.6, 9.3, sg), {"atlas": 0.5, HEAD: 0.5}), (M(2.2, 150.2, 10.4, sg), head),
                   (M(1.6, 151.4, 11.4, sg), head), (M(1.5, 152.6, 11.5, sg), head), (M(1.4, 153.0, 11.9, sg), head)]
        B.path("artery", ica_pts, [0.3, 0.26])
        term = M(1.4, 153.0, 11.9, sg)
        # Middle cerebral artery out along the lateral sulcus and over the hemisphere.
        B.path("artery", [(term, head), (M(3.4, 153.4, 11.3, sg), head), (M(5.0, 154.6, 10.4, sg), head),
                          (M(5.5, 157.2, 11.2, sg), head), (M(5.2, 159.6, 9.6, sg), head)], [0.22, 0.12])
        B.path("artery", [(M(5.0, 154.6, 10.4, sg), head), (M(5.6, 155.0, 7.8, sg), head),
                          (M(5.5, 156.2, 4.8, sg), head)], [0.16, 0.1])
        # Anterior cerebral artery over the corpus callosum.
        B.path("artery", [(term, head), (M(0.35, 153.7, 13.0, sg), head), (M(0.35, 155.9, 15.0, sg), head),
                          (M(0.35, 158.6, 12.6, sg), head), (M(0.35, 159.4, 8.2, sg), head),
                          (M(0.35, 158.0, 4.2, sg), head)], [0.2, 0.1])
        # Vertebral artery up the transverse foramina to the basilar artery.
        sub = B.meshes[f"subclavian_artery_{s}"]["v"]
        origin = sub[np.argmin(np.abs(sub[:, 0] - (mid + sg * 2.6)) + np.abs(sub[:, 1] - 136.6))]
        vpts = [(origin, {CHEST: 1.0})]
        for k in ["c6", "c5", "c4", "c3", "axis"]:
            c = B.bones[k]["c"]
            vpts.append((np.array([mid + sg * 2.3, c[1], c[2] + 0.6]), {seg_of(k, "spine"): 1.0}))
        a = B.bones["atlas"]["c"]
        vpts += [(np.array([mid + sg * 3.2, a[1], a[2] + 0.2]), {"atlas": 1.0}),
                 (np.array([mid + sg * 2.6, a[1] + 0.5, a[2] - 1.6]), {"atlas": 1.0}),
                 (M(1.1, 149.4, 7.9, sg), {"atlas": 0.4, HEAD: 0.6}), (M(0.25, 151.0, 10.7, sg), head)]
        B.path("artery", vpts, 0.2)
        # Posterior cerebral artery around the midbrain.
        B.path("artery", [(M(0.1, 153.7, 11.0, sg), head), (M(1.1, 154.0, 10.8, sg), head),
                          (M(2.6, 154.3, 9.0, sg), head), (M(3.6, 155.0, 4.6, sg), head), (M(3.0, 155.6, 2.0, sg), head)],
               [0.18, 0.1])
        # External carotid and its face and scalp branches.
        eca = M(2.9, 145.6, bif[2] + 0.7, sg)
        B.path("artery", [(bif, nb(143.7)), (eca, nb(145.6)), (M(4.2, 147.6, 11.0, sg), {JAW: 0.5, HEAD: 0.5}),
                          (side(150.6, 10.4, 0.5, sg), head), (side(153.6, 11.0, 0.5, sg), head),
                          (side(156.2, 13.0, 0.5, sg), head), (crown(4.6, 15.4, 0.5, sg), head)],
               [0.22, 0.1], label=("Temporal artery", "blood", "face", 0.75) if s == "L" else None)
        B.path("artery", [(side(155.2, 11.6, 0.5, sg), head), (side(158.0, 8.6, 0.5, sg), head),
                          (crown(4.4, 6.0, 0.5, sg), head)], [0.14, 0.09])
        man = B.bones["mandible"]["v"]
        notch = man[(np.abs(man[:, 0] - (mid + sg * 3.9)) < 0.6)]
        notch = notch[np.argmin(notch[:, 1])] + np.array([sg * 0.4, -0.3, 0.2])
        B.path("artery", [(eca, nb(145.6)), (M(3.7, 145.0, eca[2] + 1.6, sg), {JAW: 0.5, "c3": 0.5}),
                          (notch, jaw), (face(3.3, 146.6, 0.6, sg), jaw), (face(2.6, 147.6, 0.6, sg), jaw),
                          (face(1.9, 150.0, 0.6, sg), head), (face(1.3, 152.2, 0.6, sg), head)], [0.18, 0.1],
               label=("Facial artery", "blood", "face", 0.6) if s == "R" else None)
        B.path("artery", [(eca, nb(145.6)), (M(4.4, 147.0, 7.4, sg), {"atlas": 0.5, HEAD: 0.5}),
                          (back(4.6, 150.6, 0.7, sg), head), (back(3.6, 154.0, 0.7, sg), head),
                          (back(2.6, 157.8, 0.7, sg), head)], [0.16, 0.1])

        # Internal jugular vein up to the skull, then the venous sinuses.
        ijv_top = B.mesh_end(f"internal_jugular_vein_{s}", [0, 1, 0])
        jf = M(3.3, 149.0, 7.1, sg)
        B.path("vein", [(ijv_top, nb(ijv_top[1])), (M(3.2, 143.5, ijv_top[2] - 0.6, sg), nb(143.5)),
                        (M(3.5, 146.8, 9.2, sg), nb(146.8)), (jf, {"atlas": 0.4, HEAD: 0.6}),
                        (M(4.3, 150.3, 5.4, sg), head), (back(4.4, 152.2, -0.75, sg), head),
                        (back(2.4, 153.6, -0.75, sg), head), (back(0.15, 154.0, -0.75, sg), head)], [0.48, 0.32],
               label=("Jugular vein", "blood", "body", 0.15) if s == "R" else None)
        # External jugular vein and facial vein.
        sv = B.meshes[f"subclavian_vein_{s}"]["v"]
        ej0 = sv[np.argmin(np.abs(sv[:, 0] - (mid + sg * 5.6)) + np.abs(sv[:, 1] - 136.0))]
        B.path("vein", [(ej0, {CHEST: 1.0}), (M(5.3, 139.5, 11.6, sg), nb(139.5)), (M(4.9, 143.0, 11.4, sg), nb(143.0)),
                        (M(4.8, 146.2, 10.6, sg), {JAW: 0.5, "c3": 0.5}), (side(149.4, 10.8, 0.5, sg), head)], 0.2)
        B.path("vein", [(M(3.4, 145.0, 10.6, sg), nb(145.0)), (M(4.0, 144.9, 13.1, sg), {JAW: 0.5, "c3": 0.5}),
                        (face(3.7, 145.6, 0.5, sg), jaw), (face(3.0, 148.0, 0.5, sg), jaw),
                        (face(1.7, 151.6, 0.5, sg), head)], [0.18, 0.12])

        # Cranial nerves on the face: facial (VII) and trigeminal (V).
        smf = M(4.9, 148.6, 8.6, sg)
        B.path("nerve", [(M(1.2, 151.3, 9.4, sg), head), (M(2.9, 151.4, 8.4, sg), head), (smf, head)], 0.16)
        pes = side(148.9, 11.2, 0.4, sg)
        B.path("nerve", [(smf, head), (pes, head)], 0.16, label=("Facial nerve", "nerves", "face", 1.0) if s == "R" else None)
        for target in ([side(152.4, 13.6, 0.5, sg), face(4.6, 156.2, 0.6, sg)],
                       [side(151.0, 14.0, 0.5, sg), face(4.0, 152.0, 0.6, sg)],
                       [face(4.3, 149.0, 0.6, sg), face(2.6, 148.6, 0.6, sg)]):
            B.path("nerve", [(pes, head)] + [(t, head) for t in target], [0.13, 0.08])
        B.path("nerve", [(pes, head), (face(4.2, 145.4, 0.5, sg), jaw), (face(2.2, 144.8, 0.5, sg), jaw)], [0.13, 0.08])
        B.path("nerve", [(pes, head), (M(4.7, 145.6, 11.6, sg), {JAW: 0.5, "c3": 0.5}), (M(4.4, 143.4, 11.6, sg), nb(143.4))],
               [0.12, 0.08])
        gang = M(2.4, 152.0, 10.3, sg)
        B.path("nerve", [(M(1.6, 152.4, 9.6, sg), head), (gang, head)], 0.2)
        B.path("nerve", [(gang, head), (M(2.4, 153.4, 14.6, sg), head), (face(2.4, 154.6, 0.5, sg), head),
                         (face(2.6, 157.6, 0.5, sg), head), (crown(2.8, 15.6, 0.5, sg), head)], [0.14, 0.08])
        B.path("nerve", [(gang, head), (M(2.5, 151.3, 15.4, sg), head), (face(2.4, 151.0, 0.5, sg), head),
                         (face(1.6, 148.4, 0.5, sg), head)], [0.14, 0.08])
        B.path("nerve", [(gang, head), (M(2.6, 150.2, 10.6, sg), head), (M(4.3, 148.0, 12.2, sg), jaw),
                         (M(3.8, 145.6, 14.4, sg), jaw), (face(2.3, 145.4, 0.5, sg), jaw), (face(1.0, 144.6, 0.5, sg), jaw)],
               [0.14, 0.08])

        # Vagus nerve down the neck beside the carotid, past the heart, along the oesophagus.
        vag = [(M(1.0, 149.6, 8.8, sg), head), (jf + np.array([-sg * 0.3, -0.2, 0.4]), {"atlas": 0.4, HEAD: 0.6}),
               (M(2.9, 146.0, 9.4, sg), nb(146.0)), (M(2.9, 142.5, 10.0, sg), nb(142.5)),
               (M(2.9, 139.0, 10.3, sg), nb(139.0))]
        if s == "R":
            vag += [(M(3.0, 135.6, 10.8, sg), {CHEST: 1.0}), (M(1.9, 129.5, 7.2, sg), {CHEST: 1.0}),
                    (M(0.7, 122.0, 6.6, sg), {CHEST: 1.0}), (M(0.3, 113.0, 7.8, sg), {CHEST: 1.0}),
                    (M(0.2, 108.0, 9.6, sg), {CHEST: 0.6, "l1": 0.4})]
        else:
            vag += [(M(2.4, 134.8, 10.3, sg), {CHEST: 1.0}), (M(2.6, 132.4, 10.0, sg), {CHEST: 1.0}),
                    (M(1.8, 128.6, 6.9, sg), {CHEST: 1.0}), (M(0.6, 121.6, 7.2, sg), {CHEST: 1.0}),
                    (M(0.2, 113.0, 8.4, sg), {CHEST: 1.0}), (M(0.0, 108.0, 10.0, sg), {CHEST: 0.6, "l1": 0.4})]
        B.path("nerve", vag, 0.2, label=("Vagus nerve", "nerves", "body", 0.3) if s == "R" else None)
        # Phrenic nerve from C3-C5, over the heart to the diaphragm.
        ph = [(foramen(levels["C4"], sg) + np.array([sg * 1.8, -0.6, 1.2]), nb(levels["C4"])),
              (M(3.8, 140.0, 10.6, sg), nb(140.0)), (M(3.6, 136.4, 11.0, sg), {CHEST: 1.0})]
        if s == "R":
            ph += [(M(3.2, 130.0, 12.0, sg), {CHEST: 1.0}), (M(4.6, 123.0, 12.6, sg), {CHEST: 1.0}),
                   (M(4.8, 117.0, 11.8, sg), {CHEST: 1.0})]
        else:
            ph += [(M(3.6, 131.0, 11.6, sg), {CHEST: 1.0}), (M(7.6, 124.0, 12.4, sg), {CHEST: 1.0}),
                   (M(8.6, 117.6, 11.2, sg), {CHEST: 1.0})]
        B.path("nerve", ph, 0.13)
    # Superior sagittal sinus over the top of the brain.
    B.path("vein", [(back(0.0, 154.2, -0.75), head), (back(0.0, 158.4, -0.75), head), (crown(0.0, 6.0, -0.75), head),
                    (crown(0.0, 11.6, -0.75), head), (np.array([mid, 158.6, 15.8]), head)], [0.35, 0.18])

    # ---------------- azygos system (drains the chest wall into the superior vena cava)
    svc = B.meshes["superior_vena_cava"]["v"]
    svc_join = svc[np.argmin(np.linalg.norm(svc - np.array([mid - 1.0, 131.0, 9.8]), axis=1))]
    az = [(svc_join, {CHEST: 1.0}), (np.array([mid - 1.8, 132.4, 8.6]), {CHEST: 1.0})]
    for k in ["t5", "t7", "t9", "t11", "t12", "l1"]:
        c = B.canal[k]
        az.append((np.array([mid - 1.5, c[1], c[2] + 3.0]), B.spine_bind(c[1])))
    B.path("vein", az, [0.32, 0.22], tone=0.7)
    hemi = [(np.array([mid - 1.2, B.canal["t8"][1], B.canal["t8"][2] + 3.2]), {CHEST: 1.0})]
    for k in ["t8", "t10", "t12", "l1"]:
        c = B.canal[k]
        hemi.append((np.array([mid + 1.5, c[1] - (0.6 if k == "t8" else 0), c[2] + 2.9]), B.spine_bind(c[1])))
    B.path("vein", hemi, [0.24, 0.18], tone=0.7)
    # ---------------- upper limbs
    for s, sg in (("L", 1), ("R", -1)):
        def P(stem, t, lat=0.0, ant=0.0, up=0.0):
            key = f"{stem}_{s}"
            return B.ax(key, t) + np.array([sg * lat, up, ant]), seg(key)

        def F(t, lat=0.0, ant=0.0):
            p = (B.ax(f"radius_{s}", t) + B.ax(f"ulna_{s}", t)) / 2 + np.array([sg * lat, 0, ant])
            return p, seg(f"radius_{s}")

        def A(dx, y, z, bind=None):
            return np.array([mid + sg * dx, y, z]), bind or {CHEST: 1.0}

        hum = f"humerus_{s}"
        # Hand frame: across points to the thumb side, palmar to the palm.
        across = B.bones[f"mc2_{s}"]["c"] - B.bones[f"mc5_{s}"]["c"]
        across /= np.linalg.norm(across)
        mc3 = B.bones[f"mc3_{s}"]
        s0 = np.sign(np.cross(across, mc3["b"] - mc3["a"])[2]) or 1.0

        def H(stem, t, pal=0.0, rad=0.0):
            key = f"{stem}_{s}"
            b = B.bones[key]
            axis = b["b"] - b["a"]
            axis /= np.linalg.norm(axis)
            palmar = s0 * np.cross(across, axis)
            palmar /= np.linalg.norm(palmar)
            return B.ax(key, t) + palmar * pal + across * rad, seg(key)

        def wrist(pal=0.0, rad=0.0):
            c = (B.bones[f"lunate_{s}"]["c"] + B.bones[f"capitate_{s}"]["c"]) / 2
            b = B.bones[f"capitate_{s}"]
            axis = mc3["b"] - mc3["a"]
            axis /= np.linalg.norm(axis)
            palmar = s0 * np.cross(across, axis)
            palmar /= np.linalg.norm(palmar)
            return c + palmar * pal + across * rad, seg(f"capitate_{s}")

        sub_end = B.mesh_end(f"subclavian_artery_{s}", [sg, 0, 0])
        axil = [(sub_end, {CHEST: 1.0}), A(12.4, 133.1, 8.9), A(14.6, 130.2, 8.1, {CHEST: 0.6, hum: 0.4}),
                P("humerus", 0.27, -1.9, 0.6)]
        B.path("artery", axil + [P("humerus", 0.5, -2.0, 1.2), P("humerus", 0.75, -1.6, 1.8)], 0.36)
        brach_low = P("humerus", 0.75, -1.6, 1.8)
        fossa = mix(P("humerus", 0.96, -0.6, 2.3), P("radius", 0.0, -1.0, 2.3))
        bif = F(0.08, 0.0, 1.9)
        B.path("artery", [P("humerus", 0.5, -2.0, 1.2), brach_low, fossa, bif], [0.33, 0.3],
               label=("Brachial artery", "blood", "body", 0.2) if s == "L" else None)
        B.path("artery", [bif, P("radius", 0.25, 0.3, 1.6), P("radius", 0.6, 0.6, 1.3), P("radius", 0.95, 0.5, 0.9),
                          wrist(-0.6, 1.8), H("mc1", 0.1, -0.4, 0.2), H("mc2", 0.15, -0.6, 0.6)], [0.26, 0.18],
               label=("Radial artery", "blood", "body", 0.4) if s == "R" else None)
        B.path("artery", [bif, P("ulna", 0.2, 0.6, 1.8), P("ulna", 0.5, 0.1, 1.5), P("ulna", 0.95, 0.0, 1.0),
                          wrist(0.9, -1.1), H("mc5", 0.35, 1.1, 0.2), H("mc4", 0.5, 1.3, 0.0), H("mc3", 0.55, 1.3, 0.0),
                          H("mc2", 0.45, 1.2, 0.2), H("mc1", 0.45, 1.0, -0.3)], [0.24, 0.14])
        # Deep palmar arch from the radial artery.
        B.path("artery", [H("mc2", 0.15, -0.6, 0.6), H("mc2", 0.18, 0.7, -0.2), H("mc3", 0.18, 0.7, 0.0),
                          H("mc4", 0.2, 0.7, 0.0), H("mc5", 0.2, 0.7, 0.0)], 0.12)
        # Digital arteries and nerves, both sides of each finger.
        arch = {2: H("mc2", 0.45, 1.2, 0.2), 3: H("mc3", 0.55, 1.3, 0.0), 4: H("mc4", 0.5, 1.3, 0.0),
                5: H("mc5", 0.35, 1.1, 0.2)}
        for d in range(1, 6):
            for sidek in (-1, 1):
                rad = 0.45 * sidek
                if d == 1:
                    root = H("mc1", 0.45, 1.0, -0.3)
                    pts = [root, H("mc1", 0.8, 0.5, rad), H("pp1", 0.3, 0.35, rad), H("pp1", 0.9, 0.35, rad),
                           H("dp1", 0.5, 0.3, rad * 0.8), H("dp1", 0.92, 0.2, rad * 0.3)]
                else:
                    web = d - 0.5 * sidek if 2 <= d - 0.5 * sidek <= 5 else d
                    root = arch[int(np.clip(round(web), 2, 5))]
                    pts = [root, H(f"mc{d}", 0.85, 0.9, rad * 0.7), H(f"pp{d}", 0.1, 0.35, rad),
                           H(f"pp{d}", 0.9, 0.35, rad), H(f"mp{d}", 0.5, 0.3, rad), H(f"dp{d}", 0.5, 0.28, rad * 0.8),
                           H(f"dp{d}", 0.92, 0.2, rad * 0.3)]
                B.path("artery", pts, [0.1, 0.06], spacing=0.4)

        # Veins: axillary into basilic; cephalic; brachial; median cubital; dorsal network of the hand.
        sv_end = B.mesh_end(f"subclavian_vein_{s}", [sg, 0, 0])
        axv = [(sv_end, {CHEST: 1.0}), A(12.4, 132.6, 9.6), A(14.6, 129.6, 8.7, {CHEST: 0.6, hum: 0.4}),
               P("humerus", 0.27, -2.5, 0.9), P("humerus", 0.5, -3.1, 1.3), P("humerus", 0.8, -3.2, 1.2)]
        elbow_med = mix(P("humerus", 0.97, -3.0, 1.6), P("ulna", 0.02, -2.2, 1.9))
        B.path("vein", axv + [elbow_med, P("ulna", 0.3, -1.4, 0.6), P("ulna", 0.6, -1.3, -0.1),
                              P("ulna", 0.95, -0.8, -0.8), wrist(-1.0, -1.4), H("mc4", 0.4, -0.9, -0.2)],
               [0.38, 0.2])
        B.path("vein", [P("humerus", 0.27, -2.5, 0.9), P("humerus", 0.5, -1.6, 1.5), P("humerus", 0.75, -1.1, 2.1),
                        mix(P("humerus", 0.96, -0.2, 2.5), P("radius", 0.0, -0.6, 2.5))], [0.22, 0.18])
        ceph_top = A(11.4, 133.9, 10.6)
        B.path("vein", [ceph_top, A(13.2, 132.8, 12.2), P("humerus", 0.12, 1.2, 4.2), P("humerus", 0.45, 2.3, 3.2),
                        P("humerus", 0.8, 2.3, 2.9), mix(P("humerus", 0.98, 2.1, 2.8), P("radius", 0.0, 1.5, 2.6)),
                        P("radius", 0.3, 1.7, 1.0), P("radius", 0.65, 1.7, 0.4), P("radius", 0.95, 1.2, -0.6),
                        wrist(-1.0, 1.8), H("mc2", 0.4, -0.9, 0.2), H("mc3", 0.45, -0.9, 0.0),
                        H("mc4", 0.4, -0.9, -0.2)], [0.26, 0.16],
               label=("Cephalic vein", "blood", "body", 0.35) if s == "R" else None)
        B.path("vein", [mix(P("humerus", 0.98, 2.1, 2.8), P("radius", 0.0, 1.5, 2.6)),
                        mix(P("humerus", 0.99, 0.4, 3.3), P("radius", 0.0, 0.0, 3.2)), elbow_med], 0.18)

        # Nerves: brachial plexus terminal branches.
        plexus = A(6.5, 137.0, 8.6)
        cord_pts = [plexus, A(9.6, 135.2, 8.3), A(12.8, 132.8, 8.2), A(14.4, 130.2, 7.9, {CHEST: 0.6, hum: 0.4})]
        B.path("nerve", cord_pts, 0.3, label=("Brachial plexus", "nerves", "body", 0.4) if s == "L" else None)
        axilla = cord_pts[-1]
        B.path("nerve", [axilla, P("humerus", 0.27, -1.4, 1.0), P("humerus", 0.5, -2.1, 1.5),
                         P("humerus", 0.85, -1.3, 2.1), mix(P("humerus", 0.97, -0.9, 2.2), P("radius", 0.0, -1.3, 2.2)),
                         F(0.25, 0.0, 1.7), F(0.6, 0.0, 1.6), F(0.93, 0.0, 1.2), wrist(1.0, 0.1),
                         H("mc3", 0.2, 1.0, 0.1)], [0.22, 0.17],
               label=("Median nerve", "nerves", "body", 0.6) if s == "L" else None)
        med_palm = H("mc3", 0.2, 1.0, 0.1)
        B.path("nerve", [axilla, P("humerus", 0.3, -2.4, 0.2), P("humerus", 0.6, -2.4, -0.4),
                         mix(P("humerus", 0.98, -2.8, -0.6), P("ulna", 0.03, -2.2, -0.6)),
                         P("ulna", 0.25, -0.5, 1.2), P("ulna", 0.6, 0.0, 1.4), P("ulna", 0.95, 0.1, 1.1),
                         wrist(0.9, -1.4), H("mc5", 0.25, 0.9, 0.3)], [0.2, 0.15],
               label=("Ulnar nerve", "nerves", "body", 0.55) if s == "R" else None)
        uln_palm = H("mc5", 0.25, 0.9, 0.3)
        B.path("nerve", [axilla, A(15.6, 128.6, 6.2, {CHEST: 0.4, hum: 0.6}), P("humerus", 0.35, -0.3, -1.4),
                         P("humerus", 0.5, 0.9, -1.1), P("humerus", 0.62, 1.6, 0.2), P("humerus", 0.85, 1.4, 1.2),
                         mix(P("humerus", 0.97, 1.9, 1.4), P("radius", 0.0, 1.3, 1.4)), P("radius", 0.2, 1.0, 1.2),
                         P("radius", 0.6, 1.1, 0.8), P("radius", 0.88, 1.0, -0.4), wrist(-0.9, 1.6),
                         H("mc1", 0.6, -0.6, -0.4)], [0.21, 0.12],
               label=("Radial nerve", "nerves", "body", 0.35) if s == "R" else None)
        B.path("nerve", [P("radius", 0.05, 1.3, 1.0), P("radius", 0.12, 1.0, -0.8), F(0.4, 0.0, -1.6), F(0.8, 0.0, -1.3)],
               [0.14, 0.1])
        B.path("nerve", [axilla, P("humerus", 0.2, -0.4, 2.0), P("humerus", 0.5, 0.4, 2.6), P("humerus", 0.82, 1.0, 2.8),
                         mix(P("humerus", 0.98, 1.6, 2.5), P("radius", 0.0, 1.2, 2.4)), P("radius", 0.4, 1.4, 1.3),
                         P("radius", 0.9, 1.1, 0.6)], [0.16, 0.1])
        B.path("nerve", [A(14.6, 129.6, 7.0, {CHEST: 0.5, hum: 0.5}), P("humerus", 0.08, -0.4, -1.6),
                         P("humerus", 0.12, 1.6, -0.6), P("humerus", 0.13, 2.0, 0.8)], [0.15, 0.1])
        for d in range(1, 6):
            for sidek in (-1, 1):
                rad = 0.48 * sidek
                src = med_palm if d < 4 or (d == 4 and sidek == 1) else uln_palm
                if d == 1:
                    pts = [src, H("mc1", 0.8, 0.6, rad), H("pp1", 0.3, 0.45, rad), H("pp1", 0.9, 0.45, rad),
                           H("dp1", 0.5, 0.38, rad * 0.8), H("dp1", 0.92, 0.25, rad * 0.3)]
                else:
                    pts = [src, H(f"mc{d}", 0.85, 1.0, rad * 0.7), H(f"pp{d}", 0.1, 0.45, rad), H(f"pp{d}", 0.9, 0.45, rad),
                           H(f"mp{d}", 0.5, 0.4, rad), H(f"dp{d}", 0.5, 0.36, rad * 0.8), H(f"dp{d}", 0.92, 0.25, rad * 0.3)]
                B.path("nerve", pts, [0.09, 0.05], spacing=0.4)

    # ---------------- lower limbs
    for s, sg in (("L", 1), ("R", -1)):
        def P(stem, t, lat=0.0, ant=0.0, up=0.0):
            key = f"{stem}_{s}"
            return B.ax(key, t) + np.array([sg * lat, up, ant]), seg(key)

        def C(stem, lat=0.0, ant=0.0, up=0.0):
            key = f"{stem}_{s}"
            return B.bones[key]["c"] + np.array([sg * lat, up, ant]), seg(key)

        def A(dx, y, z, bind=None):
            return np.array([mid + sg * dx, y, z]), bind or {PELVIS: 1.0}

        def leg_mid(t, ant=0.0, lat=0.0):
            p = (B.ax(f"tibia_{s}", t) + B.ax(f"fibula_{s}", t)) / 2 + np.array([sg * lat, 0, ant])
            return p, seg(f"tibia_{s}")

        fem, tib, foot = f"femur_{s}", f"tibia_{s}", f"calcaneus_{s}"
        groin = {PELVIS: 0.6, fem: 0.4}
        eia_end = B.mesh_end(f"external_iliac_artery_{s}", [0, -1, 0.6])
        knee_back = mix(P("femur", 0.98, 0.0, -2.3), P("tibia", 0.02, 0.0, -2.3))
        B.path("artery", [(eia_end, {PELVIS: 1.0}), (eia_end + np.array([sg * 0.6, -4.0, -0.6]), groin),
                          P("femur", 0.3, -2.5, 3.6), P("femur", 0.5, -2.6, 2.0), P("femur", 0.72, -1.4, -0.6),
                          P("femur", 0.88, -0.3, -2.0), knee_back, P("tibia", 0.12, 0.0, -1.8)], [0.4, 0.32],
               label=("Femoral artery", "blood", "body", 0.3) if s == "L" else None)
        B.path("artery", [(eia_end + np.array([sg * 0.6, -4.0, -0.6]), groin), P("femur", 0.2, -0.4, 2.0),
                          P("femur", 0.35, -1.0, -1.0), P("femur", 0.6, -0.8, -1.5)], [0.28, 0.16])
        pop_bif = P("tibia", 0.12, 0.0, -1.8)
        ankle_front = mix(P("tibia", 0.99, 0.2, 2.4, 1.0), C("talus", 0.0, 0.6, 1.8))
        B.path("artery", [pop_bif, leg_mid(0.1, 0.0), leg_mid(0.16, 0.9), leg_mid(0.35, 1.4), leg_mid(0.75, 1.6),
                          ankle_front, C("navicular", 0.0, 0.0, 1.4),
                          ((B.bones[f"mt1_{s}"]["a"] + B.bones[f"mt2_{s}"]["a"]) / 2 + np.array([0, 1.2, 0]), seg(foot)),
                          P("mt1", 0.8, 0.6, 0.0, 0.8)], [0.24, 0.13],
               label=("Anterior tibial artery", "blood", "body", 0.45) if s == "R" else None)
        B.path("artery", [P("mt2", 0.1, 0.0, 0.0, 1.0), P("mt3", 0.1, 0.0, 0.0, 0.9), P("mt4", 0.1, 0.0, 0.0, 0.9),
                          P("mt5", 0.15, 0.0, 0.0, 0.8)], 0.1)
        med_mall = mix(P("tibia", 0.99, -1.7, -1.4), C("talus", -1.8, -1.2, 0.0))
        heel_med = C("calcaneus", -2.1, 0.6, 0.6)
        B.path("artery", [pop_bif, P("tibia", 0.3, -0.2, -2.2), P("tibia", 0.7, -0.8, -2.0), med_mall, heel_med,
                          P("mt1", 0.4, 0.0, 0.0, -1.2), P("mt1", 0.95, 0.0, 0.0, -1.0)], [0.22, 0.12])
        B.path("artery", [heel_med, C("cuboid", 0.0, 0.0, -1.0), P("mt5", 0.2, -0.2, 0.0, -1.1),
                          P("mt4", 0.2, 0.0, 0.0, -1.3), P("mt3", 0.2, 0.0, 0.0, -1.3), P("mt2", 0.2, 0.0, 0.0, -1.3)],
               [0.16, 0.1])
        B.path("artery", [P("tibia", 0.3, -0.2, -2.2), P("fibula", 0.4, -1.0, -1.3), P("fibula", 0.85, -0.6, -1.2),
                          mix(P("fibula", 0.98, 0.2, -1.2), C("calcaneus", 1.4, -0.6, 1.2))], [0.16, 0.1])

        # Veins: femoral and popliteal; great and small saphenous; dorsal venous arch.
        eiv_end = B.mesh_end(f"external_iliac_vein_{s}", [0, -1, 0.6])
        saph_join = (eiv_end + np.array([sg * 0.3, -4.2, -0.2]), groin)
        B.path("vein", [(eiv_end, {PELVIS: 1.0}), saph_join, P("femur", 0.3, -3.1, 3.0), P("femur", 0.5, -3.0, 1.5),
                        P("femur", 0.72, -1.8, -1.0), P("femur", 0.88, -0.6, -2.6),
                        mix(P("femur", 0.98, 0.3, -2.9), P("tibia", 0.02, 0.3, -2.9)), P("tibia", 0.14, 0.2, -2.4)],
               [0.42, 0.3])
        knee_med = mix(P("femur", 0.97, -4.4, -0.6), P("tibia", 0.03, -4.2, -0.6))
        gsv = [saph_join, (saph_join[0] + np.array([sg * 0.4, -0.6, 1.4]), groin), P("femur", 0.3, -4.6, 3.4),
               P("femur", 0.6, -5.2, 1.2), knee_med, P("tibia", 0.3, -3.0, -0.4), P("tibia", 0.7, -2.6, 0.4),
               mix(P("tibia", 0.99, -1.8, 1.5), C("talus", -1.9, 1.0, 0.6)), C("navicular", -1.6, 0.0, 1.0),
               P("mt1", 0.4, -0.3, 0.0, 1.2), P("mt2", 0.45, 0.0, 0.0, 1.3), P("mt3", 0.45, 0.0, 0.0, 1.3),
               P("mt4", 0.45, 0.0, 0.0, 1.2), P("mt5", 0.4, 0.3, 0.0, 1.0), C("cuboid", 1.4, 0.0, 0.4)]
        B.path("vein", gsv, [0.3, 0.16], label=("Great saphenous vein", "blood", "body", 0.42) if s == "R" else None)
        B.path("vein", [P("tibia", 0.1, 0.4, -3.4), P("tibia", 0.3, 1.2, -4.4), P("tibia", 0.7, 2.2, -3.0),
                        mix(P("fibula", 0.99, 0.6, -1.0), C("calcaneus", 1.4, -0.8, 1.6)), C("cuboid", 1.4, 0.0, 0.4)],
               [0.24, 0.15])

        # Nerves: femoral, saphenous, obturator, sciatic, tibial, common fibular.
        lum = [foramen(levels[n], sg, 1.8, 0.6) for n in ("L2", "L3", "L4")]
        fem_start = A(4.6, 95.6, 8.0, {"l4": 0.5, "l5": 0.5})
        for i, p in enumerate(lum):
            B.path("nerve", [(p, B.spine_bind(p[1])), (p + np.array([sg * 1.4, -1.0, 0.8]), B.spine_bind(p[1] - 1)),
                             fem_start], 0.16)
        fem_n = [fem_start, A(6.0, 90.0, 9.4), A(6.9, 85.2, 12.6), (eia_end + np.array([sg * 1.7, -0.1, -0.2]), {PELVIS: 1.0}),
                 (eia_end + np.array([sg * 2.0, -4.0, -0.6]), groin)]
        B.path("nerve", fem_n, 0.26, label=("Femoral nerve", "nerves", "body", 0.8) if s == "L" else None)
        fem_tri = fem_n[-1]
        for lat, ant in ((1.6, 3.2), (0.4, 3.6), (-0.6, 3.2)):
            B.path("nerve", [fem_tri, P("femur", 0.2, lat, ant), P("femur", 0.4, lat * 1.2, ant)], [0.14, 0.08])
        B.path("nerve", [fem_tri, P("femur", 0.3, -2.1, 3.9), P("femur", 0.55, -2.8, 2.3), P("femur", 0.78, -3.1, 0.2),
                         knee_med, P("tibia", 0.3, -2.7, -0.2), P("tibia", 0.7, -2.4, 0.5),
                         mix(P("tibia", 0.99, -1.9, 1.3), C("talus", -1.9, 0.9, 0.4)), C("navicular", -1.6, 0.2, 0.6)],
               [0.13, 0.09])
        B.path("nerve", [fem_start, A(4.9, 90.0, 8.4), A(4.6, 81.0, 10.6), (A(4.6, 77.6, 10.4)[0], groin),
                         P("femur", 0.25, -4.0, 0.6), P("femur", 0.45, -4.6, 0.4)], [0.17, 0.1])
        sci_start = A(4.4, 87.6, 4.6)
        for p in [foramen(levels["L4"], sg, 1.8, 0.6), foramen(levels["L5"], sg, 1.8, 0.6)]:
            B.path("nerve", [(p, B.spine_bind(p[1])), (p + np.array([sg * 1.0, -2.0, 0.8]), B.spine_bind(p[1] - 2)),
                             sci_start], 0.2)
        for n in (1, 2, 3):
            p = sacral_foramen(n, sg)
            B.path("nerve", [(p, {PELVIS: 1.0}), (p + np.array([sg * 1.6, -0.6, -0.6]), {PELVIS: 1.0}), sci_start], 0.2)
        apex = P("femur", 0.78, -0.2, -2.8)
        B.path("nerve", [sci_start, A(6.2, 85.0, 2.2), A(8.2, 79.6, 3.0, {PELVIS: 0.5, fem: 0.5}),
                         P("femur", 0.25, -0.3, -3.0), P("femur", 0.55, -0.1, -3.0), apex], 0.36,
               label=("Sciatic nerve", "nerves", "body", 0.55) if s == "R" else None)
        B.path("nerve", [apex, mix(P("femur", 0.98, 0.0, -3.0), P("tibia", 0.02, 0.0, -3.0)), P("tibia", 0.15, 0.0, -2.8),
                         P("tibia", 0.5, -0.6, -2.3), P("tibia", 0.9, -1.2, -1.8), med_mall,
                         C("calcaneus", -2.1, 0.8, 0.8), P("mt1", 0.3, 0.0, 0.0, -1.1), P("mt1", 0.95, 0.0, 0.0, -0.9)],
               [0.26, 0.14], label=("Tibial nerve", "nerves", "body", 0.35) if s == "L" else None)
        B.path("nerve", [C("calcaneus", -2.1, 0.8, 0.8), C("cuboid", -0.4, 0.0, -1.0), P("mt5", 0.5, 0.0, 0.0, -0.9)],
               [0.14, 0.08])
        neck_fib = P("fibula", 0.07, 1.0, 0.4)
        B.path("nerve", [apex, mix(P("femur", 0.92, 2.6, -2.2), P("tibia", 0.0, 3.0, -2.0), 0.3),
                         P("fibula", 0.02, 0.5, -0.9), neck_fib], 0.2,
               label=("Common fibular nerve", "nerves", "body", 0.6) if s == "R" else None)
        B.path("nerve", [neck_fib, P("fibula", 0.3, 1.2, 0.9), P("fibula", 0.75, 0.9, 1.6),
                         mix(P("fibula", 0.98, -0.6, 2.4, 1.2), C("talus", 1.6, 1.0, 1.4)), P("mt4", 0.3, 0.0, 0.0, 1.2),
                         P("mt3", 0.8, 0.0, 0.0, 1.0)], [0.15, 0.09])
        B.path("nerve", [neck_fib, leg_mid(0.2, 1.0), leg_mid(0.35, 1.6), leg_mid(0.75, 1.8), ankle_front,
                         P("mt1", 0.8, 0.6, 0.0, 1.1)], [0.15, 0.09])


def main():
    B = Builder()
    for spec in MESHES:
        B.add_mesh(*spec)
    B.add_cortex()
    print(f"{len(B.meshes)} soft-tissue meshes")
    B.rib_lines = {}
    for s in ("L", "R"):
        for n in range(1, 13):
            b = B.bones[f"rib{n}_{s}"]
            B.rib_lines[f"rib{n}_{s}"] = centre_line(b["v"], b["f"].astype(np.int64))
    route_all(B)
    B.mesh_label("heart", "Heart", "blood", "body", toward=[0.6, -0.3, 1])
    B.mesh_label("aortic_arch", "Aorta", "blood", "body", toward=[0.2, 1, 0])
    B.mesh_label("pulmonary_artery", "Pulmonary artery", "blood", "body", toward=[-1, 0.2, 0])
    B.mesh_label("superior_vena_cava", "Superior vena cava", "blood", "body", toward=[-1, 0, 0])
    B.mesh_label("inferior_vena_cava", "Inferior vena cava", "blood", "body", toward=[-1, 0, 0.2])
    B.mesh_label("lung_upper_L", "Lungs", "blood", "body", toward=[1, 0.3, 0.4])
    B.mesh_label("hemisphere_L", "Brain", "nerves", "face", toward=[0.4, 1, 0.3])
    B.mesh_label("cerebellum", "Cerebellum", "nerves", "face", toward=[0.5, -0.3, -1])
    B.mesh_label("pons", "Brainstem", "nerves", "face", toward=[0, 0, 1])
    B.write()


if __name__ == "__main__":
    main()
