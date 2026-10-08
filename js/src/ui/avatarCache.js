import { originalAvatar } from './avatar.js';

// Relay URLs can be renewed while the photo behind them has not changed.  Keep
// the last known URL per browser tab so a list/reaction redraw does not start
// the same image transfer again.  Server relay references remain valid for at
// least a day; six hours leaves room for an ordinary avatar change to appear.
const AVATAR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PREFIX = 'unified:avatar:v1:';

function safeRemoteAvatar(value) {
  const source = originalAvatar(value);
  if (!source) return '';
  try {
    const url = new URL(source, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function storageKey(scope, identity) {
  return `${PREFIX}${String(scope || 'default')}:${String(identity || '')}`;
}

export function readCachedAvatar(scope, identity) {
  const key = storageKey(scope, identity);
  try {
    const entry = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!entry || Number(entry.expiresAt || 0) <= Date.now()) {
      sessionStorage.removeItem(key);
      return null;
    }
    const avatar = safeRemoteAvatar(entry.avatar);
    return avatar ? { avatar, version: String(entry.version || '') } : null;
  } catch {
    return null;
  }
}

export function cacheAvatar(scope, identity, value, version = '') {
  const avatar = safeRemoteAvatar(value);
  if (!avatar || !identity) return '';
  try {
    sessionStorage.setItem(storageKey(scope, identity), JSON.stringify({
      avatar,
      version: String(version || ''),
      expiresAt: Date.now() + AVATAR_CACHE_TTL_MS,
    }));
  } catch {}
  return avatar;
}

export function forgetCachedAvatar(scope, identity, value = '') {
  if (!identity) return;
  const cached = readCachedAvatar(scope, identity);
  const requested = safeRemoteAvatar(value);
  if (requested && cached?.avatar && cached.avatar !== requested) return;
  try { sessionStorage.removeItem(storageKey(scope, identity)); } catch {}
}

/** A changed provider avatar version is the sole passive reason to replace a cached photo. */
export function preferCachedAvatar(scope, identity, candidate, version = '') {
  const fresh = safeRemoteAvatar(candidate);
  const cached = readCachedAvatar(scope, identity);
  const nextVersion = String(version || '');
  if (cached?.avatar) {
    const versionChanged = Boolean(nextVersion && cached.version && nextVersion !== cached.version);
    if (!versionChanged) return cached.avatar;
  }
  return fresh;
}

export function avatarRemoteUrl(value) {
  return safeRemoteAvatar(value);
}
