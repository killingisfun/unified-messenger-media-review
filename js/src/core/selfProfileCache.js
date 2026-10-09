/** Account-scoped browser cache for a provider's own profile.
 *
 * A source name identifies a connection type, not a person. Callers may
 * reuse an entry only after they already know the connected account id.
 */
function cleanSource(source) {
  return String(source || '').trim().toLowerCase();
}

export function selfProfileAccountKey(source, profile = {}) {
  const provider = cleanSource(source);
  const direct = profile?.account_id ?? profile?.accountId ?? profile?.user_id ?? profile?.userId
    ?? profile?.id ?? profile?.phone ?? profile?.username ?? '';
  const field = Array.isArray(profile?.fields)
    ? profile.fields.find((item) => /^(id|user id|phone|телефон|аккаунт)$/i.test(String(item?.label || '').trim()))
    : null;
  const value = String(direct || field?.value || '').trim();
  return provider && value ? `${provider}:${value}` : '';
}

function cacheKey(accountKey) {
  return `unified-provider-self-profile-v4:${String(accountKey || '').toLowerCase()}`;
}

export function readScopedSelfProfile(source, accountKey, maxAgeMs = 10 * 60 * 1000) {
  const expected = String(accountKey || '').trim().toLowerCase();
  const provider = cleanSource(source);
  if (!provider || !expected || expected === `${provider}:unbound` || !expected.startsWith(`${provider}:`)) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(cacheKey(expected)) || 'null');
    if (!saved?.profile || Number(saved.fetchedAt || 0) <= Date.now() - maxAgeMs) return null;
    return selfProfileAccountKey(provider, saved.profile).toLowerCase() === expected ? saved.profile : null;
  } catch {
    return null;
  }
}

export function writeScopedSelfProfile(source, profile) {
  const accountKey = selfProfileAccountKey(source, profile);
  if (!accountKey) return '';
  try { sessionStorage.setItem(cacheKey(accountKey), JSON.stringify({ fetchedAt: Date.now(), profile })); } catch {}
  try { sessionStorage.removeItem(`unified-provider-self-profile-v3:${cleanSource(source)}`); } catch {}
  return accountKey;
}
