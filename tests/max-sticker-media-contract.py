"""Offline MAX sticker relay checks; no network or provider account."""

from __future__ import annotations

import gzip
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "max_service"))
from media_compat import LottiePayloadError, normalize_lottie_payload, static_media_mime


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


if __name__ == "__main__":
    unittest.main()
