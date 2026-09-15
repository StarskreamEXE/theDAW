"""How the Magenta RT2 checkpoint is laid out on the GPU: which tensors load as
bf16, and how each one splits across cards.

Pure: no jax, no numpy, nothing that needs the sidecar's venv, so the rules can
be tested by the app's own test suite. server.py applies them.

Why bf16. The checkpoint is fp32 on disk — mrt2_base is 9.16 GiB of it, 8.97
GiB in the depthformer — and magenta_rt's stock loader puts every tensor on the
device as fp32 before anything runs. The model computes in bf16 regardless
(compute_dtype), so fp32 params buy nothing the model can use: they are cast
down for every matmul. Loading the depthformer as bf16 halves its resident size
to 4.5 GiB and changes no arithmetic. The audio codec (soundstream, 0.20 GiB)
computes in fp32 and stays fp32.

Why a split. A 2.4B-parameter model that is 4.5 GiB as bf16 fits one 11 GB card
with room, and one 6 GB card barely. With two cards, each parameter tensor can
be cut in half along one axis and each card holds its half; XLA's partitioner
then runs each matmul as two half-matmuls and exchanges the small activations.
Every one of the 618 tensors has an axis divisible by 2.
"""

from __future__ import annotations

# The parameter subtree that loads as bf16. Everything else keeps its dtype.
HALVE_PREFIXES: tuple[str, ...] = ("params/depthformer/",)

#: safetensors' name for a 32-bit float tensor.
F32 = "F32"


def should_halve(
    key: str, dtype: str, prefixes: tuple[str, ...] = HALVE_PREFIXES
) -> bool:
    """Whether the tensor `key` (safetensors dtype name `dtype`) loads as bf16.

    Only fp32 tensors under a halving prefix. An integer table, a bf16 tensor
    already, or anything in the codec is left exactly as the file has it.
    """
    return dtype == F32 and key.startswith(prefixes)


def shard_axis(shape: tuple[int, ...], devices: int) -> int | None:
    """The axis of `shape` to cut into `devices` equal parts, or None to
    replicate the tensor whole on every card.

    Picks the largest axis divisible by `devices`, so the cut removes the most
    bytes from each card. A tensor with no such axis — a bias of odd length, a
    scalar — is small, and replicating it costs little. One device means
    nothing to cut.
    """
    if devices < 2 or not shape:
        return None
    best: int | None = None
    for axis, dim in enumerate(shape):
        if (
            dim >= devices
            and dim % devices == 0
            and (best is None or dim > shape[best])
        ):
            best = axis
    return best


def partition_spec(
    shape: tuple[int, ...], devices: int, mesh_axis: str = "m"
) -> tuple[str | None, ...]:
    """The PartitionSpec entries for `shape`: `mesh_axis` on the sharded axis,
    None everywhere else. Empty for a replicated scalar."""
    axis = shard_axis(shape, devices)
    return tuple(mesh_axis if i == axis else None for i in range(len(shape)))


def plan(leaves: dict[str, tuple[str, tuple[int, ...]]], devices: int) -> dict:
    """What the load will put on each card, from the checkpoint's header alone.

    `leaves` maps tensor name to (safetensors dtype, shape). Returns bytes on
    disk, bytes resident once halved, bytes per card once split, and how many
    tensors are cut versus replicated. This is the number /health reports before
    the load starts, so a card that cannot hold the model is told so up front.
    """
    size_of = {
        "F32": 4,
        "BF16": 2,
        "F16": 2,
        "I32": 4,
        "I64": 8,
        "BOOL": 1,
        "I8": 1,
        "U8": 1,
    }
    on_disk = 0
    resident = 0
    per_card = 0
    cut = 0
    replicated = 0
    for key, (dtype, shape) in leaves.items():
        n = 1
        for d in shape:
            n *= d
        disk = n * size_of.get(dtype, 4)
        on_disk += disk
        here = n * (2 if should_halve(key, dtype) else size_of.get(dtype, 4))
        resident += here
        if shard_axis(shape, devices) is None:
            replicated += 1
            per_card += here
        else:
            cut += 1
            per_card += here // devices
    return {
        "leaves": len(leaves),
        "on_disk_bytes": on_disk,
        "resident_bytes": resident,
        "per_card_bytes": per_card,
        "devices": devices,
        "cut": cut,
        "replicated": replicated,
    }
