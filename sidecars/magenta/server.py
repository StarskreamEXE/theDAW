#!/usr/bin/env python3
"""theDAW — extended Magenta RealTime 2 sidecar (runs in WSL2 on the NVIDIA GPU).

Supersedes the bundle's text-only ``studio_server.py`` by exposing the model's
FULL conditioning surface over one HTTP endpoint, so theDAW's backend
(``backend/modules/magenta``) can drive text-prompt generation, MIDI-conditioned
accompaniment, AND audio-style ("clone"/style-transfer) — all of which
``MagentaRT2System`` supports (see ``magenta_rt/jax/system.py``).

    GET  /health    -> {ready, status, model, device, sample_rate}
    POST /cancel    -> form request_id: stop that take at its next chunk (409 from /generate)
    POST /generate  -> multipart form, returns audio/wav (48 kHz stereo, sync)
        request_id    str    OPTIONAL name for /cancel
        prompt        str    text style (used when no audio style is given)
        duration      float  seconds (frames = duration * 25)
        temperature   float  (default 1.3)
        top_k         int    (default 40)
        cfg_musiccoca float  (default 3.0)
        cfg_notes     float  (default 1.0)
        cfg_drums     float  (default 1.0)
        drums         int    -1 auto / 0 off / 1 on  (default -1)
        chunk_frames  int    note granularity; smaller = tighter timing, slower (default 25)
        notes         str    OPTIONAL JSON: [{"pitch":0-127,"start":sec,"end":sec}, ...]
                             -> MIDI-conditioned accompaniment
        audio         file   OPTIONAL wav -> style embedded from the clip (overrides prompt)

Run (inside WSL2, with magenta-rt + jax[cuda] installed and weights downloaded):

    pip install -r requirements.txt          # fastapi/uvicorn/multipart (+ magenta-rt, jax[cuda])
    MRT2_MODEL=mrt2_small python server.py    # serves http://0.0.0.0:8777

theDAW's backend reaches it at http://localhost:8777 (WSL2 forwards localhost);
override with THEDAW_MAGENTA_URL.
"""

from __future__ import annotations

import base64
import collections
import hashlib
import io
import json
import os
import sys
import threading
import time
import traceback

# GPU allocator (must be set before jax is imported).
#
# The default is the BFC allocator WITHOUT preallocation: it takes VRAM as the
# model needs it and keeps what it has, so after the load and the first steps
# there is no per-op allocation, and the streaming loop pays nothing for it.
# Preallocation — the old default — grabbed 75% of the card at import, which on
# an 11 GB card is an 8.25 GiB ceiling fixed before the model was even opened;
# mrt2_base as fp32 filled that ceiling with the checkpoint half loaded. The cap
# is 95% of the card now, and only a cap: with no up-front grab it never asks
# for more than is physically free.
#
#   THEDAW_MAGENTA_PREALLOCATE=1   the old behaviour, for comparison.
#   THEDAW_MAGENTA_LOWMEM=1        preallocation off AND the "platform"
#                                  allocator, which JAX documents as "very slow,
#                                  not recommended for general use" (it allocates
#                                  and frees per op). A last resort.
#
# Read inline, with no helper and no name bound out here: a `def` or a
# module-level assignment above the imports puts every one of them past the top
# of the file. A conditional does not.
if os.environ.get("THEDAW_MAGENTA_LOWMEM", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
):
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    os.environ.setdefault("XLA_PYTHON_CLIENT_ALLOCATOR", "platform")
    ALLOCATOR_MODE = "lowmem"
elif os.environ.get("THEDAW_MAGENTA_PREALLOCATE", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
):
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "true")
    ALLOCATOR_MODE = "preallocate"
else:
    os.environ.setdefault("XLA_PYTHON_CLIENT_PREALLOCATE", "false")
    ALLOCATOR_MODE = "grow"
os.environ.setdefault("XLA_PYTHON_CLIENT_MEM_FRACTION", "0.95")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Form, UploadFile
from fastapi.responses import JSONResponse, Response

# The layout rules live beside this file; the sidecar runs by path from WSL,
# so its own directory is put on the path before they are imported.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import weights as checkpoint_layout

FPS = 25  # model emits 25 frames/s (40 ms each)
PORT = int(os.environ.get("MRT2_PORT", "8777"))
MODEL = os.environ.get("MRT2_MODEL", "mrt2_small")
# Frames per generate() call on the NO-NOTES path. Chunk size there is pure
# output segmentation (state threads across calls, so the audio is identical
# regardless), so a big chunk cuts host<->device round-trips ~10x vs the old 25
# (1s). The MIDI/notes path keeps the caller's fine chunk_frames for note timing.
NO_NOTES_CHUNK = max(1, int(os.environ.get("THEDAW_MAGENTA_NO_NOTES_CHUNK", "250")))
# How the checkpoint sits on the GPU (weights.py has the rules and the why):
#   THEDAW_MAGENTA_PARAMS=bf16|fp32   the depthformer's params. bf16 is the
#                                     default: the model computes in bf16
#                                     whatever the params are, and fp32 params
#                                     are twice the bytes for nothing.
#   THEDAW_MAGENTA_SHARD=1            cut every tensor across all the cards JAX
#                                     sees, each holding its share.
PARAMS_DTYPE = (
    "fp32"
    if os.environ.get("THEDAW_MAGENTA_PARAMS", "").strip().lower() == "fp32"
    else "bf16"
)
SHARD = os.environ.get("THEDAW_MAGENTA_SHARD", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
# The frames the warm-up times after the compile, so /health can say how far
# past realtime this card runs the model (2 s of audio at FPS).
WARMUP_TIMED_FRAMES = 2 * FPS
# What a load needs beyond its resident params: the compile's scratch and the
# streaming state. mrt2_base as bf16 is 4.68 GiB resident and 5.05 GiB in use
# once ready on one card, and the compile peaked at 6.50 GiB.
LOAD_HEADROOM = 1.4


def _memory_stats(jax) -> dict:
    """What JAX holds on every device right now, in bytes. This is the number
    that is true for this process; nvidia-smi on the Windows side does not
    reliably reflect a WSL process's allocations."""
    per = []
    for d in jax.devices():
        try:
            st = d.memory_stats() or {}
            per.append(
                {
                    "device": str(d),
                    "bytes_in_use": st.get("bytes_in_use"),
                    "peak_bytes_in_use": st.get("peak_bytes_in_use"),
                    "bytes_limit": st.get("bytes_limit"),
                }
            )
        except Exception as e:  # noqa: BLE001 — a device with no stats still lists
            per.append({"device": str(d), "error": str(e)[:120]})

    def total(key: str):
        vals = [x[key] for x in per if isinstance(x.get(key), int)]
        return sum(vals) if vals else None

    return {
        "per_device": per,
        "bytes_in_use": total("bytes_in_use"),
        "peak_bytes_in_use": total("peak_bytes_in_use"),
        "bytes_limit": total("bytes_limit"),
    }


def _checkpoint_plan(size: str, devices: int) -> dict | None:
    """What the load is about to put on each card, read from the checkpoint's
    header before a single tensor moves. Best-effort: None when the file or the
    registry cannot be read, and the load goes ahead regardless."""
    try:
        import json as _json
        import struct

        from magenta_rt import paths
        from magenta_rt.jax import system as mrt_system

        path = paths.checkpoints_dir() / mrt_system._CHECKPOINT_REGISTRY[size]
        with open(path, "rb") as f:
            n = struct.unpack("<Q", f.read(8))[0]
            header = _json.loads(f.read(n))
        header.pop("__metadata__", None)
        leaves = {k: (v["dtype"], tuple(v["shape"])) for k, v in header.items()}
        return checkpoint_layout.plan(leaves, devices)
    except Exception as e:  # noqa: BLE001 — a plan is a courtesy, never a gate
        print(f"[magenta] checkpoint plan unavailable: {e}", flush=True)
        return None


def _install_lean_loader(jax, params_dtype: str, shard: bool) -> tuple[int, str]:
    """Replace magenta_rt's weight loader and model class so the checkpoint
    lands on the GPU the way weights.py lays it out.

    The stock loader (safetensors.flax.load_file) puts every tensor on the
    device as the fp32 the file holds, all at once. This one reads a tensor at
    a time as numpy, casts the depthformer's to bf16 on the host, and places it
    — on one card, or cut along one axis across all of them. The model class is
    told its params are bf16 so anything it creates itself agrees.

    Returns (devices used, a one-line description for the log).
    """
    import flax.traverse_util as flaxtu
    import jax.numpy as jnp
    import ml_dtypes
    import numpy as np
    from jax.sharding import Mesh, NamedSharding, PartitionSpec
    from magenta_rt.jax import model as mrt_model
    from magenta_rt.jax import system as mrt_system
    from safetensors import safe_open

    devices = jax.devices()
    ndev = len(devices) if shard else 1
    mesh = Mesh(np.array(devices[:ndev]), ("m",)) if ndev > 1 else None

    def load(path):
        out = {}
        with safe_open(str(path), framework="np") as f:
            for key in f.keys():
                arr = f.get_tensor(key)
                dtype_name = (
                    "F32" if arr.dtype == np.float32 else str(arr.dtype).upper()
                )
                if params_dtype == "bf16" and checkpoint_layout.should_halve(
                    key, dtype_name
                ):
                    arr = arr.astype(ml_dtypes.bfloat16)
                if mesh is not None:
                    spec = PartitionSpec(
                        *checkpoint_layout.partition_spec(tuple(arr.shape), ndev)
                    )
                    out[key] = jax.device_put(arr, NamedSharding(mesh, spec))
                else:
                    out[key] = jnp.asarray(arr)
                del arr
        return flaxtu.unflatten_dict({tuple(k.split("/")): v for k, v in out.items()})

    mrt_system._load_jax_weights = load

    if params_dtype == "bf16":
        stock = mrt_model.get_model_class

        def get_model_class(name: str):
            base = stock(name)
            return type(f"{base.__name__}BF16", (base,), {"param_dtype": jnp.bfloat16})

        mrt_model.get_model_class = get_model_class

    how = f"{params_dtype} params"
    how += f", split across {ndev} cards" if ndev > 1 else ", one card"
    return ndev, how


class Engine:
    """Loads MagentaRT2System once, serializes generate() (model is not reentrant)."""

    def __init__(self) -> None:
        self.mrt = None
        self.ready = False
        self.status = "starting"
        self.error: str | None = None
        self.device = "?"
        self.sample_rate = 48000
        # How the weights sit on the GPU, and what the GPU holds: for /health,
        # and for the app to say the true thing when a load fails.
        self.params_dtype = PARAMS_DTYPE
        self.sharded = SHARD
        self.gpus: int | None = None
        self.plan: dict | None = None
        self.gpu: dict | None = None
        self.gpu_at_error: dict | None = None
        # Frames generated per second over realtime, from the timed warm-up.
        self.realtime_factor: float | None = None
        self.lock = threading.Lock()
        self._embed_cache: dict[str, object] = {}
        # Current evolving piece for extend/morph: {state, emb, key, samples, sr}.
        self._gen: dict | None = None
        # request_ids whose cancel arrived (POST /cancel), newest last. A cancel
        # can reach the engine before its /generate does, so it is remembered.
        self._cancelled: collections.deque[str] = collections.deque(maxlen=64)
        self._cancel_lock = threading.Lock()

    def cancel(self, request_id: str) -> None:
        with self._cancel_lock:
            if request_id not in self._cancelled:
                self._cancelled.append(request_id)

    def is_cancelled(self, request_id: str) -> bool:
        if not request_id:
            return False
        with self._cancel_lock:
            return request_id in self._cancelled

    def load(self) -> None:
        try:
            self.status = "importing jax + magenta_rt"
            import jax

            # Persistent XLA compilation cache. MRT2's one-time XLA compile
            # dominates cold-start (and recurs on every re-spin after an
            # SA3<->Magenta GPU swap). Caching compiled executables to disk makes
            # every start after the first skip that recompile, which is the single
            # biggest lever for "spin up a faster one". Best-effort: wrapped so a
            # JAX version that renamed a config key can never block model load.
            # Override the dir with THEDAW_MAGENTA_JAX_CACHE.
            try:
                cache_dir = os.environ.get(
                    "THEDAW_MAGENTA_JAX_CACHE",
                    os.path.expanduser("~/.cache/thedaw-mrt2-jax"),
                )
                jax.config.update("jax_compilation_cache_dir", cache_dir)
                jax.config.update("jax_persistent_cache_min_entry_size_bytes", -1)
                jax.config.update("jax_persistent_cache_min_compile_time_secs", 0)
                print(f"[magenta] JAX compile cache -> {cache_dir}", flush=True)
            except Exception as e:  # noqa: BLE001 — cache is an optimization only
                print(f"[magenta] JAX compile cache unavailable: {e}", flush=True)

            # magenta-rt 2.x exposes the JAX system as ``MagentaRT2Jax`` (the
            # pre-2.0 name ``MagentaRT2System`` is no longer re-exported at the
            # top level). Use the current name, falling back defensively.
            try:
                from magenta_rt import MagentaRT2Jax as MagentaRT2
            except ImportError:  # older/renamed API
                from magenta_rt.jax.system import MagentaRT2System as MagentaRT2

            self.device = str(jax.devices()[0])
            self.gpus = len(jax.devices())
            # Decide the split before a tensor moves. The one-card plan against
            # what JAX may take on one card: a model that will not fit with
            # room for the compile and the stream goes straight to the split
            # when there is a second card, instead of failing a minute into a
            # one-card load first. Measured on two 2080 Tis, the split runs at
            # less than half the one-card speed (0.33x against 0.76x realtime
            # for mrt2_base), so it is never chosen for a model one card holds.
            shard = SHARD
            one_card = _checkpoint_plan(MODEL, 1)
            limit = (_memory_stats(jax).get("per_device") or [{}])[0].get("bytes_limit")
            if not shard and self.gpus > 1 and one_card and isinstance(limit, int):
                need = int(one_card["resident_bytes"] * LOAD_HEADROOM)
                if need > limit:
                    shard = True
                    print(
                        f"[magenta] {MODEL} needs about {need / 2**30:.2f} GiB on one card and "
                        f"JAX may take {limit / 2**30:.2f} GiB there: loading it split across "
                        f"{self.gpus} cards",
                        flush=True,
                    )
            used, how = _install_lean_loader(jax, PARAMS_DTYPE, shard)
            self.sharded = used > 1
            self.plan = one_card if used == 1 else _checkpoint_plan(MODEL, used)
            if self.plan:
                gib = 2**30
                print(
                    f"[magenta] {MODEL}: {self.plan['on_disk_bytes'] / gib:.2f} GiB on disk, "
                    f"{self.plan['resident_bytes'] / gib:.2f} GiB resident as {how}, "
                    f"{self.plan['per_card_bytes'] / gib:.2f} GiB per card",
                    flush=True,
                )
            self.status = f"loading {MODEL} ({how}) + compiling (one-time)"
            self.mrt = MagentaRT2(size=MODEL)
            self.sample_rate = int(getattr(self.mrt, "_sample_rate", 48000))
            self.gpu = _memory_stats(jax)
            # Warm up so the first real request is fast; the first call carries
            # the compile, the second is timed so /health can say how far past
            # realtime this card runs the model.
            emb = self.mrt.embed_style("warm up", use_mapper=True)
            self.mrt.generate(style=emb, frames=FPS)
            t0 = time.time()
            self.mrt.generate(style=emb, frames=WARMUP_TIMED_FRAMES)
            took = max(1e-6, time.time() - t0)
            self.realtime_factor = round((WARMUP_TIMED_FRAMES / FPS) / took, 2)
            self.gpu = _memory_stats(jax)
            self.ready = True
            self.status = "ready"
            in_use = self.gpu.get("bytes_in_use")
            print(
                f"[magenta] READY on {self.device} (model={MODEL}, {how}, "
                f"{(in_use or 0) / 2**30:.2f} GiB in use, {self.realtime_factor}x realtime)",
                flush=True,
            )
        except Exception as e:  # noqa: BLE001 — surface load failures in /health
            self.error = f"{type(e).__name__}: {e}"
            self.status = "error: " + self.error
            try:
                import jax as _jax

                self.gpu_at_error = _memory_stats(_jax)
            except Exception:  # noqa: BLE001 — no stats is still an error report
                self.gpu_at_error = None
            traceback.print_exc()

    @staticmethod
    def _style_key(sources: list[dict], seed: int) -> str:
        basis = [
            (
                s.get("type", "text"),
                (s.get("text") or "").strip(),
                (s.get("audio_b64") or "")[:48],
                round(float(s.get("weight", 1.0)), 4),
            )
            for s in sources
        ]
        return hashlib.sha1((repr(basis) + f"|seed={seed}").encode()).hexdigest()

    def _embed_one(self, src: dict, seed: int):
        """Embed one style source: a text prompt OR an uploaded audio clip."""
        if src.get("type") == "audio" and src.get("audio_b64"):
            from magenta_rt import audio as mrt_audio

            raw = base64.b64decode(src["audio_b64"])
            samples, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
            wf = mrt_audio.Waveform(samples, sample_rate=int(sr))
            return self.mrt.embed_style(wf, use_mapper=True, seed=int(seed))
        text = (src.get("text") or "warm analog pads").strip()
        return self.mrt.embed_style(text, use_mapper=True, seed=int(seed))

    def build_style(self, prompt: str, styles: list[dict] | None, seed: int):
        """One style embedding from a prompt, or a weighted blend of text/audio
        sources (overrides prompt). Returns (embedding, cache_key)."""
        sources = (
            list(styles)
            if styles
            else [{"type": "text", "text": prompt, "weight": 1.0}]
        )
        key = self._style_key(sources, seed)
        emb = self._embed_cache.get(key)
        if emb is None:
            embs, weights = [], []
            for s in sources:
                embs.append(np.asarray(self._embed_one(s, seed), dtype=np.float32))
                weights.append(max(0.0, float(s.get("weight", 1.0))))
            w = np.asarray(weights, dtype=np.float32)
            if w.sum() <= 0:
                w = np.ones_like(w)
            emb = np.average(np.stack(embs, axis=0), axis=0, weights=w).astype(
                np.float32
            )
            if len(self._embed_cache) > 32:
                self._embed_cache.clear()
            self._embed_cache[key] = emb
        return emb, key


ENGINE = Engine()
app = FastAPI(title="theDAW MRT2 sidecar")


class _Cancelled(Exception):
    """The take's cancel arrived (POST /cancel)."""


def _notes_state_for_window(
    timeline: list[dict], start_f: int, fps: int
) -> list[int] | None:
    """Build the 128-pitch note-state array (per system.py) for a chunk.

    Per pitch 0-127: 2 = onset in this frame, 1 = held, 0 = off (pitch used
    elsewhere but silent now), -1 = masked (pitch never used -> model free to
    harmonize). Returns None if the timeline is empty.
    """
    if not timeline:
        return None
    used = set()
    state = [-1] * 128
    for ev in timeline:
        try:
            pitch = int(ev["pitch"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= pitch <= 127):
            continue
        used.add(pitch)
        s = float(ev.get("start", 0.0)) * fps
        e = float(ev.get("end", 0.0)) * fps
        if s <= start_f < e:
            # onset if the note begins within this frame, else held
            state[pitch] = 2 if int(round(s)) == start_f else 1
    for p in used:
        if state[p] < 0:
            state[p] = 0  # used pitch, silent this window
    return state


@app.get("/health")
async def health():
    return {
        # Identity field: theDAW's backend probe uses this to tell the extended
        # sidecar apart from the bundled Studio server (which also answers
        # ready:true on these ports but speaks an incompatible JSON protocol).
        "app": "mrt2-extended",
        "ready": ENGINE.ready,
        "status": ENGINE.status,
        "error": ENGINE.error,
        "model": MODEL,
        "device": ENGINE.device,
        "sample_rate": ENGINE.sample_rate,
        # How this process holds the model, and what it holds: the allocator
        # mode, the params' dtype, whether the tensors are cut across cards and
        # how many cards JAX sees; the layout the checkpoint header promised;
        # JAX's own byte counts now and, after a failed load, at the moment it
        # failed. The backend writes its OOM message from these — nvidia-smi
        # on the Windows side does not reliably reflect a WSL process.
        "allocator": ALLOCATOR_MODE,
        "params_dtype": ENGINE.params_dtype,
        "sharded": ENGINE.sharded,
        "gpus": ENGINE.gpus,
        "plan": ENGINE.plan,
        "gpu": ENGINE.gpu,
        "gpu_at_error": ENGINE.gpu_at_error,
        "realtime_factor": ENGINE.realtime_factor,
    }


@app.post("/reset")
async def reset():
    """Drop the evolving-piece state so the next generate starts a fresh track."""
    ENGINE._gen = None
    return {"ok": True}


@app.post("/cancel")
async def cancel(request_id: str = Form(...)):
    """Stop the take named ``request_id``: before it starts, or at its next
    rendered chunk. Its /generate then answers 409 ``{"cancelled": true}`` and
    the extend state keeps the piece as it was before that take."""
    ENGINE.cancel(request_id)
    return {"ok": True, "busy": ENGINE.lock.locked()}


@app.post("/generate")
async def generate(
    prompt: str = Form(""),
    duration: float = Form(10.0),
    temperature: float = Form(1.3),
    top_k: int = Form(40),
    cfg_musiccoca: float = Form(3.0),
    cfg_notes: float = Form(1.0),
    cfg_drums: float = Form(1.0),
    drums: int = Form(-1),
    chunk_frames: int = Form(FPS),
    notes: str = Form(""),
    seed: int = Form(0),
    extend: bool = Form(False),
    styles: str = Form(""),
    audio: UploadFile | None = None,
    request_id: str = Form(""),
):
    if not ENGINE.ready:
        return JSONResponse(
            {"error": "engine not ready", "status": ENGINE.status}, status_code=503
        )

    try:
        timeline: list[dict] = json.loads(notes) if notes.strip() else []
    except json.JSONDecodeError:
        return JSONResponse({"error": "notes must be JSON"}, status_code=400)
    try:
        style_list: list[dict] = json.loads(styles) if styles.strip() else []
    except json.JSONDecodeError:
        return JSONResponse({"error": "styles must be JSON"}, status_code=400)

    audio_bytes = await audio.read() if audio is not None else None
    # A single uploaded clip with no explicit blend list IS the audio style source.
    if audio_bytes and not style_list:
        style_list = [
            {
                "type": "audio",
                "audio_b64": base64.b64encode(audio_bytes).decode(),
                "weight": 1.0,
            }
        ]
    has_audio_style = any(s.get("type") == "audio" for s in style_list)

    def _check() -> None:
        if ENGINE.is_cancelled(request_id):
            raise _Cancelled()

    def _run():
        # One take at a time; a take cancelled while it waits never starts.
        while not ENGINE.lock.acquire(timeout=0.25):
            _check()
        try:
            _check()
            t0 = time.time()
            prev = ENGINE._gen if extend else None
            emb, key = ENGINE.build_style(
                prompt or "warm analog pads", style_list, int(seed or 0)
            )
            if prev is not None and prev.get("key") == key:
                emb = prev["emb"]  # same vibe across an extend — keep the embedding
            total = max(1, int(round(float(duration) * FPS)))
            chunk = max(1, int(chunk_frames))
            common = dict(
                style=emb,
                temperature=float(temperature),
                top_k=int(top_k),
                cfg_musiccoca=float(cfg_musiccoca),
                cfg_notes=float(cfg_notes),
                cfg_drums=float(cfg_drums),
                drums=[int(drums)],
            )

            # extend=True continues the current piece via the model's streaming
            # state, so changing the prompt/style/notes morphs it without a cut.
            state = prev["state"] if prev is not None else None
            parts = []
            if not timeline:
                # No note timing to honor, so use a big chunk to minimize
                # host<->device round-trips (the audio is identical regardless).
                nn_chunk = max(chunk, NO_NOTES_CHUNK)
                done = 0
                while done < total:
                    _check()
                    n = min(nn_chunk, total - done)
                    wav, state = ENGINE.mrt.generate(frames=n, state=state, **common)
                    parts.append(np.asarray(wav.samples, dtype=np.float32))
                    done += n
            else:
                # MIDI-conditioned accompaniment: per-chunk note states, threaded state.
                for start_f in range(0, total, chunk):
                    _check()
                    n = min(chunk, total - start_f)
                    ns = _notes_state_for_window(timeline, start_f, FPS)
                    wav, state = ENGINE.mrt.generate(
                        frames=n, state=state, notes=ns, **common
                    )
                    parts.append(np.asarray(wav.samples, dtype=np.float32))

            # Cancelled after the last chunk: the take is dropped all the same,
            # and the extend state keeps the piece as it was.
            _check()
            seg = np.concatenate(parts, axis=0)
            sr = ENGINE.sample_rate
            if prev is not None and prev.get("samples") is not None:
                full = np.concatenate([prev["samples"], seg], axis=0)
            else:
                full = seg
            ENGINE._gen = {
                "state": state,
                "emb": emb,
                "key": key,
                "samples": full,
                "sr": sr,
            }
            compute = time.time() - t0
        finally:
            ENGINE.lock.release()
        buf = io.BytesIO()
        sf.write(buf, full, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue(), compute, full.shape[0] / sr, seg.shape[0] / sr, sr

    try:
        import anyio

        wav_bytes, compute, audio_s, seg_s, sr = await anyio.to_thread.run_sync(_run)
        rtf = (seg_s / compute) if compute > 0 else 0.0
        cond = "audio" if has_audio_style else ("notes" if timeline else "text")
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Generate-Seconds": f"{compute:.2f}",
                "X-Audio-Seconds": f"{audio_s:.2f}",
                "X-Segment-Seconds": f"{seg_s:.2f}",
                "X-RTF": f"{rtf:.2f}",
                "X-Sample-Rate": str(sr),
                "X-Extend": "1" if extend else "0",
                "X-Conditioning": cond,
            },
        )
    except _Cancelled:
        return JSONResponse({"error": "cancelled", "cancelled": True}, status_code=409)
    except Exception as e:  # noqa: BLE001 — return the real error to the client
        traceback.print_exc()
        return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=500)


def main() -> None:
    threading.Thread(target=ENGINE.load, daemon=True).start()
    print(f"[magenta] serving http://0.0.0.0:{PORT}  (model={MODEL})", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
