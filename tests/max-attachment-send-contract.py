"""Offline behaviour checks for the MAX attachment-send boundary."""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "max_service" / "app.py"


class ApiError(Exception):
    pass


class UploadError(Exception):
    pass


class File:
    def __init__(self, *, raw: bytes, name: str) -> None:
        self.raw = raw
        self.name = name


class Photo(File):
    pass


def load_send_attachments():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
    service = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "MaxAuthService")
    method = next(node for node in service.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "send_attachments")
    namespace = {
        "asyncio": asyncio, "ApiError": ApiError, "UploadError": UploadError,
        "File": File, "Photo": Photo, "Path": Path,
        "MAX_TRAINING_BATCH_FILES": 10, "MAX_TRAINING_BATCH_BYTES": 20 * 1024 * 1024,
        "MAX_TRAINING_ATTACHMENT_BYTES": 10 * 1024 * 1024,
        "MAX_TRAINING_PHOTO_EXTENSIONS": frozenset({".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}),
        "MAX_READ_TIMEOUT_SECONDS": 12, "serialize_profile": lambda _client: {"id": "7"},
        "TimeoutError": TimeoutError, "ConnectionError": ConnectionError, "OSError": OSError,
        "LOG": SimpleNamespace(exception=lambda *_args, **_kwargs: None),
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), str(SOURCE), "exec"), namespace)
    return namespace["send_attachments"]


class FakeClient:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.reply_queries: list[tuple[int, int]] = []

    async def get_message(self, chat_id: int, message_id: int):
        self.reply_queries.append((chat_id, message_id))
        return SimpleNamespace(chat_id=chat_id)

    async def send_message(self, chat_id: int, **kwargs):
        kwargs["chat_id"] = chat_id
        self.sent.append(kwargs)
        return SimpleNamespace(id=901)


class FakeService:
    def __init__(self, client: FakeClient) -> None:
        self.client = client
        self.write_lock = asyncio.Lock()
        self.realtime_events = SimpleNamespace(publish=lambda *_args: None)
        self.reply_links = SimpleNamespace(record=lambda *_args: None)

    def connected_client(self):
        raise AssertionError("send_attachments must use the validated writable-chat client")

    async def writable_chat(self, _chat_id: int):
        return self.client, object()


class MaxAttachmentSendContract(unittest.TestCase):
    def test_send_uses_the_validated_client_without_a_reply(self) -> None:
        async def check() -> None:
            client = FakeClient()
            result = await load_send_attachments()(FakeService(client), 42, [("note.txt", "text/plain", b"fixture")], "", None)
            self.assertEqual(result["outcome"], "accepted")
            self.assertEqual(result["message_id"], "901")
            self.assertEqual(len(client.sent), 1)
        asyncio.run(check())

    def test_send_checks_a_reply_with_the_same_validated_client(self) -> None:
        async def check() -> None:
            client = FakeClient()
            result = await load_send_attachments()(FakeService(client), 42, [("note.txt", "text/plain", b"fixture")], "caption", 77)
            self.assertEqual(result["outcome"], "accepted")
            self.assertEqual(client.reply_queries, [(42, 77)])
            self.assertEqual(client.sent[0]["reply_to"], 77)
        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
