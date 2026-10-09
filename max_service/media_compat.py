"""Safe normalization and type detection for MAX sticker payloads."""

from __future__ import annotations

import gzip
import io
import json
from typing import Final

MAX_LOTTIE_JSON_BYTES: Final = 4 * 1024 * 1024


class LottiePayloadError(ValueError):
    """A claimed compressed Lottie sticker cannot be served as JSON safely."""


def normalize_lottie_payload(payload: bytes, limit: int = MAX_LOTTIE_JSON_BYTES) -> bytes | None:
    """Return a validated plain JSON Lottie document, or ``None`` for static media.

    MAX sometimes describes a static sticker as Lottie.  Only a JSON object is
    handed to the animation player.  Gzip/TGS data is unpacked with a fixed
    bound; raw JSON is accepted as-is after the same validation.
    """

    if limit < 1:
        raise ValueError("limit must be positive")
    decoded = payload
    if payload.startswith(b"\x1f\x8b"):
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(payload), mode="rb") as stream:
                decoded = stream.read(limit + 1)
                if len(decoded) > limit or stream.read(1):
                    raise LottiePayloadError("MAX Lottie sticker exceeds the limit")
        except LottiePayloadError:
            raise
        except OSError as error:
            raise LottiePayloadError("MAX sticker is not a valid gzip Lottie document") from error
    elif len(decoded) > limit:
        return None

    if not decoded.lstrip().startswith(b"{"):
        return None
    try:
        parsed = json.loads(decoded.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        if payload.startswith(b"\x1f\x8b"):
            raise LottiePayloadError("MAX sticker is not a valid gzip Lottie document") from error
        return None
    if not isinstance(parsed, dict):
        if payload.startswith(b"\x1f\x8b"):
            raise LottiePayloadError("MAX Lottie root must be an object")
        return None
    return decoded


def static_media_mime(payload: bytes, upstream_mime: str = "") -> str:
    """Return a safe image/video MIME when static MAX media has no useful type."""

    mime = upstream_mime.split(";", 1)[0].strip().lower()
    if mime.startswith(("image/", "video/")):
        return mime
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if payload.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if payload.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        return "image/webp"
    if payload.startswith(b"\x1aE\xdf\xa3"):
        return "video/webm"
    if len(payload) >= 12 and payload[4:8] == b"ftyp":
        return "video/mp4"
    return mime or "application/octet-stream"
