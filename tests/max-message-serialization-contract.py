"""Offline regression checks for partial MAX chat-list messages."""

from __future__ import annotations

import ast
from pathlib import Path
import re
from types import SimpleNamespace
from typing import Any, Iterable
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "max_service" / "app.py"


def load_serializers():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
    wanted = {"serialize_attachments", "serialize_message"}
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in wanted]
    assert {node.name for node in nodes} == wanted
    namespace = {"Any": Any, "Iterable": Iterable, "re": re}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(SOURCE), "exec"), namespace)
    return namespace["serialize_message"]


class MaxMessageSerializationContract(unittest.TestCase):
    def test_chat_list_last_message_without_chat_id_still_serializes(self) -> None:
        message = SimpleNamespace(id=7, chat_id=None, sender="9", text="preview", time=1,
                                  type="text", attaches=[], reaction_info=None, link=None)
        payload = load_serializers()(message, "9")
        self.assertEqual(payload["id"], "7")
        self.assertEqual(payload["chat_id"], "")
        self.assertEqual(payload["attachments"], [])


if __name__ == "__main__":
    unittest.main()
