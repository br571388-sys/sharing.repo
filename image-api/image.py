"""Image service for the Nobara bot (deploy on Vercel as a Python function).

Endpoints (POST, JSON body, header X-Image-Key must equal the IMAGE_API_KEY environment variable):
  /leaderboard  {title, period, from, to, rows: [{name, username, score, avatar}]}  -> PNG
  /couple       {names: [a, b], avatars: [base64 | null, base64 | null]}            -> PNG

`avatar` is base64 JPEG/PNG bytes sent by the bot, or null. A null avatar is drawn as a default circle with the initial.
Errors are JSON: {"error": "..."} with HTTP 400 (bad input), 401 (wrong key), 413 (too large), 500 (drawing failed).
"""

import base64
import hmac
import io
import os

from flask import Flask, jsonify, request
from PIL import Image, ImageDraw, ImageFont

app = Flask(__name__)

MAX_BODY_BYTES = 6 * 1024 * 1024
MAX_AVATAR_BYTES = 2 * 1024 * 1024
MAX_ROWS = 10
MAX_PNG_BYTES = 5 * 1024 * 1024
FONT_PATH = os.path.join(os.path.dirname(__file__), "fonts", "NotoSans-Bold.ttf")


class BadInput(Exception):
    pass


def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default(size=size)


def clean_text(value, limit=40):
    text = str(value or "").replace("\n", " ").strip()
    return text[:limit] or "Member"


def decode_avatar(data, size):
    """Returns a square RGBA image of `size` px, or None when there is no usable avatar."""
    if not data:
        return None
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, TypeError):
        raise BadInput("avatar is not valid base64")
    if len(raw) > MAX_AVATAR_BYTES:
        raise BadInput("avatar is too large")
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        raise BadInput("avatar is not an image")
    side = min(img.size)
    img = img.crop(((img.width - side) // 2, (img.height - side) // 2, (img.width + side) // 2, (img.height + side) // 2))
    return img.resize((size, size), Image.LANCZOS)


def circle_avatar(img, name, size, colour):
    """Round avatar. Without a picture, a coloured circle with the first letter."""
    if img is None:
        img = Image.new("RGBA", (size, size), colour)
        d = ImageDraw.Draw(img)
        letter = (name[:1] or "?").upper()
        f = font(int(size * 0.5))
        box = d.textbbox((0, 0), letter, font=f)
        d.text(((size - (box[2] - box[0])) / 2 - box[0], (size - (box[3] - box[1])) / 2 - box[1]), letter, font=f, fill=(255, 255, 255, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def gradient(width, height, top, bottom):
    base = Image.new("RGB", (width, height), top)
    d = ImageDraw.Draw(base)
    for y in range(height):
        t = y / max(1, height - 1)
        d.line([(0, y), (width, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return base.convert("RGBA")


def png_response(img):
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG", optimize=True)
    data = buf.getvalue()
    if len(data) > MAX_PNG_BYTES:
        raise RuntimeError("generated image is too large")
    return app.response_class(data, mimetype="image/png")


def check_key():
    expected = os.environ.get("IMAGE_API_KEY", "")
    if not expected:
        return jsonify(error="IMAGE_API_KEY is not configured on the image service"), 500
    given = request.headers.get("X-Image-Key", "")
    if not hmac.compare_digest(given, expected):
        return jsonify(error="unauthorized"), 401
    return None


def json_body():
    if request.content_length and request.content_length > MAX_BODY_BYTES:
        raise BadInput("request is too large")
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise BadInput("expected a JSON object")
    return body


@app.errorhandler(BadInput)
def bad_input(err):
    return jsonify(error=str(err)), 400


@app.post("/leaderboard")
def leaderboard():
    denied = check_key()
    if denied:
        return denied
    body = json_body()
    rows = body.get("rows")
    if not isinstance(rows, list) or not rows or len(rows) > MAX_ROWS:
        raise BadInput(f"rows must be a list of 1 to {MAX_ROWS} entries")
    try:
        width, row_h, top = 900, 96, 150
        height = top + row_h * len(rows) + 120
        canvas = gradient(width, height, (24, 26, 56), (70, 24, 88))
        d = ImageDraw.Draw(canvas)
        d.text((40, 40), clean_text(body.get("title", "Leaderboard"), 40), font=font(44), fill=(255, 255, 255, 255))
        d.text((40, 100), f"{clean_text(body.get('period', ''), 20)}  ·  {clean_text(body.get('from', ''), 12)} to {clean_text(body.get('to', ''), 12)}", font=font(22), fill=(200, 200, 230, 255))
        for i, r in enumerate(rows):
            y = top + i * row_h
            d.rounded_rectangle((30, y, width - 30, y + row_h - 14), radius=22, fill=(255, 255, 255, 28))
            d.text((50, y + 26), f"{i + 1}", font=font(30), fill=(255, 221, 120, 255))
            avatar = circle_avatar(decode_avatar(r.get("avatar"), 60), clean_text(r.get("name")), 60, (90, 80, 160, 255))
            canvas.paste(avatar, (110, y + 12), avatar)
            name = clean_text(r.get("name"))
            username = clean_text(r.get("username"), 32) if r.get("username") else ""
            d.text((195, y + 14), name, font=font(28), fill=(255, 255, 255, 255))
            if username:
                d.text((195, y + 48), f"@{username}", font=font(18), fill=(180, 190, 230, 255))
            score = str(int(r.get("score") or 0))
            d.text((width - 60 - d.textlength(score, font=font(30)), y + 24), score, font=font(30), fill=(120, 255, 190, 255))
        return png_response(canvas)
    except BadInput:
        raise
    except Exception:
        return jsonify(error="could not draw the leaderboard"), 500


@app.post("/couple")
def couple():
    denied = check_key()
    if denied:
        return denied
    body = json_body()
    names = body.get("names")
    avatars = body.get("avatars")
    if not isinstance(names, list) or len(names) != 2 or not isinstance(avatars, list) or len(avatars) != 2:
        raise BadInput("names and avatars must each contain two entries")
    try:
        width, height = 900, 560
        canvas = gradient(width, height, (255, 120, 160), (120, 60, 200))
        size = 220
        centers = [(230, 240), (670, 240)]
        for i in range(2):
            name = clean_text(names[i])
            avatar = circle_avatar(decode_avatar(avatars[i], size), name, size, (60, 40, 120, 255))
            cx, cy = centers[i]
            ring = Image.new("RGBA", (size + 16, size + 16), (0, 0, 0, 0))
            ImageDraw.Draw(ring).ellipse((0, 0, size + 15, size + 15), fill=(255, 255, 255, 255))
            canvas.paste(ring, (cx - size // 2 - 8, cy - size // 2 - 8), ring)
            canvas.paste(avatar, (cx - size // 2, cy - size // 2), avatar)
            d = ImageDraw.Draw(canvas)
            f = font(30)
            d.text((cx - d.textlength(name, font=f) / 2, cy + size // 2 + 24), name, font=f, fill=(255, 255, 255, 255))
        # heart between the two pictures
        heart = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        hd = ImageDraw.Draw(heart)
        hx, hy, r = width // 2, 200, 46
        hd.ellipse((hx - r * 1.1, hy - r, hx, hy + r * 0.2), fill=(255, 60, 110, 255))
        hd.ellipse((hx, hy - r, hx + r * 1.1, hy + r * 0.2), fill=(255, 60, 110, 255))
        hd.polygon([(hx - r * 1.05, hy + r * 0.05), (hx + r * 1.05, hy + r * 0.05), (hx, hy + r * 1.35)], fill=(255, 60, 110, 255))
        canvas = Image.alpha_composite(canvas, heart)
        return png_response(canvas)
    except BadInput:
        raise
    except Exception:
        return jsonify(error="could not draw the couple picture"), 500


@app.get("/")
def health():
    return jsonify(ok=True, service="nobara-image")
