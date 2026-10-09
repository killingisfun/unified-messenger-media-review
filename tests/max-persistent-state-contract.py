"""Offline fixture tests; never connects to a MAX account."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'max_service'))
from persistent_state import AvatarCache, ReadBoundaries
import app


class PersistentStateTests(unittest.TestCase):
    def test_avatar_restart_version_account_and_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = AvatarCache(directory)
            cache.bind('1')
            token = cache.issue('https://cdn.example/avatar-v1')
            blob = cache.put(token, b'avatar-fixture', 'image/jpeg')
            again = AvatarCache(directory)
            again.bind('1')
            self.assertEqual(again.issue('https://cdn.example/avatar-v1'), token)
            self.assertEqual(blob.read_bytes(), b'avatar-fixture')
            self.assertNotEqual(again.issue('https://cdn.example/avatar-v2'), token)
            self.assertEqual(again.issue('http://cdn.example/avatar'), '')
            again.MAX_BYTES = 4
            again.prune()
            self.assertFalse(blob.exists())
            again.bind('2')
            self.assertIsNone(again.lookup(token))

    def test_read_boundary_restart_and_all_previous_messages(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'marks.json'
            marks = ReadBoundaries(path)
            marks.bind('1')
            self.assertTrue(marks.advance('10', 12345000))
            self.assertFalse(marks.advance('10', 12000000))
            marks = ReadBoundaries(path)
            marks.bind('1')
            for stamp in (10000000, 12000000, 12345000):
                self.assertEqual(marks.project({'outgoing': True, 'timestamp': stamp}, '10')['ack'], 3)
            self.assertEqual(marks.project({'outgoing': True, 'timestamp': 12345001}, '10')['ack'], 1)
            self.assertEqual(marks.project({'outgoing': True, 'timestamp': 0}, '10')['ack'], 1)
            self.assertEqual(marks.project({'outgoing': False, 'timestamp': 10000000}, '10')['ack'], 0)
            marks.bind('2')
            self.assertEqual(marks.project({'outgoing': True, 'timestamp': 10000000}, '10')['ack'], 1)

    def test_native_read_event_verification(self):
        async def scenario(directory):
            service = app.MaxAuthService(Path(directory), 'fixture.sqlite')
            service.realtime_events.bind_account('1')
            service.read_boundaries.bind('1')
            chat = NS(id=10, type='DIALOG', participants={1: 0, 2: 0})
            async def get_chat(_): return chat
            client = NS(me=NS(contact=NS(id=1)), get_chat=get_chat)
            for user, unread in [(1, False), (3, False), (2, True)]:
                await service.record_peer_read(NS(chat_id=10, user_id=user, set_as_unread=unread, mark=10000000), client)
            self.assertEqual(service.read_boundaries.marks, {})
            await service.record_peer_read(NS(chat_id=10, user_id=2, set_as_unread=False, mark=10000000), client)
            event = service.realtime_events.after(0)['events'][0]
            self.assertEqual(event['event'], 'read_update')
            self.assertEqual(event['read_until_ms'], 10000000)
            restored = app.RealtimeEventJournal(Path(directory) / 'realtime-events.json')
            self.assertEqual(restored.after(0)['events'][0]['read_until_ms'], 10000000)
            chat.type = 'CHAT'
            await service.record_peer_read(NS(chat_id=10, user_id=2, set_as_unread=False, mark=11000000), client)
            self.assertEqual(service.read_boundaries.marks['10'], 10000000)
        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))

    def test_historical_peer_mark_is_taken_from_chat_participants(self):
        chat = NS(id=10, type='DIALOG', participants={1: 0, 2: 12345000})
        peer = NS(id=2)
        self.assertEqual(app.direct_peer_read_mark(chat, peer.id), 12345000)
        group = NS(id=11, type='CHAT', participants={2: 12345000})
        self.assertEqual(app.direct_peer_read_mark(group, peer.id), 0)

    def test_provider_pages_not_truncated_at_50(self):
        async def scenario(directory):
            service = app.MaxAuthService(Path(directory), 'fixture.sqlite')
            service.avatar_cache.bind('1')
            calls = []
            async def invoke(opcode, payload):
                calls.append(payload['marker'])
                # 70 rows on page one, 51 on page two, duplicate at boundary.
                start, count, next_marker = (0, 70, 5000) if payload['marker'] > 5000 else (69, 52, 0)
                return NS(payload={'marker': next_marker, 'chats': [dict(id=i, type='CHAT', status='ACTIVE', owner=1, lastEventTime=9000-i) for i in range(start, start+count)]})
            client = NS(me=NS(contact=NS(id=1)), _app=NS(invoke=invoke, api=NS(chats=NS(_cache_chat=lambda chat: chat))))
            async def read(callback): return await callback(client)
            service.read = read
            first = json.loads((await app.chats(NS(app={'service': service}, query={'limit': '50'}))).text)
            self.assertEqual(len(first['chats']), 70)
            self.assertEqual(first['next_cursor'], '5000')
            second = json.loads((await app.chats(NS(app={'service': service}, query={'cursor': first['next_cursor']}))).text)
            self.assertIsNone(second['next_cursor'])
            self.assertEqual(len({c['id'] for c in first['chats'] + second['chats']}), 121)
            self.assertEqual(calls[1], 5000)
        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(scenario(directory))


if __name__ == '__main__':
    unittest.main()
