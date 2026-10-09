"""Small, dependency-free compatibility rules for MAX photo upload responses.

The provider removed ``photoIds`` from its temporary upload URL.  The pinned
PyMAX 2.4.1 still requires it, although each photo upload is performed one at a
time and the response already carries the resulting opaque token.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qs, urlparse


class PhotoUploadResponseAmbiguous(ValueError):
    """The result cannot be safely associated with this one photo upload."""


def _token(entry: Any) -> str:
    value = entry.get("token") if isinstance(entry, Mapping) else getattr(entry, "token", None)
    return value.strip() if isinstance(value, str) else ""


def select_photo_upload_token(photos: Any, upload_url: str) -> str:
    """Return the token belonging to one provider photo-upload operation.

    Preserve PyMAX's old explicit-ID association when ``photoIds`` is present.
    The newer MAX endpoint omits that URL parameter, so accept its response only
    when it has exactly one nonempty token. Never select an arbitrary entry
    from an ambiguous response.
    """

    if not isinstance(photos, Mapping):
        raise PhotoUploadResponseAmbiguous("MAX photo response has no photo mapping")

    photo_ids = parse_qs(urlparse(upload_url).query).get("photoIds", [])
    if photo_ids:
        if len(photo_ids) != 1 or not isinstance(photo_ids[0], str) or not photo_ids[0]:
            raise PhotoUploadResponseAmbiguous("MAX photo URL contains an invalid photoIds value")
        token = _token(photos.get(photo_ids[0]))
        if not token:
            raise PhotoUploadResponseAmbiguous("MAX photo response has no token for photoIds")
        return token

    tokens = [_token(item) for item in photos.values()]
    tokens = [token for token in tokens if token]
    if len(tokens) != 1:
        raise PhotoUploadResponseAmbiguous("MAX photo response without photoIds is ambiguous")
    return tokens[0]
