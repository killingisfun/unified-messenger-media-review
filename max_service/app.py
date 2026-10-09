"""Private MAX QR-authentication sidecar.

This process owns the unofficial-client session and is deliberately separate
from the PHP application database.  It listens only on loopback and exposes a
small, versioned contract to ``max_auth.php``:

* GET  /v1/status
* GET  /v1/profile
* GET  /v1/chats
* GET  /v1/chats/{chat_id}/history
* POST /v1/auth/start
* POST /v1/auth/password

Message actions use fixed, account-scoped routes. The PHP adapter and the
sidecar both validate the selected chat; no provider URL or token crosses this
boundary.
The browser receives a rendered QR image only through the existing local
bridge after an explicit user action.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import logging
import os
import re
import secrets
import json
import time
from http import HTTPStatus
from urllib.parse import quote, urlparse
from collections import deque
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Iterable

import aiohttp
from aiohttp import web
import qrcode
from qrcode.image.svg import SvgPathImage
from pymax import WebClient, File, Photo
from pymax.auth.qr import QrAuthFlow
from pymax.api.response import payload_item
from pymax.api.uploads.models import PhotoUploadResponse
from pymax.api.uploads.payloads import AttachPhotoPayload, UploadPayload
from pymax.api.uploads.service import UploadService
from pymax.exceptions import ApiError, UploadError
from persistent_state import AvatarCache, ReadBoundaries
from pymax.protocol import Opcode
from pymax.types.domain import Chat
from media_compat import LottiePayloadError, normalize_lottie_payload, static_media_mime
from upload_compat import PhotoUploadResponseAmbiguous, select_photo_upload_token


LOG = logging.getLogger("unified_max")
MAX_QR_DATA_URL_BYTES = 512 * 1024
MAX_READ_LIMIT = 50
MAX_READ_TIMEOUT_SECONDS = 12
MAX_HISTORY_QUEUE_TIMEOUT_SECONDS = 3
MAX_SHORT_READ_QUEUE_TIMEOUT_SECONDS = 3
MAX_TRAINING_TEXT_LIMIT = 4000
MAX_TRAINING_REACTIONS = frozenset({"👍", "❤️", "😂", "😮", "😢", "🙏"})
MAX_TRAINING_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_TRAINING_BATCH_FILES = 10
MAX_TRAINING_BATCH_BYTES = 20 * 1024 * 1024
MAX_TRAINING_PHOTO_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"})
MAX_REALTIME_EVENT_LIMIT = 256
# History pages can remain open while a person scrolls through an archive.
# Keep the opaque relay reference alive long enough for that normal workflow;
# the token still never exposes a provider URL and is bounded by the existing
# in-memory token cap.
MAX_MEDIA_TOKEN_TTL_SECONDS = 24 * 60 * 60
MAX_MEDIA_RELAY_BYTES = 200 * 1024 * 1024
MAX_STICKER_RELAY_BYTES = 2 * 1024 * 1024


async def read_stream_limited(stream: Any, limit: int) -> bytes:
    """Read a complete finite response without trusting one TCP fragment."""
    body = bytearray()
    while True:
        chunk = await stream.read(64 * 1024)
        if not chunk:
            return bytes(body)
        body.extend(chunk)
        if len(body) > limit:
            raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(body))


async def max_upload_photo_compatible(
    upload_service: UploadService, photo: Photo, profile: bool = False
) -> AttachPhotoPayload:
    """Bridge PyMAX 2.4.1 across MAX's photo-upload URL protocol change.

    MAX now omits ``photoIds`` from an otherwise normal one-photo upload URL.
    Do not guess an attachment when the returned photo map is ambiguous.
    """

    try:
        response = await upload_service.app.invoke(
            Opcode.PHOTO_UPLOAD, payload=UploadPayload(profile=profile).to_payload()
        )
        upload_url = payload_item(response, "url", str)
        if not upload_url:
            raise UploadError("MAX did not provide a photo upload URL")
        photo_data = photo.validate_photo()
        if not photo_data:
            raise UploadError("MAX rejected the photo type")
        photo_bytes = await photo.read()
    except UploadError:
        raise
    except Exception as error:
        raise UploadError("MAX photo upload preparation failed") from error

    form = aiohttp.FormData()
    form.add_field(
        name="file",
        value=photo_bytes,
        filename=f"image.{quote(photo_data[0])}",
        content_type=photo_data[1],
    )
    try:
        timeout = aiohttp.ClientTimeout(total=60, sock_read=60)
        async with aiohttp.ClientSession(
            proxy=upload_service.app.config.proxy, timeout=timeout
        ) as session:
            async with session.post(upload_url, data=form) as http_response:
                if http_response.status != HTTPStatus.OK:
                    raise UploadError(
                        f"MAX photo upload failed with status {http_response.status}"
                    )
                payload = await http_response.json()
        model = PhotoUploadResponse.model_validate(payload)
        token = select_photo_upload_token(model.photos, upload_url)
    except UploadError:
        raise
    except PhotoUploadResponseAmbiguous as error:
        LOG.warning("MAX photo upload response was ambiguous; attachment was not sent")
        raise UploadError("MAX photo upload response was ambiguous") from error
    except Exception as error:
        raise UploadError("MAX photo upload failed") from error
    return AttachPhotoPayload(photo_token=token)


# PyMAX performs each ``Photo`` upload independently before it builds one
# send_message request. Replacing only that private upload step keeps all chat,
# reply, send-result and no-resend rules in the pinned library unchanged.
UploadService.upload_photo = max_upload_photo_compatible
MAX_VIDEO_CDN_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9",
    "Origin": "https://m.ok.ru",
    "Referer": "https://m.ok.ru/",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
}


class AuthState(StrEnum):
    DISCONNECTED = "disconnected"
    QR_READY = "qr_ready"
    AUTHORIZING = "authorizing"
    PASSWORD_REQUIRED = "password_required"
    CONNECTED = "connected"
    ERROR = "error"


class SavedSessionLoginRequired(RuntimeError):
    """A saved session was unusable; only an explicit UI action may show QR."""


class RealtimeEventJournal:
    """Small persistent cursor journal for neutral MAX realtime hints.

    Events carry only provider IDs. Consumers must re-read the canonical
    history/reaction snapshot, so a delayed or duplicate event cannot invent
    message content or overwrite a newer provider state.
    """

    def __init__(self, path: Path, limit: int = MAX_REALTIME_EVENT_LIMIT) -> None:
        self.path = path
        self.limit = limit
        self.account_id = ""
        self.sequence = 0
        self.events: deque[dict[str, Any]] = deque(maxlen=limit)
        self._load()

    def _load(self) -> None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            stored_account = payload.get("account_id", "") if isinstance(payload, dict) else ""
            if isinstance(stored_account, str) and re.fullmatch(r"[1-9][0-9]{0,19}", stored_account):
                self.account_id = stored_account
            items = payload.get("events", []) if isinstance(payload, dict) else []
            if not isinstance(items, list):
                return
            for item in items[-self.limit:]:
                if not isinstance(item, dict):
                    continue
                sequence = item.get("sequence")
                event = item.get("event")
                chat_id = item.get("chat_id")
                message_id = item.get("message_id")
                if not isinstance(sequence, int) or sequence < 1 or event not in {"new_message", "reaction_update", "read_update"}:
                    continue
                if not isinstance(chat_id, str) or not isinstance(message_id, str):
                    continue
                stored = {"sequence": sequence, "event": event, "source": "MAX", "chat_id": chat_id, "message_id": message_id}
                if event == "read_update":
                    boundary = item.get("read_until_ms")
                    if not isinstance(boundary, int) or boundary <= 0:
                        continue
                    stored["read_until_ms"] = boundary
                self.events.append(stored)
                self.sequence = max(self.sequence, sequence)
        except FileNotFoundError:
            return
        except Exception:
            LOG.warning("MAX realtime journal was ignored", exc_info=True)

    def _save(self) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps({"version": 2, "account_id": self.account_id, "cursor": self.sequence, "events": list(self.events)}, separators=(",", ":")), encoding="utf-8")
        os.chmod(temp, 0o600)
        temp.replace(self.path)

    def bind_account(self, account_id: Any) -> None:
        """Never replay event cursors across two personal MAX sessions."""
        account = str(account_id if account_id is not None else "").strip()
        if not re.fullmatch(r"[1-9][0-9]{0,19}", account):
            raise ValueError("invalid MAX account id")
        if self.account_id == account:
            return
        self.account_id = account
        self.sequence = 0
        self.events.clear()
        self._save()

    def publish(self, event: str, chat_id: Any, message_id: Any) -> None:
        chat = str(chat_id if chat_id is not None else "").strip()
        message = str(message_id if message_id is not None else "").strip()
        if event not in {"new_message", "reaction_update", "read_update"} or not re.fullmatch(r"-?[0-9]{1,20}", chat) or not re.fullmatch(r"[1-9][0-9]{0,19}", message):
            return
        self.sequence += 1
        item = {"sequence": self.sequence, "event": event, "source": "MAX", "chat_id": chat, "message_id": message}
        if event == "read_update":
            item["read_until_ms"] = int(message)
            item["message_id"] = ""  # A timestamp is not a native message ID.
        self.events.append(item)
        self._save()

    def after(self, cursor: int) -> dict[str, Any]:
        oldest = self.events[0]["sequence"] if self.events else self.sequence + 1
        # A browser cursor from a previous account/session can be newer than
        # this freshly bound journal. It must force a history reread instead
        # of silently returning an empty event page.
        reset_required = bool(cursor > self.sequence or (self.events and cursor < oldest - 1))
        items = list(self.events) if reset_required else [item for item in self.events if item["sequence"] > cursor]
        return {"cursor": self.sequence, "oldest_cursor": oldest, "reset_required": reset_required, "events": items}


class ReplyLinkJournal:
    """Persist only locally-confirmed outgoing MAX reply relations.

    Some history pages omit ReplyLink even though MAX accepted a reply. The
    sent native ID and proven target are enough to retain the UI quote across
    a sidecar restart without guessing from message order.
    """

    def __init__(self, path: Path, limit: int = 500) -> None:
        self.path = path
        self.limit = limit
        self.account_id = ""
        self.links: dict[str, dict[str, str]] = {}
        self._load()

    def _load(self) -> None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            account = payload.get("account_id", "") if isinstance(payload, dict) else ""
            if isinstance(account, str) and re.fullmatch(r"[1-9][0-9]{0,19}", account):
                self.account_id = account
            raw_links = payload.get("links", {}) if isinstance(payload, dict) else {}
            if not isinstance(raw_links, dict):
                return
            for sent_id, item in list(raw_links.items())[-self.limit:]:
                if not re.fullmatch(r"[1-9][0-9]{0,19}", str(sent_id)) or not isinstance(item, dict):
                    continue
                target_id = str(item.get("message_id", ""))
                if not re.fullmatch(r"[1-9][0-9]{0,19}", target_id):
                    continue
                self.links[str(sent_id)] = {
                    "message_id": target_id,
                    "text": str(item.get("text", "") or "")[:4000],
                    "author_name": str(item.get("author_name", "Сообщение") or "Сообщение")[:128],
                }
        except FileNotFoundError:
            return
        except Exception:
            LOG.warning("MAX reply-link journal was ignored", exc_info=True)

    def _save(self) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps({"version": 1, "account_id": self.account_id, "links": self.links}, separators=(",", ":")), encoding="utf-8")
        os.chmod(temp, 0o600)
        temp.replace(self.path)

    def bind_account(self, account_id: Any) -> None:
        account = str(account_id if account_id is not None else "").strip()
        if not re.fullmatch(r"[1-9][0-9]{0,19}", account):
            raise ValueError("invalid MAX account id")
        if self.account_id == account:
            return
        self.account_id = account
        self.links.clear()
        self._save()

    def record(self, sent_id: str, target: Any, account_id: str) -> None:
        if self.account_id != account_id or not re.fullmatch(r"[1-9][0-9]{0,19}", sent_id):
            return
        target_id = str(getattr(target, "id", "") or "")
        if not re.fullmatch(r"[1-9][0-9]{0,19}", target_id):
            return
        sender = str(getattr(target, "sender", "") or "")
        self.links[sent_id] = {
            "message_id": target_id,
            "text": str(getattr(target, "text", "") or "")[:4000],
            "author_name": "Вы" if sender == account_id else "Сообщение",
        }
        if len(self.links) > self.limit:
            self.links = dict(list(self.links.items())[-self.limit:])
        self._save()

    def lookup(self, sent_id: Any) -> dict[str, str] | None:
        item = self.links.get(str(sent_id))
        return dict(item) if item is not None else None


class MediaTokenJournal:
    """Keep opaque archive-media handles across a controlled sidecar restart.

    This file remains in the service's private runtime directory.  It is not a
    message database and is never exposed to PHP or the browser; it contains
    only bounded, expiring relay handles and enough native metadata to refresh
    file/video URLs through the authenticated MAX client.
    """

    def __init__(self, path: Path, limit: int = 512) -> None:
        self.path = path
        self.limit = limit

    def load(self) -> dict[str, tuple[int, int, int, str, int, str, float]]:
        entries: dict[str, tuple[int, int, int, str, int, str, float]] = {}
        now = time.time()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            rows = payload.get("entries", []) if isinstance(payload, dict) else []
            if not isinstance(rows, list):
                return entries
            for row in rows[-self.limit:]:
                if not isinstance(row, dict):
                    continue
                token = str(row.get("token", ""))
                kind = str(row.get("kind", ""))
                try:
                    chat_id = int(row.get("chat_id"))
                    message_id = int(row.get("message_id"))
                    index = int(row.get("index"))
                    attachment_id = int(row.get("attachment_id", 0))
                    expires = float(row.get("expires", 0))
                except (TypeError, ValueError):
                    continue
                stored_url = str(row.get("stored_url", ""))
                if (not re.fullmatch(r"[A-Za-z0-9_-]{20,128}", token)
                        or kind not in {"photo", "file", "video", "audio", "sticker"}
                        or message_id < 1 or index < 0 or expires <= now):
                    continue
                if kind in {"file", "video"} and attachment_id < 1:
                    continue
                if kind in {"photo", "audio", "sticker"} and not re.match(r"^https://", stored_url, re.I):
                    continue
                entries[token] = (chat_id, message_id, index, kind, attachment_id, stored_url, expires)
        except FileNotFoundError:
            pass
        except Exception:
            LOG.warning("MAX media-token journal was ignored", exc_info=True)
        return entries

    def save(self, tokens: dict[str, tuple[int, int, int, str, int, str, float]]) -> None:
        now = time.time()
        rows = [
            {
                "token": token, "chat_id": entry[0], "message_id": entry[1],
                "index": entry[2], "kind": entry[3], "attachment_id": entry[4],
                "stored_url": entry[5], "expires": entry[6],
            }
            for token, entry in list(tokens.items())[-self.limit:]
            if entry[3] != "avatar" and entry[6] > now
        ]
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps({"version": 1, "entries": rows}, separators=(",", ":")), encoding="utf-8")
            os.chmod(temp, 0o600)
            temp.replace(self.path)
        except OSError:
            LOG.warning("MAX media-token journal was not saved", exc_info=True)


@dataclass
class RuntimeState:
    state: AuthState = AuthState.DISCONNECTED
    qr_image: str = ""
    error_code: str = ""
    task: asyncio.Task[None] | None = None
    client: WebClient | None = None
    password_queue: asyncio.Queue[str] = field(default_factory=asyncio.Queue)

    def snapshot(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "success": True,
            "status": self.state.value,
            "read_only": True,
            "can_send": self.state == AuthState.CONNECTED,
        }
        if self.state == AuthState.QR_READY and self.qr_image:
            payload["qrcode"] = self.qr_image
        if self.state == AuthState.ERROR:
            payload["code"] = self.error_code or "auth_failed"
        return payload


def qr_image_data_url(qr_url: str) -> str:
    """Render a QR locally; never return the login link to the browser."""
    # SvgPathImage belongs to qrcode itself and avoids a Pillow dependency in
    # this small always-on service.  The login URL stays inside the generated
    # image; it is never returned as text or logged.
    image = qrcode.make(qr_url, image_factory=SvgPathImage)
    buffer = io.BytesIO()
    image.save(buffer)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    data_url = "data:image/svg+xml;base64," + encoded
    if len(data_url) > MAX_QR_DATA_URL_BYTES:
        raise ValueError("qr_image_too_large")
    return data_url


def public_error_code(error: BaseException) -> str:
    """Keep stack traces, tokens and provider payloads out of the UI."""
    text = str(error).lower()
    if "expired" in text and "qr" in text:
        return "qr_expired"
    if "password" in text or "2fa" in text:
        return "password_failed"
    if any(part in text for part in ("timeout", "connection", "network", "websocket")):
        return "connection_failed"
    return "auth_failed"


class UiQrHandler:
    def __init__(self, state: RuntimeState, *, allow_qr: bool) -> None:
        self._state = state
        self._allow_qr = allow_qr

    async def show_qr(self, qr_url: str) -> None:
        if not self._allow_qr:
            raise SavedSessionLoginRequired("saved_session_requires_new_qr")
        self._state.qr_image = qr_image_data_url(qr_url)
        self._state.error_code = ""
        self._state.state = AuthState.QR_READY


class UiPasswordProvider:
    """Suspends the auth flow until the owner enters 2FA in the local UI."""

    def __init__(self, state: RuntimeState) -> None:
        self._state = state

    async def get_password(self, _hint: str | None = None) -> str:
        self._state.qr_image = ""
        self._state.error_code = ""
        self._state.state = AuthState.PASSWORD_REQUIRED
        return await self._state.password_queue.get()


class MaxAuthService:
    def __init__(self, work_dir: Path, session_name: str) -> None:
        self.work_dir = work_dir
        self.session_name = session_name
        self.runtime = RuntimeState()
        self.lock = asyncio.Lock()
        # One scheduler owns every provider read. History yields to a queued
        # short read, but it never waits on a second lock outside this budget.
        self._read_schedule = asyncio.Condition()
        self._read_busy = False
        self._short_read_waiters = 0
        self.write_lock = asyncio.Lock()
        self.realtime_events = RealtimeEventJournal(work_dir / "realtime-events.json")
        self.reply_links = ReplyLinkJournal(work_dir / "reply-links.json")
        self.media_token_journal = MediaTokenJournal(work_dir / "media-tokens.json")
        # token -> (chat ID, message ID, attachment index, kind, attachment ID,
        #           direct MAX media URL if one exists, epoch expiry). The browser sees
        # only the opaque token; provider URLs remain process-local.
        self.media_tokens = self.media_token_journal.load()
        self.avatar_cache = AvatarCache(work_dir / "avatar-cache")
        self.avatar_lock = asyncio.Lock()
        self.read_boundaries = ReadBoundaries(work_dir / "read-boundaries.json")

    def persist_media_tokens(self) -> None:
        self.media_token_journal.save(self.media_tokens)

    async def start_authentication(self) -> dict[str, Any]:
        async with self.lock:
            if self.runtime.state == AuthState.CONNECTED and self.runtime.client is not None and self.runtime.client.is_connected:
                return self.runtime.snapshot()
            task = self.runtime.task
            if task is not None and not task.done():
                return self.runtime.snapshot()

            self.work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.runtime = RuntimeState(state=AuthState.AUTHORIZING)
            self.runtime.task = asyncio.create_task(self._run_client(allow_qr=True), name="max-qr-auth")
            return self.runtime.snapshot()

    async def resume_saved_session(self) -> None:
        """Reconnect a previously authorized session without making a new QR."""
        async with self.lock:
            if not (self.work_dir / self.session_name).is_file():
                return
            task = self.runtime.task
            if task is not None and not task.done():
                return
            self.runtime = RuntimeState(state=AuthState.AUTHORIZING)
            self.runtime.task = asyncio.create_task(self._run_client(allow_qr=False), name="max-session-resume")

    async def submit_password(self, password: str) -> dict[str, Any]:
        # The password is immediately placed into the in-memory queue.  It is
        # never logged or persisted by this sidecar.
        if self.runtime.state != AuthState.PASSWORD_REQUIRED:
            raise web.HTTPConflict(text='{"success":false,"message":"Пароль сейчас не запрошен."}', content_type="application/json")
        if not password or len(password) > 512:
            raise web.HTTPUnprocessableEntity(text='{"success":false,"message":"Пароль имеет неверный формат."}', content_type="application/json")
        await self.runtime.password_queue.put(password)
        self.runtime.state = AuthState.AUTHORIZING
        return self.runtime.snapshot()

    async def _run_client(self, *, allow_qr: bool) -> None:
        runtime = self.runtime
        try:
            flow = QrAuthFlow(UiQrHandler(runtime, allow_qr=allow_qr), password_provider=UiPasswordProvider(runtime))
            client = WebClient(work_dir=str(self.work_dir), session_name=self.session_name, auth_flow=flow)
            runtime.client = client

            @client.on_start()
            async def _on_start(_client: WebClient) -> None:
                # The journal is account-scoped before it accepts a single
                # event. A newly authorised personal account can therefore
                # never inherit a prior account's cursor after a service
                # restart or browser reload.
                profile = serialize_profile(_client)
                previous_account = self.realtime_events.account_id
                self.realtime_events.bind_account(profile["id"])
                if previous_account != profile["id"]:
                    # Tokens must never outlive the MAX account that issued
                    # them.  The account journal is the boundary on restart.
                    self.media_tokens.clear()
                    self.persist_media_tokens()
                self.reply_links.bind_account(profile["id"])
                self.avatar_cache.bind(profile["id"])
                self.read_boundaries.bind(profile["id"])
                runtime.qr_image = ""
                runtime.error_code = ""
                runtime.state = AuthState.CONNECTED

            @client.on_message()
            async def _on_message(message: Any, _client: WebClient) -> None:
                self.realtime_events.publish("new_message", getattr(message, "chat_id", None), getattr(message, "id", None))

            @client.on_reaction_update()
            async def _on_reaction_update(event: Any, _client: WebClient) -> None:
                self.realtime_events.publish("reaction_update", getattr(event, "chat_id", None), getattr(event, "message_id", None))

            @client.on_message_read()
            async def _on_message_read(event: Any, _client: WebClient) -> None:
                await self.record_peer_read(event, _client)

            await client.start()
            if runtime.state != AuthState.CONNECTED:
                runtime.state = AuthState.DISCONNECTED
        except asyncio.CancelledError:
            raise
        except SavedSessionLoginRequired:
            runtime.qr_image = ""
            runtime.error_code = "new_qr_required"
            runtime.state = AuthState.DISCONNECTED
        except Exception as error:  # the detailed exception is service-only
            runtime.qr_image = ""
            runtime.error_code = public_error_code(error)
            runtime.state = AuthState.ERROR
            LOG.warning("MAX authentication task ended: %s", runtime.error_code)

    async def record_peer_read(self, event: Any, _client: WebClient) -> None:
        if getattr(event, "set_as_unread", True):
            return
        own = serialize_profile(_client)["id"]
        if str(getattr(event, "user_id", "")) == own:
            return
        chat_id = getattr(event, "chat_id", None)
        try:
            chat = next((row for row in (getattr(_client, "chats", None) or []) if getattr(row, "id", None) == chat_id), None)
            if chat is None or direct_peer_id(chat, own) is None:
                chat = await self.read(lambda client: client.get_chat(chat_id))
            peer = direct_peer_id(chat, own)
            if peer is None or peer != getattr(event, "user_id", None):
                return
            mark = int(getattr(event, "mark", 0) or 0)
            if self.read_boundaries.advance(chat_id, mark):
                self.realtime_events.publish("read_update", chat_id, mark)
        except Exception:
            LOG.warning("MAX peer read event could not be verified", exc_info=True)

    async def close(self) -> None:
        task = self.runtime.task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if self.runtime.client is not None:
            try:
                await self.runtime.client.close()
            except Exception:
                LOG.debug("MAX client close failed", exc_info=True)

    async def logout(self) -> dict[str, Any]:
        await self.close()
        try:
            (self.work_dir / self.session_name).unlink(missing_ok=True)
        except OSError:
            pass
        # A later login, including a different MAX account, must never reuse
        # opaque references minted for the just-logged-out account.
        self.media_tokens.clear()
        try:
            self.media_token_journal.path.unlink(missing_ok=True)
        except OSError:
            LOG.warning("MAX media-token journal could not be removed on logout", exc_info=True)
        self.runtime = RuntimeState(state=AuthState.DISCONNECTED)
        return self.runtime.snapshot()

    def connected_client(self) -> WebClient:
        client = self.runtime.client
        if self.runtime.state != AuthState.CONNECTED or client is None or not client.is_connected:
            raise web.HTTPConflict(
                text='{"success":false,"code":"max_not_connected","message":"MAX ещё не подключён."}',
                content_type="application/json",
            )
        return client

    async def read(self, callback: Any, *, history: bool = False, timeout: float = MAX_READ_TIMEOUT_SECONDS) -> Any:
        """Serialize provider reads with one queue and one operation deadline."""
        client = self.connected_client()
        loop = asyncio.get_running_loop()
        queue_timeout = MAX_HISTORY_QUEUE_TIMEOUT_SECONDS if history else MAX_SHORT_READ_QUEUE_TIMEOUT_SECONDS
        deadline = loop.time() + queue_timeout + timeout
        queue_deadline = min(deadline, loop.time() + queue_timeout)
        async with self._read_schedule:
            if not history:
                self._short_read_waiters += 1
            try:
                while self._read_busy or (history and self._short_read_waiters > 0):
                    remaining = queue_deadline - loop.time()
                    if remaining <= 0:
                        raise TimeoutError()
                    await asyncio.wait_for(self._read_schedule.wait(), timeout=remaining)
                self._read_busy = True
            finally:
                if not history:
                    self._short_read_waiters -= 1
        try:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError()
            return await asyncio.wait_for(callback(client), timeout=min(timeout, remaining))
        finally:
            async with self._read_schedule:
                self._read_busy = False
                self._read_schedule.notify_all()

    async def read_history(self, callback: Any) -> Any:
        """Run one history page at a time without starving short MAX reads."""
        return await self.read(callback, history=True)

    async def mark_chat_read(self, chat_id: int) -> dict[str, Any]:
        """Mark the newest known message read after the UI shows the chat."""
        client = self.connected_client()
        try:
            records = await self.read(
                lambda client: client.fetch_history(chat_id=chat_id, backward=1, interactive=False)
            )
            ordered = sorted(records or [], key=lambda item: int(getattr(item, "time", 0) or 0))
            if not ordered:
                return {"success": True, "read_only": False, "marked": False}
            message_id = str(getattr(ordered[-1], "id", "") or "")
            if not re.fullmatch(r"[1-9][0-9]{0,19}", message_id):
                return {"success": False, "code": "max_read_id_missing", "message": "MAX не вернул сообщение для отметки прочитанным."}
            async with self.write_lock:
                await asyncio.wait_for(client.read_message(int(message_id), chat_id), timeout=MAX_READ_TIMEOUT_SECONDS)
            return {"success": True, "read_only": False, "marked": True, "message_id": message_id}
        except (ApiError, TimeoutError, ConnectionError, OSError):
            return {"success": False, "code": "max_read_unknown", "message": "MAX не подтвердил отметку прочитанным."}
        except Exception:
            LOG.exception("MAX mark read failed chat_id=%s", chat_id)
            return {"success": False, "code": "max_read_failed", "message": "Не удалось отметить чат MAX прочитанным."}

    async def writable_chat(self, chat_id: int) -> tuple[WebClient, Any | None]:
        """Resolve a chat through the connected account before a mutation."""
        client = self.connected_client()
        try:
            async def resolve(active: WebClient) -> Any:
                chat = next((row for row in (getattr(client, "chats", None) or []) if int(getattr(row, "id", 0) or 0) == chat_id), None)
                if chat is None:
                    chat = await active.get_chat(chat_id)
                return chat
            chat = await self.read(resolve)
            if chat is None or int(getattr(chat, "id", 0) or 0) != chat_id:
                return client, None
            return client, chat
        except (ApiError, TimeoutError, ConnectionError, OSError):
            return client, None

    async def send_message(self, chat_id: int, text: str, reply_to: int | None = None) -> dict[str, Any]:
        """Send a text to a chat available to the connected MAX account."""
        client = self.connected_client()
        if not text or len(text) > MAX_TRAINING_TEXT_LIMIT:
            return {"success": False, "outcome": "rejected", "code": "max_invalid_text", "message": "Текст MAX имеет неверный формат."}
        _, chat = await self.writable_chat(chat_id)
        if chat is None:
            return {"success": False, "outcome": "rejected", "code": "max_chat_unavailable", "message": "Этот чат MAX недоступен подключённому аккаунту."}
        try:
            async with self.write_lock:
                if reply_to is not None:
                    original = await asyncio.wait_for(client.get_message(chat_id, reply_to), timeout=MAX_READ_TIMEOUT_SECONDS)
                    if original is None or getattr(original, "chat_id", None) is None or int(getattr(original, "chat_id")) != chat_id:
                        return {"success": False, "outcome": "rejected", "code": "max_reply_target_invalid", "message": "Исходное сообщение MAX не найдено в этом чате."}
                message = await asyncio.wait_for(
                    client.send_message(chat_id=chat_id, text=text, reply_to=reply_to, notify=False),
                    timeout=MAX_READ_TIMEOUT_SECONDS,
                )
            native_id = str(getattr(message, "id", "")).strip()
            if not native_id:
                return {"success": False, "outcome": "unknown", "code": "max_provider_id_missing", "message": "MAX не подтвердил идентификатор сообщения. Проверьте чат перед повтором."}
            # The library does not reliably emit an on_message callback for a
            # message created by this same client. Publish only after MAX has
            # returned its native id, so other open UI tabs re-read canonical
            # history without fabricating a message from the event itself.
            self.realtime_events.publish("new_message", chat_id, native_id)
            if reply_to is not None:
                self.reply_links.record(native_id, original, serialize_profile(client)["id"])
            return {"success": True, "outcome": "accepted", "send_state": "sent", "message_id": native_id, "message_ids": [native_id]}
        except ApiError:
            return {"success": False, "outcome": "rejected", "code": "max_provider_rejected", "message": "MAX отклонил отправку."}
        except (TimeoutError, ConnectionError, OSError):
            return {"success": False, "outcome": "unknown", "code": "max_transport_unknown", "message": "Результат отправки MAX неизвестен. Проверьте чат перед повтором."}
        except Exception:
            LOG.exception("MAX send failed")
            return {"success": False, "outcome": "unknown", "code": "max_send_unknown", "message": "Результат отправки MAX неизвестен. Проверьте чат перед повтором."}

    def issue_media_token(self, chat_id: int, message_id: int, index: int, attachment: Any, source_url_override: Any = None) -> str:
        raw_kind = getattr(attachment, "type", "")
        kind = str(getattr(raw_kind, "value", raw_kind)).lower()
        attachment_id = 0
        source_url = ""
        if kind == "file":
            attachment_id = int(getattr(attachment, "file_id", 0) or 0)
        elif kind == "video":
            attachment_id = int(getattr(attachment, "video_id", 0) or 0)
        elif kind == "photo":
            source_url = str(getattr(attachment, "base_url", "") or "")
        elif kind in {"audio", "sticker"}:
            # PyMax exposes these as direct CDN URLs; unlike files/videos,
            # there is no provider-side get_*_by_id method to refresh them.
            source_url = str(source_url_override or (getattr(attachment, "lottie_url", None) if kind == "sticker" else None) or getattr(attachment, "url", "") or "")
        if source_url.startswith("//"):
            source_url = "https:" + source_url
        if kind in {"photo", "audio", "sticker"}:
            if not re.match(r"^https://", source_url, re.I):
                return ""
        elif kind not in {"file", "video"} or attachment_id < 1:
            return ""
        now = time.time()
        self.media_tokens = {key: value for key, value in self.media_tokens.items() if value[6] > now}
        identity = (chat_id, message_id, index, kind, attachment_id, source_url)
        for token, entry in self.media_tokens.items():
            if entry[:6] == identity:
                return token
        # Keep the in-memory and persisted limits identical. Evict the entry
        # that expires first before adding a new opaque reference.
        while len(self.media_tokens) >= self.media_token_journal.limit:
            oldest = min(self.media_tokens, key=lambda token: self.media_tokens[token][6])
            self.media_tokens.pop(oldest, None)
        token = secrets.token_urlsafe(32)
        self.media_tokens[token] = (*identity, now + MAX_MEDIA_TOKEN_TTL_SECONDS)
        return token

    def issue_sticker_preview_token(self, chat_id: int, message_id: int, index: int, attachment: Any) -> str:
        """Serve a MAX static sticker rendition through the opaque relay."""
        raw_kind = getattr(attachment, "type", "")
        if str(getattr(raw_kind, "value", raw_kind)).lower() != "sticker":
            return ""
        # `lottie_url` is the animated payload.  When MAX also supplies `url`,
        # keep that static preview separate so an image fallback never tries
        # to decode compressed animation bytes.
        static_url = str(getattr(attachment, "url", "") or "")
        if not static_url:
            return ""
        return self.issue_media_token(chat_id, message_id, index, attachment, static_url)

    def issue_avatar_token(self, source_url: Any) -> str:
        """Return a persistent account-scoped opaque avatar reference.

        Provider CDN URLs must not cross the sidecar boundary.  Avatars use
        the existing media endpoint, so caching, size checks and URL allowlist
        stay in one audited path.
        """
        url = str(source_url or "")
        if url.startswith("//"):
            url = "https:" + url
        if not re.match(r"^https://", url, re.I):
            return ""
        return self.avatar_cache.issue(url)

    async def cached_avatar(self, token: str, request: web.Request) -> web.StreamResponse:
        self.connected_client()  # Do not expose a previous account during startup.
        lock = self.avatar_lock
        async with lock:
            entry = self.avatar_cache.lookup(token)
            if entry is None:
                raise web.HTTPNotFound()
            path = self.avatar_cache.directory / (token + ".img")
            if not path.exists():
                import aiohttp
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
                    async with session.get(entry["url"]) as upstream:
                        if upstream.status != 200:
                            raise web.HTTPBadGateway(text="avatar unavailable")
                        mime = upstream.headers.get("Content-Type", "").split(";", 1)[0].lower()
                        body = bytearray()
                        async for chunk in upstream.content.iter_chunked(65536):
                            body.extend(chunk)
                            if len(body) > self.avatar_cache.MAX_FILE:
                                raise web.HTTPRequestEntityTooLarge(max_size=self.avatar_cache.MAX_FILE, actual_size=len(body))
                        try:
                            self.avatar_cache.put(token, bytes(body), mime)
                        except ValueError:
                            raise web.HTTPBadGateway(text="invalid avatar")
            return web.FileResponse(path, headers={"Content-Type": entry["mime"], "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})

    async def media(self, token: str, http_request: web.Request) -> web.StreamResponse:
        if self.avatar_cache.lookup(token):
            return await self.cached_avatar(token, http_request)
        entry = self.media_tokens.get(token)
        now = time.time()
        if not entry or entry[6] <= now:
            raise web.HTTPNotFound(text='media token expired')
        chat_id, message_id, index, kind, attachment_id, stored_url, _ = entry
        url = stored_url
        if not url:
            async def resolve_media(client: WebClient) -> Any:
                if kind == "file":
                    return await client.get_file_by_id(chat_id, message_id, attachment_id)
                if kind == "video":
                    return await client.get_video_by_id(chat_id, message_id, attachment_id)
                return None
            media_request = await self.read(resolve_media)
            url = str(getattr(media_request, "url", "") or "")
            if url.startswith("//"):
                url = "https:" + url
        if not url or not re.match(r"^https://", url, re.I): raise web.HTTPNotFound(text='media unavailable')
        import aiohttp
        upstream_headers = dict(MAX_VIDEO_CDN_HEADERS) if kind == "video" else {"Accept": "*/*"}
        byte_range = http_request.headers.get("Range", "").strip()
        if byte_range:
            if not re.fullmatch(r"bytes=(?:\d+-\d*|-\d+)", byte_range):
                raise web.HTTPRequestRangeNotSatisfiable()
            upstream_headers["Range"] = byte_range
        timeout = aiohttp.ClientTimeout(total=180, connect=MAX_READ_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(headers=upstream_headers, timeout=timeout) as session:
            async with session.get(url, allow_redirects=False) as response:
                if response.status not in {200, 206, 416}:
                    raise web.HTTPBadGateway(text='media provider unavailable')
                length_raw = response.headers.get("Content-Length", "")
                content_length = int(length_raw) if length_raw.isdigit() else None
                if content_length is not None and content_length > MAX_MEDIA_RELAY_BYTES:
                    raise web.HTTPRequestEntityTooLarge(max_size=MAX_MEDIA_RELAY_BYTES, actual_size=content_length)
                mime = response.headers.get("Content-Type", "application/octet-stream").split(";", 1)[0]
                headers = {
                    "Cache-Control": "private, max-age=900",
                    "Content-Type": mime,
                    "X-Content-Type-Options": "nosniff",
                }
                # MAX supplies animated stickers as gzip-compressed TGS data
                # but labels the HTTP response application/octet-stream. The
                # UI correctly identifies it as Lottie from provider metadata,
                # yet the browser cannot parse the compressed bytes as JSON.
                # Normalize only a bounded gzip payload; ordinary static
                # stickers keep their original bytes and MIME type.
                if kind == "sticker":
                    packed = await read_stream_limited(response.content, MAX_STICKER_RELAY_BYTES)
                    try:
                        lottie = normalize_lottie_payload(packed)
                    except LottiePayloadError:
                        raise web.HTTPBadGateway(text="invalid MAX Lottie sticker")
                    if lottie is not None:
                        headers["Content-Type"] = "application/json"
                        headers["Content-Length"] = str(len(lottie))
                        return web.Response(body=lottie, headers=headers)
                    headers["Content-Type"] = static_media_mime(packed, mime)
                    headers["Content-Length"] = str(len(packed))
                    return web.Response(body=packed, headers=headers)
                for name in ("Content-Range", "Accept-Ranges"):
                    value = response.headers.get(name)
                    if value:
                        headers[name] = value
                if response.status != 416:
                    value = response.headers.get("Content-Length")
                    if value:
                        headers["Content-Length"] = value
                stream = web.StreamResponse(status=response.status, headers=headers)
                await stream.prepare(http_request)
                if http_request.method == "HEAD" or response.status == 416:
                    await stream.write_eof()
                    return stream
                sent = 0
                async for chunk in response.content.iter_chunked(64 * 1024):
                    sent += len(chunk)
                    if sent > MAX_MEDIA_RELAY_BYTES:
                        raise web.HTTPRequestEntityTooLarge(max_size=MAX_MEDIA_RELAY_BYTES, actual_size=sent)
                    await stream.write(chunk)
                await stream.write_eof()
                return stream

    async def refresh_media_token(self, chat_id: int, message_id: int, index: int, account_id: str) -> dict[str, Any]:
        """Mint one new opaque ref after a UI tile lost a bounded media token."""
        if index < 0 or index > 99:
            return {"success": False, "code": "max_media_ref_invalid", "message": "Некорректное вложение MAX."}
        if str(serialize_profile(self.connected_client()).get("id", "")) != account_id:
            return {"success": False, "code": "max_media_ref_account_changed", "message": "Аккаунт MAX изменился. Обновите чат."}

        async def locate(client: WebClient) -> Any:
            return await client.get_message(chat_id, message_id)

        try:
            message = await self.read(locate)
        except (ApiError, TimeoutError, ConnectionError, OSError):
            return {"success": False, "code": "max_media_ref_unknown", "message": "MAX не подтвердил вложение."}
        except Exception:
            LOG.exception("MAX media-ref refresh failed chat_id=%s message_id=%s", chat_id, message_id)
            return {"success": False, "code": "max_media_ref_unknown", "message": "MAX не подтвердил вложение."}
        if message is None or int(getattr(message, "chat_id", 0) or 0) != chat_id:
            return {"success": False, "code": "max_media_ref_expired", "message": "Вложение MAX больше недоступно."}
        attachments = list(getattr(message, "attaches", None) or [])
        if index >= len(attachments):
            return {"success": False, "code": "max_media_ref_expired", "message": "Вложение MAX больше недоступно."}
        token = self.issue_media_token(chat_id, message_id, index, attachments[index])
        if not token:
            return {"success": False, "code": "max_media_ref_expired", "message": "Вложение MAX больше недоступно."}
        self.persist_media_tokens()
        return {"success": True, "media_ref": token}

    async def send_attachment(self, chat_id: int, name: str, mime: str, raw: bytes, caption: str, reply_to: int | None) -> dict[str, Any]:
        return await self.send_attachments(chat_id, [(name, mime, raw)], caption, reply_to)

    async def send_attachments(self, chat_id: int, files: list[tuple[str, str, bytes]], caption: str, reply_to: int | None) -> dict[str, Any]:
        client, chat = await self.writable_chat(chat_id)
        if chat is None:
            return {"success": False, "outcome": "rejected", "code": "max_chat_unavailable", "message": "Этот чат MAX недоступен подключённому аккаунту."}
        if not files or len(files) > MAX_TRAINING_BATCH_FILES or sum(len(raw) for _, _, raw in files) > MAX_TRAINING_BATCH_BYTES:
            return {"success": False, "outcome": "rejected", "code": "max_attachment_batch_invalid", "message": "Пачка MAX превышает допустимый размер или количество файлов."}
        attachments: list[File | Photo] = []
        for name, mime, raw in files:
            suffix = Path(name).suffix.lower()
            if not name or len(name) > 160 or not raw or len(raw) > MAX_TRAINING_ATTACHMENT_BYTES:
                return {"success": False, "outcome": "rejected", "code": "max_attachment_invalid", "message": "Файл MAX имеет неверный размер или имя."}
            if len(files) > 1 and (suffix not in MAX_TRAINING_PHOTO_EXTENSIONS or not mime.startswith("image/")):
                return {"success": False, "outcome": "rejected", "code": "max_album_photo_only", "message": "MAX разрешает пачкой только фотографии; документы отправляются по одному."}
            attachments.append(Photo(raw=raw, name=name) if suffix in MAX_TRAINING_PHOTO_EXTENSIONS and mime.startswith("image/") else File(raw=raw, name=name))
        if reply_to is not None:
            original = await client.get_message(chat_id, reply_to)
            if original is None or getattr(original, "chat_id", None) is None or int(getattr(original, "chat_id")) != chat_id:
                return {"success": False, "outcome": "rejected", "code": "max_reply_target_invalid", "message": "Исходное сообщение MAX не найдено в этом чате."}
        try:
            async with self.write_lock:
                message = await asyncio.wait_for(client.send_message(chat_id, text=caption or None, reply_to=reply_to, attachments=attachments, notify=False), timeout=60)
            native_id = str(getattr(message, "id", "")).strip()
            if not native_id: return {"success": False, "outcome": "unknown", "code": "max_provider_id_missing", "message": "MAX не подтвердил ID вложения."}
            # Accepted local writes need an explicit
            # neutral hint because PyMax may not echo them through on_message.
            self.realtime_events.publish("new_message", chat_id, native_id)
            if reply_to is not None:
                self.reply_links.record(native_id, original, serialize_profile(client)["id"])
            # MAX represents a photo album as one native message containing
            # several attachments. Tell the durable browser journal that this
            # one ID is evidence for the whole album, not just file zero.
            return {"success": True, "outcome": "accepted", "send_state": "sent", "message_id": native_id, "message_ids": [native_id], "attachment_count": len(attachments), "single_message_album": len(attachments) > 1}
        except (ApiError, UploadError):
            return {"success": False, "outcome": "rejected", "code": "max_provider_rejected", "message": "MAX отклонил вложение."}
        except (TimeoutError, ConnectionError, OSError):
            return {"success": False, "outcome": "unknown", "code": "max_attachment_unknown", "message": "Результат отправки вложения MAX неизвестен."}
        except Exception:
            LOG.exception("MAX attachment send failed")
            return {"success": False, "outcome": "unknown", "code": "max_attachment_unknown", "message": "Результат отправки вложения MAX неизвестен."}

    async def message_reactions(self, chat_id: int, message_id: int) -> dict[str, Any]:
        """Read one reaction snapshot from a chat available to this account."""
        client, chat = await self.writable_chat(chat_id)
        if chat is None:
            return {"success": False, "code": "max_chat_unavailable", "message": "Этот чат MAX недоступен подключённому аккаунту."}
        try:
            records = await self.read(lambda client: client.get_reactions(chat_id, [message_id]))
            info = (records or {}).get(str(message_id)) or (records or {}).get(message_id)
            return {"success": True, "read_only": True, "reactions": serialize_reaction_info(info)}
        except (TimeoutError, ConnectionError, OSError):
            return {"success": False, "code": "max_reactions_unknown", "message": "MAX не подтвердил снимок реакций."}
        except Exception:
            LOG.exception("MAX reaction read failed")
            return {"success": False, "code": "max_reactions_failed", "message": "Не удалось прочитать реакции MAX."}

    async def set_reaction(self, chat_id: int, message_id: int, reaction: str) -> dict[str, Any]:
        """Change the connected account's reaction in an available chat."""
        client = self.connected_client()
        _, chat = await self.writable_chat(chat_id)
        if chat is None:
            return {"success": False, "outcome": "rejected", "code": "max_chat_unavailable", "message": "Этот чат MAX недоступен подключённому аккаунту."}
        if reaction and reaction not in MAX_TRAINING_REACTIONS:
            return {"success": False, "outcome": "rejected", "code": "max_reaction_unsupported", "message": "Эта реакция пока не разрешена для MAX."}
        try:
            async with self.write_lock:
                if reaction:
                    info = await asyncio.wait_for(client.add_reaction(chat_id, message_id, reaction), timeout=MAX_READ_TIMEOUT_SECONDS)
                else:
                    info = await asyncio.wait_for(client.remove_reaction(chat_id, message_id), timeout=MAX_READ_TIMEOUT_SECONDS)
            # The snapshot returned above is authoritative for this request;
            # the event only asks other tabs to obtain their own snapshot.
            self.realtime_events.publish("reaction_update", chat_id, message_id)
            return {"success": True, "outcome": "accepted", "reactions": serialize_reaction_info(info)}
        except ApiError:
            return {"success": False, "outcome": "rejected", "code": "max_reaction_rejected", "message": "MAX отклонил реакцию."}
        except (TimeoutError, ConnectionError, OSError):
            return {"success": False, "outcome": "unknown", "code": "max_reaction_unknown", "message": "Результат реакции MAX неизвестен. Проверьте сообщение."}
        except Exception:
            LOG.exception("MAX reaction failed")
            return {"success": False, "outcome": "unknown", "code": "max_reaction_unknown", "message": "Результат реакции MAX неизвестен. Проверьте сообщение."}


def json_response(payload: dict[str, Any], status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, headers={"Cache-Control": "no-store"})


def limited_int(value: str | None, default: int = MAX_READ_LIMIT) -> int:
    try:
        number = int(value or default)
    except (TypeError, ValueError):
        return default
    return max(1, min(number, MAX_READ_LIMIT))


def display_name(user: Any) -> str:
    for name in getattr(user, "names", []) or []:
        value = getattr(name, "name", None)
        if isinstance(value, str) and value.strip():
            return value.strip()
        parts = [getattr(name, "first_name", None), getattr(name, "last_name", None)]
        joined = " ".join(part.strip() for part in parts if isinstance(part, str) and part.strip())
        if joined:
            return joined
    return ""


async def message_sender_names(client: WebClient, messages: Iterable[Any], profile: dict[str, Any]) -> dict[str, str]:
    """Resolve visible message authors in one bounded, read-only MAX call."""
    own_id = str(profile.get("id", "") or "")
    names: dict[str, str] = {own_id: str(profile.get("name", "") or "")[:160]} if own_id else {}
    ids: set[int] = set()
    for message in messages or []:
        try:
            sender_id = int(getattr(message, "sender", 0) or 0)
        except (TypeError, ValueError):
            continue
        if sender_id > 0 and str(sender_id) != own_id:
            ids.add(sender_id)
    if not ids:
        return names
    try:
        users = await client.get_users(sorted(ids)[:100])
    except (ApiError, TimeoutError, ConnectionError, OSError):
        return names
    for user in users or []:
        user_id = str(getattr(user, "id", "") or "")
        name = display_name(user)
        if user_id and name:
            names[user_id] = name[:160]
    return names


async def message_sender_profiles(
    client: WebClient,
    messages: Iterable[Any],
    profile: dict[str, Any],
    avatar_token_factory: Any = None,
) -> dict[str, dict[str, Any]]:
    """Resolve group authors once, retaining their public name and avatar."""
    own_id = str(profile.get("id", "") or "")
    result: dict[str, dict[str, Any]] = {}
    if own_id:
        result[own_id] = {
            "name": str(profile.get("name", "") or "")[:160],
            "avatar_ref": str(profile.get("avatar_ref", "") or ""),
            "avatar_available": bool(profile.get("avatar_available")),
        }
    ids: set[int] = set()
    for message in messages or []:
        try:
            sender_id = int(getattr(message, "sender", 0) or 0)
        except (TypeError, ValueError):
            continue
        if sender_id > 0 and str(sender_id) != own_id:
            ids.add(sender_id)
    if not ids:
        return result
    try:
        users = await client.get_users(sorted(ids)[:100])
    except (ApiError, TimeoutError, ConnectionError, OSError):
        return result
    for user in users or []:
        contact = getattr(user, "contact", None) or user
        user_id = str(getattr(contact, "id", "") or getattr(user, "id", "") or "")
        name = display_name(contact) or display_name(user)
        avatar_url = str(getattr(contact, "base_url", "") or getattr(user, "base_url", "") or "")
        if user_id and name:
            result[user_id] = {
                "name": name[:160],
                "avatar_ref": str(avatar_token_factory(avatar_url) or "") if callable(avatar_token_factory) and avatar_url else "",
                "avatar_available": bool(avatar_url),
            }
    return result


def serialize_profile(client: WebClient, avatar_token_factory: Any = None) -> dict[str, Any]:
    profile = client.me
    contact = getattr(profile, "contact", None)
    if contact is None:
        raise RuntimeError("MAX profile is unavailable after login")
    avatar_ref = ""
    avatar_url = str(getattr(contact, "base_url", "") or "")
    if callable(avatar_token_factory):
        avatar_ref = str(avatar_token_factory(avatar_url) or "")
    return {
        "id": str(contact.id),
        "name": display_name(contact) or f"MAX {contact.id}",
        "avatar_available": bool(getattr(contact, "base_url", None)),
        "avatar_ref": avatar_ref,
        "avatar_version": hashlib.sha256(avatar_url.encode()).hexdigest()[:16] if avatar_url else "",
        "fields": [{"label": "ID MAX", "value": str(contact.id)}],
    }


def serialize_contact_profile(contact: Any, avatar_token_factory: Any = None) -> dict[str, Any]:
    """Expose the small public profile shape used by the common contact UI."""
    avatar_ref = ""
    avatar_url = str(getattr(contact, "base_url", "") or "")
    if callable(avatar_token_factory):
        avatar_ref = str(avatar_token_factory(avatar_url) or "")
    contact_id = str(getattr(contact, "id", "") or "")
    fields: list[dict[str, str]] = []
    if contact_id:
        fields.append({"label": "ID MAX", "value": contact_id})
    # These values are never looked up separately: MAX has already supplied
    # them on the direct-profile response.  In particular, a phone is emitted
    # only when the provider makes it visible for this account and contact.
    raw_phone = str(getattr(contact, "phone", "") or "").strip()
    phone_digits = re.sub(r"\D", "", raw_phone)
    if (
        7 <= len(phone_digits) <= 15
        and len(raw_phone) <= 48
        and re.fullmatch(r"[0-9+().\-\s]+", raw_phone)
    ):
        fields.append({"label": "Телефон", "value": raw_phone})
    description = str(getattr(contact, "description", "") or "").strip()
    if description:
        fields.append({"label": "О себе", "value": description[:1000]})
    country = str(getattr(contact, "country", "") or "").strip()
    if country:
        fields.append({"label": "Страна", "value": country[:120]})
    # Keep an optional link only when MAX supplied a normal HTTPS URL.  It is
    # rendered as plain text by the shared UI, so no provider navigation is
    # triggered automatically.
    profile_link = str(getattr(contact, "link", "") or "").strip()
    parsed_link = urlparse(profile_link)
    if (
        len(profile_link) <= 1024
        and parsed_link.scheme == "https"
        and parsed_link.netloc
        and not parsed_link.username
        and not parsed_link.password
    ):
        fields.append({"label": "Ссылка профиля", "value": profile_link})
    return {
        "id": contact_id,
        "name": display_name(contact) or (f"MAX {contact_id}" if contact_id else "Пользователь MAX"),
        "subtitle": "Пользователь MAX",
        "avatar_available": bool(getattr(contact, "base_url", None)),
        "avatar_ref": avatar_ref,
        "avatar_version": hashlib.sha256(avatar_url.encode()).hexdigest()[:16] if avatar_url else "",
        "fields": fields,
    }


def is_direct_dialog(chat: Any) -> bool:
    """MAX calls a one-to-one conversation DIALOG; chat ids are not user ids."""
    return str(getattr(chat, "type", "") or "").upper().endswith("DIALOG")


def is_group_chat(chat: Any) -> bool:
    """A non-direct MAX chat is a group-like shared space, never one peer."""
    if str(getattr(chat, "id", "") or "") == "0" or is_direct_dialog(chat):
        return False
    chat_type = str(getattr(chat, "type", "") or "").upper()
    return chat_type in {"CHAT", "GROUP", "CHANNEL"} or bool(getattr(chat, "participants_count", 0))


def direct_peer_id(chat: Any, own_id: str) -> int | None:
    """Return the other participant only when the chat payload proves it."""
    if not is_direct_dialog(chat) or str(getattr(chat, "id", "")) == "0":
        return None
    participants = getattr(chat, "participants", None)
    raw_ids = participants.keys() if isinstance(participants, dict) else []
    peers: list[int] = []
    for raw_id in raw_ids:
        try:
            participant_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        if str(participant_id) != str(own_id):
            peers.append(participant_id)
    return peers[0] if len(peers) == 1 else None


def direct_peer_read_mark(chat: Any, peer_id: int | None) -> int:
    """Return MAX's historical last-read timestamp for a verified peer."""
    if peer_id is None or not is_direct_dialog(chat):
        return 0
    participants = getattr(chat, "participants", None)
    if not isinstance(participants, dict):
        return 0
    raw = participants.get(peer_id, participants.get(str(peer_id), 0))
    try:
        return max(0, int(raw or 0))
    except (TypeError, ValueError):
        return 0


async def direct_dialog_contacts(client: WebClient, chats: Iterable[Any], own_id: str) -> dict[str, Any]:
    """Resolve known direct-dialog participants in one read-only MAX request."""
    chat_peers = {
        str(getattr(chat, "id", "")): peer_id
        for chat in chats
        if (peer_id := direct_peer_id(chat, own_id)) is not None
    }
    if not chat_peers:
        return {}
    try:
        users = await client.get_users(sorted(set(chat_peers.values())))
    except (ApiError, TimeoutError, ConnectionError, OSError):
        return {}
    by_id = {int(getattr(user, "id", 0) or 0): user for user in users or []}
    return {chat_id: by_id[peer_id] for chat_id, peer_id in chat_peers.items() if peer_id in by_id}


async def collect_contact_profile(client: WebClient, chat_id: int, avatar_token_factory: Any) -> dict[str, Any]:
    own = serialize_profile(client, avatar_token_factory)
    if chat_id == 0:
        # Saved Messages is the account's self-dialogue.  Treating it as an
        # anonymous contact would show fabricated data in the details panel.
        return {**own, "subtitle": "Мой аккаунт MAX"}
    chat = await client.get_chat(chat_id)
    peer_id = direct_peer_id(chat, own["id"])
    if peer_id is not None:
        # Direct dialogs have no chat-members endpoint in MAX.  Their peer is
        # represented by the participant map and must be resolved through the
        # users endpoint instead of treating the technical chat id as a name.
        try:
            peer = await client.get_user(peer_id)
        except (ApiError, TimeoutError, ConnectionError, OSError):
            peer = None
        if peer is not None:
            return serialize_contact_profile(peer, avatar_token_factory)
        return {
            "id": "",
            "name": "Личный чат MAX",
            "subtitle": "Пользователь MAX",
            "avatar_available": False,
            "avatar_ref": "",
            "avatar_version": "",
            "fields": [],
        }
    # A group must always remain a group profile.  A short/partial member
    # response is not evidence that its sole returned member is the chat
    # itself; the former fallback made a random member replace group details
    # in the header modal.
    if not is_group_chat(chat):
        return {
            "id": str(chat_id), "name": str(getattr(chat, "title", "") or f"MAX {chat_id}"),
            "subtitle": "Чат MAX", "kind": "chat", "avatar_available": False,
            "avatar_ref": "", "avatar_version": "", "fields": [], "members": [],
        }
    members, next_marker = await client.get_chat_members(chat_id, count=50)
    avatar_url = str(getattr(chat, "base_icon_url", "") or "")
    avatar_ref = str(avatar_token_factory(avatar_url) or "")
    fields: list[dict[str, str]] = []
    description = str(getattr(chat, "description", "") or "").strip()
    if description:
        fields.append({"label": "Описание", "value": description[:1000]})
    count = int(getattr(chat, "participants_count", 0) or 0)
    if count > 0:
        fields.append({"label": "Участники", "value": str(count)})
    member_rows: list[dict[str, Any]] = []
    for member in members or []:
        contact = getattr(member, "contact", None)
        if contact is None:
            continue
        member_id = str(getattr(contact, "id", "") or "")
        name = display_name(contact)
        if not member_id or not name:
            continue
        member_avatar_url = str(getattr(contact, "base_url", "") or "")
        member_rows.append({
            "id": member_id,
            "name": name[:160],
            "avatar_available": bool(member_avatar_url),
            "avatar_ref": str(avatar_token_factory(member_avatar_url) or "") if member_avatar_url else "",
        })
    return {
        "id": str(chat_id),
        "name": str(getattr(chat, "title", "") or f"MAX {chat_id}"),
        "subtitle": "Групповой чат MAX",
        "kind": "group",
        "avatar_available": bool(getattr(chat, "base_icon_url", None)),
        "avatar_ref": avatar_ref,
        "avatar_version": hashlib.sha256(avatar_url.encode()).hexdigest()[:16] if avatar_url else "",
        "fields": fields,
        "members": member_rows,
        "members_total": max(count, len(member_rows)),
        "members_truncated": bool(next_marker) or (count > len(member_rows)),
    }


def serialize_attachments(items: Iterable[Any], media_token_factory: Any = None, sticker_preview_token_factory: Any = None, chat_id: int | None = None, message_id: int | None = None, account_id: str = "") -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, item in enumerate(items or []):
        raw_type = getattr(item, "type", "unknown")
        attachment_type = str(getattr(raw_type, "value", raw_type)).lower()
        entry: dict[str, Any] = {"type": attachment_type}
        if attachment_type == "sticker" and getattr(item, "lottie_url", None):
            entry["animated"] = True
            entry["animation_format"] = "lottie"
            entry["mime"] = "application/json"

        # CONTROL is not downloadable media, but it is a real group event
        # (join, leave, title change, etc.). Preserve only its bounded public
        # label and event code so the common UI can render a service marker.
        if attachment_type == "control":
            event = str(getattr(item, "event", "") or "").strip()
            title = str(getattr(item, "title", "") or "").strip()
            if event:
                entry["event"] = event[:128]
            if title:
                entry["title"] = title[:1000]
        # MAX sends circular video messages through the ordinary VIDEO
        # attachment shape.  `video_type == 1` is the provider's documented
        # marker for VIDEO_MESSAGE, while 0 is a regular rectangular video.
        # Preserve this presentation metadata without exposing its URL.
        if attachment_type == "video":
            raw_video_type = getattr(item, "video_type", None)
            if isinstance(raw_video_type, int):
                entry["video_type"] = raw_video_type
                entry["video_note"] = raw_video_type == 1
        # A photo retains browser-native GIF animation.  MAX's typed photo
        # object does not provide MIME, but its source name/URL sometimes does;
        # carry only this safe presentation bit so the common UI can label it.
        source_hint = " ".join(str(getattr(item, key, "") or "") for key in ("name", "base_url", "url"))
        if re.search(r"\.gif(?:[?#\s]|$)", source_hint, re.IGNORECASE):
            entry["animated"] = True
        for source, target in (("name", "name"), ("size", "size"), ("width", "width"), ("height", "height"), ("duration", "duration")):
            value = getattr(item, source, None)
            if isinstance(value, (str, int)) and value != "":
                entry[target] = value
        token = ""
        if callable(media_token_factory):
            token = media_token_factory(index, item)
            if token: entry["media_ref"] = token
        if token and chat_id is not None and message_id is not None and re.fullmatch(r"[1-9][0-9]{0,19}", account_id):
            entry["media_identity"] = {"chat_id": str(chat_id), "message_id": str(message_id), "index": index, "account_id": account_id}
        if attachment_type == "sticker" and callable(sticker_preview_token_factory):
            preview_token = sticker_preview_token_factory(index, item)
            if preview_token: entry["preview_ref"] = preview_token
        result.append(entry)
    return result


def serialize_message(
    message: Any,
    account_id: str,
    media_token_factory: Any = None,
    sticker_preview_token_factory: Any = None,
    reply_hint: dict[str, str] | None = None,
    sender_names: dict[str, str] | None = None,
    sender_profiles: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    reaction_info = getattr(message, "reaction_info", None)
    counters = getattr(reaction_info, "counters", []) if reaction_info is not None else []
    reply_to: dict[str, str] | None = None
    link = getattr(message, "link", None)
    linked_message = getattr(link, "message", None)
    # PyMax exposes replies through Message.link (ReplyLink), where the
    # original Message already contains its native ID and available preview.
    # Forward links are deliberately not rendered as replies.
    link_type = str(getattr(link, "type", "") or "").lower()
    if linked_message is not None and link_type.endswith("reply"):
        linked_id = str(getattr(linked_message, "id", "") or "")
        if linked_id:
            linked_sender = str(getattr(linked_message, "sender", "") or "")
            reply_to = {
                "message_id": linked_id,
                "text": str(getattr(linked_message, "text", "") or ""),
                "author_name": "Вы" if linked_sender == account_id else str((sender_names or {}).get(linked_sender, "Сообщение"))[:160],
            }
    if reply_to is None and reply_hint is not None:
        reply_to = reply_hint
    sender_id = str(getattr(message, "sender", "") or "")
    sender_profile = (sender_profiles or {}).get(sender_id, {})
    try:
        attachment_chat_id = int(getattr(message, "chat_id", None))
    except (TypeError, ValueError):
        attachment_chat_id = None
    try:
        attachment_message_id = int(getattr(message, "id", None))
    except (TypeError, ValueError):
        attachment_message_id = None
    return {
        "id": str(message.id),
        "chat_id": str(message.chat_id) if getattr(message, "chat_id", None) is not None else "",
        "sender_id": sender_id,
        "sender_name": str((sender_names or {}).get(sender_id, ""))[:160],
        "sender_avatar_ref": str(sender_profile.get("avatar_ref", "") or ""),
        "sender_avatar_available": bool(sender_profile.get("avatar_available")),
        "outgoing": sender_id == account_id,
        "text": str(getattr(message, "text", "") or ""),
        "timestamp": int(getattr(message, "time", 0) or 0),
        "type": str(getattr(message, "type", "") or ""),
        "attachments": serialize_attachments(getattr(message, "attaches", []), media_token_factory, sticker_preview_token_factory, attachment_chat_id, attachment_message_id, account_id),
        "reply_to": reply_to,
        "reactions": [{"emoji": str(counter.reaction), "count": int(counter.count)} for counter in counters],
        "own_reaction": str(getattr(reaction_info, "your_reaction", "") or ""),
    }


def serialize_pinned_message(
    message: Any,
    account_id: str,
    sender_names: dict[str, str] | None = None,
) -> dict[str, str] | None:
    """Return only a safe, display-ready preview of MAX's current pin."""
    if message is None:
        return None
    message_id = str(getattr(message, "id", "") or "")
    if not re.fullmatch(r"[1-9][0-9]{0,19}", message_id):
        return None
    text = str(getattr(message, "text", "") or "").strip()
    if not text:
        types = {
            str(getattr(getattr(item, "type", ""), "value", getattr(item, "type", "")) or "").lower()
            for item in (getattr(message, "attaches", []) or [])
        }
        if "photo" in types:
            text = "[Фото]"
        elif "video" in types:
            text = "[Видео]"
        elif "sticker" in types:
            text = "[Стикер]"
        elif "file" in types:
            text = "[Файл]"
        else:
            return None
    sender_id = str(getattr(message, "sender", "") or "")
    author = "Вы" if sender_id and sender_id == account_id else str((sender_names or {}).get(sender_id, "")).strip()
    return {
        "id": message_id,
        "text": text[:1000],
        "author_name": author[:160],
    }


def serialize_reaction_info(info: Any) -> list[dict[str, Any]]:
    counters = getattr(info, "counters", []) if info is not None else []
    own = str(getattr(info, "your_reaction", "") or "")
    return [{"emoji": str(item.reaction), "count": int(item.count), "me": str(item.reaction) == own} for item in counters]


def serialize_chat(
    chat: Any,
    account_id: str,
    avatar_token_factory: Any = None,
    self_avatar_ref: str = "",
    self_avatar_version: str = "",
    peer: Any = None,
    sender_names: dict[str, str] | None = None,
) -> dict[str, Any]:
    last_message = getattr(chat, "last_message", None)
    avatar_ref = ""
    avatar_url = str(getattr(chat, "base_icon_url", "") or "")
    if callable(avatar_token_factory):
        avatar_ref = str(avatar_token_factory(avatar_url) or "")
    # MAX represents Saved Messages as chat 0 and may omit its chat icon.
    # It is the owner's self-dialogue, so the already-relayed own-profile
    # avatar is the truthful identity there.  Never apply this to any other
    # chat: a missing peer avatar must remain an initials fallback.
    is_saved_messages = str(getattr(chat, "id", "")) == "0"
    if not avatar_ref and is_saved_messages:
        avatar_ref = str(self_avatar_ref or "")
    avatar_version = hashlib.sha256(avatar_url.encode()).hexdigest()[:16] if avatar_url else ""
    if not avatar_version and is_saved_messages:
        avatar_version = str(self_avatar_version or "")
    title = str(getattr(chat, "title", "") or f"MAX {chat.id}")
    if peer is not None:
        peer_name = display_name(peer)
        peer_avatar_url = str(getattr(peer, "base_url", "") or "")
        if peer_name:
            title = peer_name
        if peer_avatar_url:
            avatar_url = peer_avatar_url
            avatar_ref = str(avatar_token_factory(peer_avatar_url) or "") if callable(avatar_token_factory) else ""
            avatar_version = hashlib.sha256(peer_avatar_url.encode()).hexdigest()[:16]
    elif is_direct_dialog(chat) and not is_saved_messages and title == f"MAX {chat.id}":
        # Do not present an opaque internal chat id as someone's name while
        # MAX has not returned a participant profile yet.
        title = "Личный чат MAX"
    peer_read_until_ms = direct_peer_read_mark(chat, getattr(peer, "id", None))
    return {
        "id": str(chat.id),
        "title": title,
        "type": str(getattr(chat, "type", "") or ""),
        "updated_at": int(getattr(chat, "last_event_time", 0) or 0),
        "unread_count": int(getattr(chat, "new_messages", 0) or 0),
        "avatar_available": bool(avatar_url) or (is_saved_messages and bool(self_avatar_ref)),
        "avatar_ref": avatar_ref,
        "avatar_version": avatar_version,
        "last_message": serialize_message(last_message, account_id, sender_names=sender_names) if last_message is not None else None,
        "peer_read_until_ms": peer_read_until_ms,
    }


async def status(request: web.Request) -> web.Response:
    service: MaxAuthService = request.app["service"]
    return json_response(service.runtime.snapshot())


async def profile(request: web.Request) -> web.Response:
    service: MaxAuthService = request.app["service"]
    try:
        payload = await service.read(lambda client: asyncio.sleep(0, result=serialize_profile(client, service.issue_avatar_token)))
        return json_response({"success": True, "read_only": True, "profile": payload})
    except web.HTTPException as error:
        raise error
    except TimeoutError:
        return json_response({"success": False, "code": "max_read_timeout", "message": "MAX не ответил на чтение профиля."}, 504)
    except Exception:
        LOG.exception("MAX profile read failed")
        return json_response({"success": False, "code": "max_read_failed", "message": "Не удалось прочитать профиль MAX."}, 502)


async def user_profile(request: web.Request) -> web.Response:
    """Read a visible MAX participant profile without changing chat state."""
    service: MaxAuthService = request.app["service"]
    raw_user_id = str(request.match_info.get("user_id", "") or "")
    if not re.fullmatch(r"[1-9][0-9]{0,19}", raw_user_id):
        return json_response({"success": False, "message": "Некорректный идентификатор пользователя MAX."}, 422)
    try:
        async def collect(client: WebClient) -> dict[str, Any]:
            user = await client.get_user(int(raw_user_id))
            return serialize_contact_profile(getattr(user, "contact", None) or user, service.issue_avatar_token)
        payload = await service.read(collect)
        return json_response({"success": True, "read_only": True, "profile": payload})
    except web.HTTPException as error:
        raise error
    except TimeoutError:
        return json_response({"success": False, "code": "max_read_timeout", "message": "MAX не ответил на чтение профиля пользователя."}, 504)
    except Exception:
        LOG.exception("MAX user profile read failed user_id=%s", raw_user_id)
        return json_response({"success": False, "code": "max_user_profile_failed", "message": "Не удалось получить профиль пользователя MAX."}, 502)


async def contact_profile(request: web.Request) -> web.Response:
    service: MaxAuthService = request.app["service"]
    try:
        chat_id = int(request.match_info["chat_id"])
    except (KeyError, ValueError):
        return json_response({"success": False, "message": "Некорректный идентификатор диалога MAX."}, 422)
    try:
        payload = await service.read(lambda client: collect_contact_profile(client, chat_id, service.issue_avatar_token))
        return json_response({"success": True, "read_only": True, "profile": payload})
    except web.HTTPException as error:
        raise error
    except TimeoutError:
        return json_response({"success": False, "code": "max_read_timeout", "message": "MAX не ответил на чтение сведений диалога."}, 504)
    except Exception:
        LOG.exception("MAX contact profile read failed chat_id=%s", chat_id)
        return json_response({"success": False, "code": "max_contact_profile_failed", "message": "Не удалось прочитать сведения MAX."}, 502)


def project_chat_receipt(service: MaxAuthService, chat: dict[str, Any]) -> dict[str, Any]:
    peer_mark = int(chat.pop("peer_read_until_ms", 0) or 0)
    if peer_mark > 0:
        service.read_boundaries.advance(chat["id"], peer_mark)
    if chat.get("last_message"):
        chat["last_message"] = service.read_boundaries.project(chat["last_message"], chat["id"])
    return chat


async def chats(request: web.Request) -> web.Response:
    service: MaxAuthService = request.app["service"]
    # A complete native page preserves all rows and the provider cursor.
    async def collect(client: WebClient) -> dict[str, Any]:
        profile = serialize_profile(client, service.issue_avatar_token)
        marker_raw = request.query.get("cursor")
        if marker_raw is not None and not re.fullmatch(r"[1-9][0-9]{0,18}", marker_raw):
            raise web.HTTPBadRequest(text="invalid MAX list cursor")
        marker = int(marker_raw) if marker_raw else int(time.time() * 1000)
        # PyMax fetch_chats discards the response cursor. Keep the same fixed
        # read RPC and model binding while retaining provider pagination.
        response = await client._app.invoke(Opcode.CHATS_LIST, {"marker": marker})
        raw = response.payload
        if not isinstance(raw, dict) or not isinstance(raw.get("chats"), list):
            raise ValueError("invalid MAX chat page")
        source = [client._app.api.chats._cache_chat(Chat.model_validate(row)) for row in raw["chats"]]
        if len(source) > 1000:
            raise ValueError("MAX chat page exceeds bound")
        # Some web protocol responses omit marker. Continue from their oldest
        # event timestamp without subtracting 1 (equal timestamps must survive).
        native_marker = raw.get("marker")
        if native_marker is None and source:
            native_marker = min(int(getattr(chat, "last_event_time", 0) or 0) for chat in source)
        next_cursor = str(native_marker) if source and native_marker and 0 < int(native_marker) < marker else None
        if source and native_marker and int(native_marker) >= marker:
            raise ValueError("MAX chat pagination did not advance")
        source = sorted(source, key=lambda chat: int(getattr(chat, "last_event_time", 0) or 0), reverse=True)
        contacts = await direct_dialog_contacts(client, source, profile["id"])
        sender_names = await message_sender_names(client, [getattr(chat, "last_message", None) for chat in source], profile)
        return {
            "account_id": profile["id"],
            "next_cursor": next_cursor,
            "chats": [
                project_chat_receipt(service, serialize_chat(
                    chat,
                    profile["id"],
                    service.issue_avatar_token,
                    str(profile.get("avatar_ref", "")),
                    str(profile.get("avatar_version", "")),
                    contacts.get(str(getattr(chat, "id", ""))),
                    sender_names,
                ))
                for chat in source
            ],
        }

    try:
        payload = await service.read(collect)
        return json_response({"success": True, "read_only": True, **payload})
    except web.HTTPException as error:
        raise error
    except TimeoutError:
        return json_response({"success": False, "code": "max_read_timeout", "message": "MAX не ответил на чтение диалогов."}, 504)
    except Exception:
        LOG.exception("MAX chats read failed")
        return json_response({"success": False, "code": "max_read_failed", "message": "Не удалось прочитать диалоги MAX."}, 502)


async def history(request: web.Request) -> web.Response:
    service: MaxAuthService = request.app["service"]
    try:
        chat_id = int(request.match_info["chat_id"])
    except (KeyError, ValueError):
        return json_response({"success": False, "message": "Некорректный идентификатор диалога MAX."}, 422)
    limit = limited_int(request.query.get("limit"))
    before = request.query.get("before")
    try:
        before_at = int(before) if before else None
    except ValueError:
        return json_response({"success": False, "message": "Некорректная граница истории MAX."}, 422)

    async def collect(client: WebClient) -> dict[str, Any]:
        profile = serialize_profile(client, service.issue_avatar_token)
        # GET_HISTORY does not carry the chat participant watermark on every
        # page. Read chat metadata separately so historical outgoing messages
        # can use MAX's peer-read boundary without marking anything locally.
        chat_meta = await client.get_chat(chat_id)
        pinned_raw = getattr(chat_meta, "pinned_message", None)
        peer_id = direct_peer_id(chat_meta, profile["id"])
        peer_mark = direct_peer_read_mark(chat_meta, peer_id)
        if peer_mark > 0:
            service.read_boundaries.advance(chat_id, peer_mark)
        from_time = None
        if before_at is not None:
            # The common UI paginates by native message id. MAX history itself
            # accepts a timestamp, so resolve the boundary first without
            # changing read state.
            anchor = await client.get_message(chat_id, before_at)
            if anchor is None:
                return {"account_id": profile["id"], "chat_id": str(chat_id), "messages": [], "next_cursor": None}
            from_time = max(0, int(getattr(anchor, "time", 0) or 0) - 1)
        # `interactive=False` is PyMax's non-interactive read path.  It does
        # not mark the chat read and does not send any message.
        records = await client.fetch_history(
            chat_id=chat_id,
            backward=limit,
            from_time=from_time,
            interactive=False,
        )
        ordered = sorted(records, key=lambda item: int(getattr(item, "time", 0) or 0))
        name_records = [*ordered, *([pinned_raw] if pinned_raw is not None else [])]
        sender_profiles = await message_sender_profiles(client, name_records, profile, service.issue_avatar_token)
        sender_names = {key: str(value.get("name", "")) for key, value in sender_profiles.items()}
        pinned_message = serialize_pinned_message(pinned_raw, profile["id"], sender_names)
        cursor = str(ordered[0].id) if len(ordered) >= limit and ordered else None
        messages = [
            serialize_message(
                item,
                profile["id"],
                lambda index, attachment, item=item: service.issue_media_token(chat_id, int(item.id), index, attachment),
                lambda index, attachment, item=item: service.issue_sticker_preview_token(chat_id, int(item.id), index, attachment),
                service.reply_links.lookup(getattr(item, "id", "")),
                sender_names,
                sender_profiles,
            )
            for item in ordered
        ]
        messages = [service.read_boundaries.project(message, chat_id) for message in messages]
        service.persist_media_tokens()
        return {
            "account_id": profile["id"],
            "chat_id": str(chat_id),
            "chat_kind": "contact" if is_direct_dialog(chat_meta) else "group",
            "messages": messages,
            "next_cursor": cursor,
            "pinned_message": pinned_message,
        }

    try:
        payload = await service.read_history(collect)
        return json_response({"success": True, "read_only": True, **payload})
    except web.HTTPException as error:
        raise error
    except TimeoutError:
        return json_response({"success": False, "code": "max_read_timeout", "message": "MAX не ответил на чтение истории."}, 504)
    except Exception:
        LOG.exception("MAX history read failed chat_id=%s", chat_id)
        return json_response({"success": False, "code": "max_read_failed", "message": "Не удалось прочитать историю MAX."}, 502)


def max_chat_id(value: Any) -> int | None:
    if not isinstance(value, str) or not re.fullmatch(r"-?(?:0|[1-9][0-9]{0,19})", value):
        return None
    try:
        return int(value)
    except ValueError:
        return None


async def message_send(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return json_response({"success": False, "outcome": "rejected", "code": "max_invalid_request", "message": "Ожидается JSON-запрос MAX."}, 400)
    text = body.get("text") if isinstance(body, dict) else None
    chat_id = max_chat_id(body.get("chat_id")) if isinstance(body, dict) else None
    reply_to = max_message_id(body.get("reply_to")) if isinstance(body, dict) and body.get("reply_to") not in (None, "") else None
    if chat_id is None or not isinstance(text, str) or (isinstance(body, dict) and body.get("reply_to") not in (None, "") and reply_to is None):
        return json_response({"success": False, "outcome": "rejected", "code": "max_invalid_request", "message": "Некорректный чат или цитата MAX."}, 422)
    service: MaxAuthService = request.app["service"]
    return json_response(await service.send_message(chat_id, text, reply_to))


def max_message_id(value: Any) -> int | None:
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", value):
        return None
    return int(value)


def realtime_cursor(value: Any) -> int | None:
    if value in (None, ""):
        return 0
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,20}", value):
        return None
    return int(value)


async def media(request: web.Request) -> web.StreamResponse:
    token = request.match_info.get("token", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,128}", token): raise web.HTTPNotFound()
    return await request.app["service"].media(token, request)


async def media_ref(request: web.Request) -> web.Response:
    chat_id = max_chat_id(request.query.get("chat_id"))
    message_id = max_message_id(request.query.get("message_id"))
    index_raw = request.query.get("index", "")
    account_id = request.query.get("account_id", "")
    if chat_id is None or message_id is None or not re.fullmatch(r"[0-9]{1,2}", index_raw) or not re.fullmatch(r"[1-9][0-9]{0,19}", account_id):
        return json_response({"success": False, "code": "max_media_ref_invalid", "message": "Некорректное вложение MAX."}, 422)
    payload = await request.app["service"].refresh_media_token(chat_id, message_id, int(index_raw), account_id)
    return json_response(payload, 200 if payload.get("success") else 404)


async def realtime_events(request: web.Request) -> web.Response:
    cursor = realtime_cursor(request.query.get("after"))
    if cursor is None:
        return json_response({"success": False, "message": "Некорректный курсор событий MAX."}, 422)
    service: MaxAuthService = request.app["service"]
    payload = service.realtime_events.after(cursor)
    return json_response({"success": True, "read_only": True, "account_id": service.realtime_events.account_id, **payload})


async def message_attachment(request: web.Request) -> web.Response:
    reader = await request.multipart()
    fields: dict[str, str] = {}
    files: list[tuple[str, str, bytes]] = []
    total_bytes = 0
    async for part in reader:
        if part.name == "file" or part.name == "files[]" or part.name.startswith("files["):
            file_name = str(part.filename or "")
            file_mime = str(part.headers.get("Content-Type", "application/octet-stream"))
            data = bytearray()
            file_name = str(part.filename or "")
            while chunk := await part.read_chunk():
                data.extend(chunk)
                total_bytes += len(chunk)
                if len(data) > MAX_TRAINING_ATTACHMENT_BYTES or total_bytes > MAX_TRAINING_BATCH_BYTES:
                    return json_response({"success": False, "outcome": "rejected", "code": "max_attachment_too_large", "message": "Файл MAX превышает 10 МБ."}, 413)
            files.append((file_name, file_mime, bytes(data)))
        elif part.name in {"chat_id", "caption", "reply_to"}:
            fields[part.name] = (await part.text()).strip()
    chat_id = max_chat_id(fields.get("chat_id"))
    if chat_id is None: return json_response({"success": False, "outcome": "rejected", "code": "max_invalid_chat", "message": "Некорректный чат MAX."}, 422)
    reply_to = max_message_id(fields.get("reply_to")) if fields.get("reply_to") else None
    if fields.get("reply_to") and reply_to is None: return json_response({"success": False, "outcome": "rejected", "code": "max_reply_target_invalid", "message": "Некорректная цитата MAX."}, 422)
    if len(files) < 1 or len(files) > MAX_TRAINING_BATCH_FILES:
        return json_response({"success": False, "outcome": "rejected", "code": "max_attachment_batch_invalid", "message": "MAX принимает от одного до десяти файлов за раз."}, 422)
    return json_response(await request.app["service"].send_attachments(chat_id, files, fields.get("caption", ""), reply_to))


async def message_reactions(request: web.Request) -> web.Response:
    chat_id = max_chat_id(request.query.get("chat_id"))
    message_id = max_message_id(request.query.get("message_id"))
    if chat_id is None or message_id is None:
        return json_response({"success": False, "message": "Некорректный чат или идентификатор сообщения MAX."}, 422)
    service: MaxAuthService = request.app["service"]
    return json_response(await service.message_reactions(chat_id, message_id))


async def chat_read(request: web.Request) -> web.Response:
    chat_id = max_chat_id(request.match_info.get("chat_id"))
    if chat_id is None:
        return json_response({"success": False, "message": "Некорректный чат MAX."}, 422)
    service: MaxAuthService = request.app["service"]
    return json_response(await service.mark_chat_read(chat_id))


async def message_reaction(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict):
        return json_response({"success": False, "outcome": "rejected", "code": "max_invalid_request", "message": "Некорректный запрос реакции MAX."}, 422)
    chat_id = max_chat_id(body.get("chat_id"))
    message_id = max_message_id(body.get("message_id"))
    reaction = body.get("reaction")
    if chat_id is None or message_id is None or not isinstance(reaction, str):
        return json_response({"success": False, "outcome": "rejected", "code": "max_invalid_reaction", "message": "Некорректная реакция MAX."}, 422)
    service: MaxAuthService = request.app["service"]
    return json_response(await service.set_reaction(chat_id, message_id, reaction))


async def start(request: web.Request) -> web.Response:
    service: MaxAuthService = request.app["service"]
    return json_response(await service.start_authentication(), status=202)


async def password(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return json_response({"success": False, "message": "Ожидается JSON-запрос."}, 400)
    value = body.get("password") if isinstance(body, dict) else ""
    if not isinstance(value, str):
        return json_response({"success": False, "message": "Пароль имеет неверный формат."}, 422)
    service: MaxAuthService = request.app["service"]
    try:
        return json_response(await service.submit_password(value), status=202)
    except web.HTTPException as error:
        return error

async def logout(request: web.Request) -> web.Response:
    return json_response(await request.app["service"].logout())


async def on_cleanup(app: web.Application) -> None:
    await app["service"].close()


async def on_startup(app: web.Application) -> None:
    await app["service"].resume_saved_session()


def build_app() -> web.Application:
    state_dir = Path(os.environ.get("MAX_STATE_DIR", "/opt/unified-messenger/runtime/max"))
    session_name = os.environ.get("MAX_SESSION_NAME", "web.session.sqlite")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", session_name):
        raise RuntimeError("MAX_SESSION_NAME has an invalid format")
    app = web.Application(client_max_size=MAX_TRAINING_BATCH_BYTES + 64 * 1024)
    app["service"] = MaxAuthService(state_dir, session_name)
    app.router.add_get("/health", status)
    app.router.add_get("/v1/status", status)
    app.router.add_get("/v1/profile", profile)
    app.router.add_get("/v1/chats/{chat_id}/profile", contact_profile)
    app.router.add_get("/v1/users/{user_id}/profile", user_profile)
    app.router.add_get("/v1/chats", chats)
    app.router.add_get("/v1/chats/{chat_id}/history", history)
    app.router.add_post("/v1/chats/{chat_id}/read", chat_read)
    app.router.add_get("/v1/events", realtime_events)
    app.router.add_get("/v1/media/{token}", media)
    app.router.add_get("/v1/media-ref", media_ref)
    app.router.add_get("/v1/messages/reactions", message_reactions)
    app.router.add_post("/v1/messages/send", message_send)
    app.router.add_post("/v1/messages/attachment", message_attachment)
    app.router.add_post("/v1/messages/attachments", message_attachment)
    app.router.add_post("/v1/messages/reaction", message_reaction)
    app.router.add_post("/v1/auth/start", start)
    app.router.add_post("/v1/auth/password", password)
    app.router.add_post("/v1/auth/logout", logout)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("MAX_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    web.run_app(build_app(), host="127.0.0.1", port=int(os.environ.get("MAX_PORT", "8091")), access_log=None)
