"""Add the section header to callout screenshots.

Reads docs/guides/screenshots/callouts/raw/<slug>.png + <slug>.json
({"title": ..., "subtitle": ...}) and writes the labelled image to
docs/guides/screenshots/callouts/<slug>.png. Raw captures are kept.

    uv run python scripts/screenshots/callouts/label_callouts.py            # all
    uv run python scripts/screenshots/callouts/label_callouts.py 03-make    # some
"""

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
OUT = (
    Path(os.environ["SHOTS_DIR"])
    if os.environ.get("SHOTS_DIR")
    else ROOT / "docs" / "guides" / "screenshots" / "callouts"
)
RAW = OUT / "raw"
FONTS = Path("C:/Windows/Fonts")

BG = (18, 10, 28)
ACCENT = (255, 210, 31)
FG = (245, 240, 255)
MUTED = (200, 188, 222)


def fit(
    draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int
) -> str:
    if draw.textlength(text, font=font) <= width:
        return text
    while text and draw.textlength(text + "…", font=font) > width:
        text = text[:-1]
    return text + "…"


def label(src: Path, title: str, subtitle: str) -> Image.Image:
    img = Image.open(src).convert("RGB")
    w = img.width
    s = max(0.55, min(1.0, w / 1920))
    head = int((104 if subtitle else 70) * s)
    big = ImageFont.truetype(str(FONTS / "segoeuib.ttf"), int(34 * s))
    small = ImageFont.truetype(str(FONTS / "segoeui.ttf"), int(21 * s))
    out = Image.new("RGB", (w, img.height + head), BG)
    out.paste(img, (0, head))
    d = ImageDraw.Draw(out)
    d.rectangle([0, 0, int(10 * s), head], fill=ACCENT)
    d.rectangle([0, head - 4, w, head], fill=ACCENT)
    pad = int(28 * s)
    d.text((pad, int(10 * s)), fit(d, title, big, w - 2 * pad), font=big, fill=FG)
    if subtitle:
        d.text(
            (pad, int(60 * s)),
            fit(d, subtitle, small, w - 2 * pad),
            font=small,
            fill=MUTED,
        )
    return out


def main() -> None:
    wanted = set(sys.argv[1:])
    for src in sorted(RAW.glob("*.png")):
        if wanted and src.stem not in wanted:
            continue
        meta_file = src.with_suffix(".json")
        meta = (
            json.loads(meta_file.read_text(encoding="utf-8"))
            if meta_file.exists()
            else {}
        )
        label(src, meta.get("title", src.stem), meta.get("subtitle", "")).save(
            OUT / src.name
        )
        print("labelled", src.name)


if __name__ == "__main__":
    main()
