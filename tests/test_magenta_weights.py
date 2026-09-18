"""The rules that lay the Magenta checkpoint out on the GPU.

mrt2_base is 9.16 GiB of fp32 on disk and did not fit an 11 GB card: the stock
loader put every tensor on the device as fp32, and JAX's cap hit 8.21 GiB in
use before the file finished. The model computes in bf16, so the depthformer
loads as bf16 (half the bytes, same arithmetic) and, with two cards, each tensor
is cut in half along one axis. These are those rules, tested from the shapes in
the real checkpoint's header.
"""

from __future__ import annotations

import importlib.util
import pathlib

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "magenta_weights",
    pathlib.Path(__file__).resolve().parents[1] / "sidecars" / "magenta" / "weights.py",
)
weights = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(weights)


# ── which tensors load as bf16 ──────────────────────────────────────────────


def test_the_depthformer_halves_and_the_codec_does_not():
    assert weights.should_halve(
        "params/depthformer/decoder/x_layers_0/ffn/kernel", "F32"
    )
    assert weights.should_halve(
        "params/depthformer/decoder/decoder_embedding/embedding", "F32"
    )
    assert not weights.should_halve("params/soundstream/decoder/conv/kernel", "F32"), (
        "the codec computes in fp32"
    )


def test_only_fp32_tensors_are_touched():
    """An integer table, or a tensor already bf16, is left as the file has it."""
    assert not weights.should_halve("params/depthformer/decoder/tokens", "I32")
    assert not weights.should_halve(
        "params/depthformer/decoder/x_layers_0/ffn/kernel", "BF16"
    )


# ── which axis to cut ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("shape", "devices", "axis"),
    [
        ((3072, 8192), 2, 1),  # the FFN up-projection: cut the 8192 side
        ((8192, 3072), 2, 0),  # the down-projection: cut the 8192 side
        ((12294, 3072), 2, 0),  # the embedding table: 12294 is even, 3072 is smaller
        ((12294, 3072), 4, 1),  # four cards: 12294 is not divisible by 4, 3072 is
        ((3072,), 2, 0),  # a bias of even length cuts too
        ((3071,), 2, None),  # an odd bias is replicated
        ((), 2, None),  # a scalar is replicated
        ((3072, 8192), 1, None),  # one card cuts nothing
    ],
)
def test_the_largest_divisible_axis_is_cut(shape, devices, axis):
    assert weights.shard_axis(shape, devices) == axis


def test_partition_spec_names_the_mesh_axis_once():
    assert weights.partition_spec((3072, 8192), 2) == (None, "m")
    assert weights.partition_spec((8192, 3072), 2) == ("m", None)
    assert weights.partition_spec((3071,), 2) == (None,)
    assert weights.partition_spec((), 2) == ()
    assert weights.partition_spec((3072, 8192), 1) == (None, None)


# ── the plan, from the real checkpoint's header ─────────────────────────────


def _base_header() -> dict[str, tuple[str, tuple[int, ...]]]:
    """A cut-down mrt2_base: the embedding, one temporal layer's FFN pair and
    biases, and a codec conv. The real file has 618 leaves of the same kinds."""
    return {
        "params/depthformer/decoder/decoder_embedding/embedding/embedding": (
            "F32",
            (12294, 3072),
        ),
        "params/depthformer/decoder/temporal_body/transformer/x_layers_0/ffn/ff_up/kernel": (
            "F32",
            (3072, 8192),
        ),
        "params/depthformer/decoder/temporal_body/transformer/x_layers_0/ffn/ff_down/kernel": (
            "F32",
            (8192, 3072),
        ),
        "params/depthformer/decoder/temporal_body/transformer/x_layers_0/ffn/ff_up/bias": (
            "F32",
            (8192,),
        ),
        "params/depthformer/decoder/temporal_body/transformer/x_layers_0/norm/scale": (
            "F32",
            (3072,),
        ),
        "params/soundstream/decoder/conv_0/kernel": ("F32", (7, 512, 512)),
    }


def test_the_plan_halves_the_depthformer_and_keeps_the_codec():
    p = weights.plan(_base_header(), devices=1)
    depth_disk = (12294 * 3072 + 3072 * 8192 * 2 + 8192 + 3072) * 4
    codec_disk = 7 * 512 * 512 * 4
    assert p["on_disk_bytes"] == depth_disk + codec_disk
    assert p["resident_bytes"] == depth_disk // 2 + codec_disk, (
        "depthformer halved, codec whole"
    )
    assert p["per_card_bytes"] == p["resident_bytes"], "one card holds everything"
    assert p["cut"] == 0 and p["replicated"] == 6


def test_two_cards_each_hold_half_of_every_cut_tensor():
    one = weights.plan(_base_header(), devices=1)
    two = weights.plan(_base_header(), devices=2)
    assert two["resident_bytes"] == one["resident_bytes"], (
        "the split changes what is resident, not how much"
    )
    assert two["cut"] == 6, "every tensor here has an even axis, the codec's included"
    assert two["per_card_bytes"] == one["resident_bytes"] // 2


def test_the_real_base_checkpoint_fits_where_it_did_not():
    """The numbers the failure was measured against: 9.16 GiB on disk, an
    8.25 GiB cap. As bf16 the depthformer is under 4.6 GiB, and split in two
    each card holds under 2.4."""
    gib = 2**30
    # 618 leaves; the sizes that matter: 8.97 GiB depthformer, 0.20 GiB codec.
    header = {
        f"params/depthformer/blob_{i}": ("F32", (2, int(8.97 * gib / 4 / 618 / 2)))
        for i in range(618)
    }
    header["params/soundstream/blob"] = ("F32", (2, int(0.20 * gib / 4 / 2)))
    one = weights.plan(header, devices=1)
    two = weights.plan(header, devices=2)
    assert abs(one["on_disk_bytes"] - 9.17 * gib) < 0.02 * gib
    assert one["resident_bytes"] < 4.7 * gib
    assert one["resident_bytes"] < 8.25 * gib, (
        "under the cap that stopped the fp32 load"
    )
    assert two["per_card_bytes"] < 2.4 * gib
