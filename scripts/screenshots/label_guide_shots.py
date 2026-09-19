"""Burn a section label onto every user-guide screenshot.

Reads raw captures from docs/guides/screenshots/raw/NN-slug.png, looks up
section NN's title in theDAW_Practical_Plain_English_User_Guide.md, takes an
optional one-line caption from raw/captions.json, and writes the labelled
image to docs/guides/screenshots/NN-slug.png. The raw capture is kept.

    uv run python scripts/screenshots/label_guide_shots.py
"""

import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
GUIDE = ROOT / "docs" / "guides" / "theDAW_Practical_Plain_English_User_Guide.md"
OUT = ROOT / "docs" / "guides" / "screenshots"
RAW = OUT / "raw"
FONTS = Path("C:/Windows/Fonts")

BG = (18, 10, 28)
ACCENT = (168, 85, 247)
FG = (245, 240, 255)
MUTED = (190, 175, 215)


def section_titles() -> dict[int, str]:
    titles = {}
    for line in GUIDE.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^# (\d+)\. (.+)$", line)
        if m:
            titles[int(m.group(1))] = m.group(2).strip()
    return titles


def label(src: Path, title: str, caption: str) -> Image.Image:
    img = Image.open(src).convert("RGB")
    w = img.width
    scale = max(0.6, min(1.0, w / 1920))
    head = int(96 * scale) if caption else int(64 * scale)
    big = ImageFont.truetype(str(FONTS / "segoeuib.ttf"), int(30 * scale))
    small = ImageFont.truetype(str(FONTS / "segoeui.ttf"), int(20 * scale))

    out = Image.new("RGB", (w, img.height + head), BG)
    out.paste(img, (0, head))
    d = ImageDraw.Draw(out)
    d.rectangle([0, 0, int(8 * scale), head], fill=ACCENT)
    d.rectangle([0, head - 3, w, head], fill=ACCENT)
    pad = int(24 * scale)
    d.text((pad, int(12 * scale)), title, font=big, fill=FG)
    if caption:
        d.text((pad, int(56 * scale)), caption, font=small, fill=MUTED)
    return out


def main() -> None:
    titles = section_titles()
    captions_file = RAW / "captions.json"
    captions = (
        json.loads(captions_file.read_text(encoding="utf-8"))
        if captions_file.exists()
        else {}
    )
    for src in sorted(RAW.glob("[0-9][0-9]-*.png")):
        n = int(src.name[:2])
        title = f"SECTION {n} — {titles.get(n, src.stem)}"
        label(src, title, captions.get(src.name, "")).save(OUT / src.name)
        print("labelled", src.name)


if __name__ == "__main__":
    main()
