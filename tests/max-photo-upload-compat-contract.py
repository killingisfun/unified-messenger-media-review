"""Offline checks for MAX photo-upload response compatibility; no network or account."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "max_service"))
from upload_compat import PhotoUploadResponseAmbiguous, select_photo_upload_token


class PhotoUploadCompatibilityTests(unittest.TestCase):
    def test_legacy_url_uses_its_explicit_photo_id(self) -> None:
        token = select_photo_upload_token(
            {"first": {"token": "first-token"}, "second": {"token": "second-token"}},
            "https://upload.example/path?photoIds=second",
        )
        self.assertEqual(token, "second-token")

    def test_new_url_accepts_only_one_returned_token(self) -> None:
        token = select_photo_upload_token(
            {"provider-generated-id": {"token": "new-token"}},
            "https://upload.example/path?requestId=opaque",
        )
        self.assertEqual(token, "new-token")

    def test_new_url_never_selects_an_arbitrary_photo(self) -> None:
        with self.assertRaises(PhotoUploadResponseAmbiguous):
            select_photo_upload_token(
                {"one": {"token": "one-token"}, "two": {"token": "two-token"}},
                "https://upload.example/path?requestId=opaque",
            )

    def test_old_url_never_falls_back_to_another_photo(self) -> None:
        with self.assertRaises(PhotoUploadResponseAmbiguous):
            select_photo_upload_token(
                {"other": {"token": "other-token"}},
                "https://upload.example/path?photoIds=expected",
            )


if __name__ == "__main__":
    unittest.main()
