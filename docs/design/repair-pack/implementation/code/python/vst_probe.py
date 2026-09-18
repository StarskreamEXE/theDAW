"""Native-editor isolation probe; run from theDAW's locked Python environment.

Opens a FLOATING native plugin GUI, with no Electron reparenting. Does not load
untrusted state or process audio. Native crashes can terminate this subprocess.
Use the exact same binary/class as the failing theDAW instance.
"""
from __future__ import annotations
import argparse
import base64
import json
import os
import tempfile
from pathlib import Path


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, indent=2)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        Path(temp_name).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", type=Path, required=True)
    parser.add_argument("--plugin-name", help="Explicit class name for a multi-plugin container")
    parser.add_argument("--state-out", type=Path, required=True)
    args = parser.parse_args()
    import pedalboard
    kwargs = {"plugin_name": args.plugin_name} if args.plugin_name else {}
    plugin = pedalboard.load_plugin(str(args.plugin.resolve(strict=True)), **kwargs)
    report = {"path": str(args.plugin), "name": plugin.name,
              "manufacturer": getattr(plugin, "manufacturer_name", None),
              "identifier": getattr(plugin, "identifier", None),
              "version": getattr(plugin, "version", None),
              "reported_latency_samples": getattr(plugin, "reported_latency_samples", None)}
    print(json.dumps(report, indent=2), flush=True)
    plugin.show_editor()  # main thread; blocks until close
    report["raw_state_base64"] = base64.b64encode(bytes(plugin.raw_state)).decode("ascii")
    atomic_json(args.state_out, report)


if __name__ == "__main__":
    main()
