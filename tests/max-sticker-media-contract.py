"""Offline MAX sticker relay checks; no network or provider account."""

from __future__ import annotations

import gzip
import json
import sys
import unittest
import ast
from typing import Any
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "max_service"))
from media_compat import LottiePayloadError, normalize_lottie_payload, static_media_mime


class TooLarge(Exception):
    def __init__(self, *, max_size: int, actual_size: int) -> None:
        self.max_size = max_size
        self.actual_size = actual_size


class FakeWeb:
    HTTPRequestEntityTooLarge = TooLarge


def load_limited_reader():
    """Execute the exact sidecar helper without importing provider modules."""
    source_path = Path(__file__).resolve().parents[1] / "max_service" / "app.py"
    parsed = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    function = next(
        node for node in parsed.body
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "read_stream_limited"
    )
    module = ast.Module(body=[function], type_ignores=[])
    namespace = {"Any": Any, "web": FakeWeb}
    exec(compile(ast.fix_missing_locations(module), str(source_path), "exec"), namespace)
    return namespace["read_stream_limited"]


class FragmentedStream:
    def __init__(self, fragments: list[bytes]) -> None:
        self.fragments = iter(fragments)
        self.read_sizes: list[int] = []

    async def read(self, size: int) -> bytes:
        self.read_sizes.append(size)
        return next(self.fragments, b"")


class MaxStickerMediaCompatibilityTests(unittest.TestCase):
    def test_valid_tgs_becomes_plain_lottie_json(self) -> None:
        original = json.dumps({"v": "5.7.0", "fr": 30, "layers": []}).encode()
        self.assertEqual(normalize_lottie_payload(gzip.compress(original)), original)

    def test_plain_lottie_json_is_kept_as_json(self) -> None:
        original = json.dumps({"v": "5.7.0", "fr": 30, "layers": []}).encode()
        self.assertEqual(normalize_lottie_payload(original), original)

    def test_static_sticker_is_not_rewritten_and_gets_a_real_mime(self) -> None:
        png = b"\x89PNG\r\n\x1a\nfixture"
        self.assertIsNone(normalize_lottie_payload(png))
        self.assertEqual(static_media_mime(png, "application/octet-stream"), "image/png")

    def test_invalid_gzip_is_rejected(self) -> None:
        with self.assertRaises(LottiePayloadError):
            normalize_lottie_payload(b"\x1f\x8bnot-a-gzip-stream")

    def test_gzip_bomb_is_rejected_with_a_bound(self) -> None:
        with self.assertRaises(LottiePayloadError):
            normalize_lottie_payload(gzip.compress(b"{" + b" " * 128 + b"}"), limit=32)

    def test_chunked_sticker_body_is_read_until_eof(self) -> None:
        async def check() -> None:
            stream = FragmentedStream([b"{\"v\":", b"\"5.7\",", b"\"layers\":[]}"])
            body = await load_limited_reader()(stream, 128)
            self.assertEqual(body, b'{"v":"5.7","layers":[]}')
            self.assertGreaterEqual(len(stream.read_sizes), 4, "reader must continue after the first TCP fragment")

        import asyncio
        asyncio.run(check())

    def test_chunked_sticker_body_stops_after_limit(self) -> None:
        async def check() -> None:
            stream = FragmentedStream([b"a" * 3, b"b" * 3])
            with self.assertRaises(TooLarge) as raised:
                await load_limited_reader()(stream, 5)
            self.assertEqual(raised.exception.max_size, 5)
            self.assertEqual(raised.exception.actual_size, 6)

        import asyncio
        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
