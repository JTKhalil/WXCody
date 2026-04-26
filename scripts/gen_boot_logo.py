from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class BootLogoSpec:
    size: int = 240
    s: int = 12  # pixel block size used by firmware
    gap: int = 6
    bot_rgb: tuple[int, int, int] = (218, 17, 0)  # from firmware tft.color565(218, 17, 0)
    bg_rgb: tuple[int, int, int] = (0, 0, 0)
    text_rgb: tuple[int, int, int] = (255, 255, 255)


def _load_font(px: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    # Prefer a bundled Windows font to keep output stable.
    candidates = [
        r"C:\Windows\Fonts\consola.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for p in candidates:
        try:
            return ImageFont.truetype(p, px)
        except Exception:
            pass
    return ImageFont.load_default()


def _draw_claude_bot_pixel(draw: ImageDraw.ImageDraw, *, center_x: int, top_y: int, s: int, bot_rgb: tuple[int, int, int]):
    # Mirrors Cody firmware: drawClaudeBotPixelArt(centerX, topY, s)
    body_w = 10 * s
    body_h = 6 * s
    x0 = center_x - body_w // 2
    y0 = top_y

    # Body
    draw.rectangle([x0, y0, x0 + body_w - 1, y0 + body_h - 1], fill=bot_rgb)
    # Ears
    draw.rectangle([x0 - 2 * s, y0 + 2 * s, x0 - 1, y0 + 4 * s - 1], fill=bot_rgb)
    draw.rectangle([x0 + body_w, y0 + 2 * s, x0 + body_w + 2 * s - 1, y0 + 4 * s - 1], fill=bot_rgb)

    # Eyes (1*s squares) - firmware uses black eyes on orange bot
    eye = (0, 0, 0)
    draw.rectangle([x0 + 2 * s, y0 + 2 * s, x0 + 3 * s - 1, y0 + 3 * s - 1], fill=eye)
    draw.rectangle([x0 + 7 * s, y0 + 2 * s, x0 + 8 * s - 1, y0 + 3 * s - 1], fill=eye)

    # Legs (4)
    leg_y = y0 + body_h
    leg_h = 2 * s
    for lx in (1, 3, 6, 8):
        draw.rectangle([x0 + lx * s, leg_y, x0 + (lx + 1) * s - 1, leg_y + leg_h - 1], fill=bot_rgb)


def main():
    spec = BootLogoSpec()
    out_path = Path(__file__).resolve().parents[1] / "assets" / "splash_logo.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    img = Image.new("RGB", (spec.size, spec.size), spec.bg_rgb)
    draw = ImageDraw.Draw(img)

    bot_h = (6 * spec.s) + (2 * spec.s)

    msg = "Hello Cody"
    # The firmware uses textSize=2 for Adafruit_GFX default font. We approximate with a monospace font.
    font = _load_font(28)
    bbox = draw.textbbox((0, 0), msg, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    group_h = bot_h + spec.gap + text_h
    top_y = (spec.size - group_h) // 2

    _draw_claude_bot_pixel(draw, center_x=spec.size // 2, top_y=top_y, s=spec.s, bot_rgb=spec.bot_rgb)

    text_x = (spec.size - text_w) // 2
    text_y = top_y + bot_h + spec.gap
    # Firmware draws twice for bold-ish look.
    draw.text((text_x, text_y), msg, font=font, fill=spec.text_rgb)
    draw.text((text_x + 1, text_y), msg, font=font, fill=spec.text_rgb)

    img.save(out_path, format="PNG", optimize=True)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()

