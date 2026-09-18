"""Run the SAME installed VST in an unembedded Pedalboard process.
No HTML crop/owner-window geometry is applied. Use this to isolate Ozone UI issues.
Requires theDAW's existing Pedalboard environment. Not tested against Ozone here.
API reference: https://spotify.github.io/pedalboard/reference/pedalboard.html
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import uuid


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plugin', type=Path, required=True)
    parser.add_argument('--plugin-name')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--preset', type=Path)
    parser.add_argument('--list-only', action='store_true')
    args = parser.parse_args()
    from pedalboard import load_plugin
    plugin_path = args.plugin.resolve(strict=True)
    directory = args.output_dir / f'vst-probe-{uuid.uuid4()}'
    directory.mkdir(parents=True, exist_ok=False)
    report = {'plugin_path': str(plugin_path), 'platform': platform.platform(),
              'pedalboard_version': importlib.metadata.version('pedalboard'),
              'started_at': datetime.now(timezone.utc).isoformat(), 'status': 'started'}
    try:
        plugin = load_plugin(str(plugin_path), plugin_name=args.plugin_name)
        for key in ('name', 'identifier', 'version', 'manufacturer_name', 'category'):
            report[key] = str(getattr(plugin, key, 'unavailable'))
        report['parameter_names'] = list(plugin.parameters)
        if args.preset:
            plugin.load_preset(str(args.preset.resolve(strict=True)))
        before = bytes(plugin.raw_state)
        (directory / 'before.bin').write_bytes(before)
        if not args.list_only:
            plugin.show_editor()  # This script runs on its process's main thread.
        after = bytes(plugin.raw_state)
        (directory / 'after.bin').write_bytes(after)
        report.update(status='complete', before_sha256=hashlib.sha256(before).hexdigest(),
                      after_sha256=hashlib.sha256(after).hexdigest(), state_changed=before != after)
    except Exception as exc:
        report.update(status='failed', error=f'{type(exc).__name__}: {exc}')
        raise
    finally:
        (directory / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(directory)

if __name__ == '__main__':
    main()
