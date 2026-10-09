"""Bounded private caches. No provider credentials or message bodies."""
import json
import os
import re
import secrets
import time
from pathlib import Path


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix('.tmp')
    with temp.open('w', encoding='utf-8') as stream:
        os.chmod(temp, 0o600)
        json.dump(value, stream, separators=(',', ':'))
    temp.replace(path)


class AvatarCache:
    TTL = 7 * 86400
    MAX_FILE = 2 * 1024 * 1024
    MAX_BYTES = 32 * 1024 * 1024
    MAX_ENTRIES = 512

    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / 'index.json'
        self.account = ''
        self.entries = {}
        try:
            data = json.loads(self.path.read_text('utf-8'))
            self.account = str(data['account'])
            self.entries = {k: {**v, 'expires': float(v.get('expires', 0)), 'used': float(v.get('used', 0))} for k, v in data['entries'].items()
                            if re.fullmatch(r'[A-Za-z0-9_-]{20,128}', k)
                            and isinstance(v, dict) and str(v.get('url', '')).startswith('https://')
                            and float(v.get('expires', 0)) > time.time()}
        except (OSError, ValueError, KeyError, TypeError):
            self.entries = {}
        self.prune()

    def bind(self, account):
        if str(account) != self.account:
            self.account = str(account)
            self.entries.clear()
            self.prune()
            self.save()

    def save(self):
        atomic_json(self.path, {'account': self.account, 'entries': self.entries})

    def prune(self):
        now = time.time()
        self.entries = {k: v for k, v in self.entries.items() if v['expires'] > now}
        ordered = sorted(self.entries, key=lambda k: self.entries[k].get('used', 0), reverse=True)
        retained, total = {}, 0
        for token in ordered:
            blob = self.directory / (token + '.img')
            size = blob.stat().st_size if blob.exists() else 0
            if len(retained) < self.MAX_ENTRIES and total + size <= self.MAX_BYTES:
                retained[token] = self.entries[token]
                total += size
        self.entries = retained
        # Only our opaque-token cache files, never a session or arbitrary path.
        if self.directory.exists():
            for blob in self.directory.glob('*.img'):
                if re.fullmatch(r'[A-Za-z0-9_-]{20,128}', blob.stem) and blob.stem not in retained:
                    blob.unlink(missing_ok=True)

    def issue(self, url):
        if not self.account or not url.startswith('https://'):
            return ''
        now = time.time()
        token = next((k for k, v in self.entries.items() if v['url'] == url and v['expires'] > now), None)
        if token is None:
            token = secrets.token_urlsafe(32)
            self.entries[token] = {'url': url, 'expires': now + self.TTL, 'used': now}
        elif now - self.entries[token].get('used', 0) < 3600:
            return token
        self.entries[token].update(used=now, expires=now + self.TTL)
        self.prune()
        self.save()
        return token

    def lookup(self, token):
        entry = self.entries.get(token)
        return entry if entry and entry['expires'] > time.time() else None

    def put(self, token, body, mime):
        entry = self.lookup(token)
        if entry is None or not 0 < len(body) <= self.MAX_FILE:
            raise ValueError('avatar size or token invalid')
        if mime not in {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}:
            raise ValueError('unsupported avatar content type')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.directory / (token + '.img')
        temp = path.with_suffix('.tmp')
        temp.write_bytes(body)
        os.chmod(temp, 0o600)
        temp.replace(path)
        entry.update(mime=mime, used=time.time())
        self.prune()
        self.save()
        return path


class ReadBoundaries:
    """Confirmed peer marks in provider milliseconds, scoped to account/chat."""
    def __init__(self, path):
        self.path = Path(path)
        self.account = ''
        self.marks = {}
        try:
            data = json.loads(self.path.read_text('utf-8'))
            self.account = str(data['account'])
            self.marks = {str(k): int(v) for k, v in data['marks'].items() if int(v) > 0}
        except (OSError, ValueError, KeyError, TypeError):
            self.marks = {}

    def bind(self, account):
        if self.account != str(account):
            self.account, self.marks = str(account), {}
            self.save()

    def save(self):
        atomic_json(self.path, {'account': self.account, 'marks': self.marks})

    def advance(self, chat, mark):
        mark = int(mark)
        if mark <= self.marks.get(str(chat), 0):
            return False
        self.marks[str(chat)] = mark
        if len(self.marks) > 10000:
            self.marks = dict(sorted(self.marks.items(), key=lambda item: item[1])[-10000:])
        self.save()
        return True

    def project(self, message, chat_id):
        result = dict(message)
        outgoing = bool(result.get('outgoing'))
        stamp = int(result.get('timestamp') or 0)
        read = outgoing and stamp > 0 and stamp <= self.marks.get(str(chat_id), 0)
        result.update(ack=3 if read else 1 if outgoing else 0,
                      send_state='read' if read else 'accepted' if outgoing else '', is_read=bool(read))
        return result
