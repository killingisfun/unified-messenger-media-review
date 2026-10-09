const fs = require('fs');

const sidecar = fs.readFileSync('max_service/app.py', 'utf8');
for (const token of [
  'MAX_MEDIA_TOKEN_TTL_SECONDS = 24 * 60 * 60',
  'class MediaTokenJournal:',
  'media-tokens.json',
  'def persist_media_tokens(self)',
  'service.persist_media_tokens()',
  'os.chmod(temp, 0o600)',
  'elif kind in {"audio", "sticker"}:',
  'source_url = str((getattr(attachment, "lottie_url", None) if kind == "sticker" else None) or getattr(attachment, "url", "") or "")',
  'if kind in {"photo", "audio", "sticker"}:',
  'MAX_MEDIA_TOKEN_TTL_SECONDS)',
]) {
  if (!sidecar.includes(token)) throw Error(`missing MAX archived-media contract: ${token}`);
}
if (sidecar.includes('time() + 900')) throw Error('MAX archive media must not use the former 15-minute token lifetime');
console.log('max-archive-media-contract-ok');
