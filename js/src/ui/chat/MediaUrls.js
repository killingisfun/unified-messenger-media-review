import { motionKind } from '../MotionMedia.js?v=20261007-max-sticker-fallback-r1';

/** Attachment URL selection, relay normalization and media metadata probes. */
export class MediaUrls {
  constructor(chat) { this.chat = chat; }

  _pickBestMediaUrl(att) {
    if (!att) return {
      openUrl: null,
      displayUrl: null
    };
    const useOriginal = Boolean(motionKind(att));
    const isImage = att.type === 'photo' || (att.mime || '').startsWith('image/');
    const isRawWhatsappCdn = (u) => typeof u === 'string' && /(?:^|\/\/)mmg\.whatsapp\.net\//i.test(u);
    const safePublicUrl = isRawWhatsappCdn(att.public_url) ? null : att.public_url;
    const safePreview = isRawWhatsappCdn(att.preview) ? null : att.preview;
    const safeThumbnail = isRawWhatsappCdn(att.thumbnail) ? null : att.thumbnail;
    const candidateOpen = safePublicUrl || att.url || safePreview || safeThumbnail || null;
    let displayUrl = null;
    if (isImage) {
      // A Telegram album can carry both a tiny preview and the original.
      // Render the preview in the grid; keep the full URL for the lightbox
      // and download link. Pulling originals for every tile overwhelms the
      // one-process local bridge and turns a normal album into broken photos.
      displayUrl = useOriginal ? candidateOpen : safePreview || safeThumbnail || safePublicUrl || att.url || null;
    } else {
      displayUrl = safePublicUrl || att.url || null;
    }
    const clean = (u) => {
      const safeUrl = this.chat._safeRemoteUrl(u);
      if (!safeUrl) return null;
      try {
        const x = new URL(safeUrl, window.location.href);
        x.searchParams.delete('dl');
        x.searchParams.delete('stream');
        return x.toString();
      } catch {
        return null;
      }
    };
    return {
      openUrl: clean(candidateOpen),
      displayUrl: clean(displayUrl)
    };
  }

  _fixMediaUrl(raw) {
    const safeUrl = this.chat._safeRemoteUrl(raw);
    if (!safeUrl) return '';
    if (safeUrl === this.chat._tinyTransparent || safeUrl === this.chat._videoPoster) return safeUrl;
    try {
      const u = new URL(safeUrl, window.location.href);
      u.pathname = u.pathname.replace(/\/{2,}/g, '/');
      u.pathname = u.pathname.replace(/\.mp4(\d{2,}[-\w]*)\.mp4$/i, '$1.mp4');
      u.pathname = u.pathname.replace(/\.(mp4|mov|webm)(\d{2,}[-\w]*)\.(mp4|mov|webm)$/i, '$2.$1');
      return u.toString();
    } catch {
      return '';
    }
  }

  _isDocumentAttachment(attachment) {
    if (!attachment) return false;
    const type = String(attachment.type || '').toLowerCase();
    const kind = String(attachment.kind || attachment.media_kind || attachment.media_group_kind || '').toLowerCase();
    return String(attachment.source_type || '').toLowerCase() === 'document'
      || ['file', 'document'].includes(type)
      || ['file', 'document'].includes(kind);
  }

  async resolveMediaSrc(a) {
    if (this.chat._isPreviewMode()) return null;
    const headOk = async (u) => {
      try {
        return await this.chat.api._head(u) === 200;
      } catch {
        return false;
      }
    };
    if (a.public_url && await headOk(a.public_url)) {
      return a.public_url;
    }
    if (a.ensure_url) {
      for (let i = 0; i < 5; i++) {
        try {
          const r = await this.chat.api._asyncFetchJson(a.ensure_url, {
            headers: {
              'Accept': 'application/json'
            }
          }, 8000);
          if (r && r.ready && r.url) {
            if (await headOk(r.url)) return r.url;
          } else if (r && r.permanent) {
            return null;
          }
        } catch {}
        await new Promise(res => setTimeout(res, 1000));
      }
      return null;
    }
    if (a.url && await headOk(a.url)) return a.url;
    if (a.url) {
      try {
        const response = await this.chat.api._asyncFetchRaw(a.url, {
          method: 'GET'
        }, 7000);
        // This is only a provider warm-up/probe. Release its body and the
        // full-body deadline; a later HEAD decides whether the URL is ready.
        await response?.body?.cancel?.();
        response?.unifiedFinish?.();
      } catch {}
      await new Promise(res => setTimeout(res, 1000));
      if (await headOk(a.url)) return a.url;
    }
    return null;
  }

  _guessAltMediaUrls(raw) {
    const list = [];
    const n1 = this.chat._fixMediaUrl(raw);
    if (n1 !== raw) list.push(n1);
    if (String(raw).includes('/bot//')) list.push(String(raw).replace('/bot//', '/bot/'));
    list.push(String(raw).replace(/\.([a-z0-9]{2,5})(\d{2,}[-\w]*)\.\1$/i, '$2.$1'));
    return Array.from(new Set(list.filter(Boolean)));
  }

  _mediaUrls(rawUrl, filename) {
    try {
      const src = this.chat._getSource();
      const fixed = this.chat._fixMediaUrl(rawUrl);
      const withName = this.chat._withNameParam(fixed, filename);
      if (src === 'whatsapp') {
        const pretty = this.chat._toPrettyWaMedia(withName);
        return {
          openUrl: pretty,
          dlUrl: this.chat._withDlParam(pretty)
        };
      }
      if (src === 'telegram') {
        const openUrl = withName;
        const dlUrl = this.chat._withDlParam(withName);
        return {
          openUrl,
          dlUrl
        };
      }
      return {
        openUrl: withName,
        dlUrl: this.chat._withDlParam(withName)
      };
    } catch {
      return {
        openUrl: rawUrl,
        dlUrl: this.chat._withDlParam(rawUrl)
      };
    }
  }

  _toPrettyWaMedia(u) {
    try {
      const url = new URL(u, window.location.href);
      const m = url.pathname.match(/\/wa_media\/([^/]+)$/);
      const name = url.searchParams.get('name');
      if (m && name) {
        url.pathname = `/wa_media/${encodeURIComponent(m[1])}/${encodeURIComponent(name)}`;
        url.searchParams.delete('name');
        return url.toString();
      }
    } catch {}
    return u;
  }

  async _waHead(url, timeoutMs = 6000) {
    if (this.chat._isPreviewMode()) return { ok: false, status: 0, url, headers: {} };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const out = {
      ok: false,
      status: 0,
      url,
      headers: {}
    };
    try {
      const r = await fetch(url, {
        method: 'HEAD',
        // `/bridge-media` may make one local 307 hop to the dedicated worker.
        // Keep the bridge session on that same-site cross-port request.
        credentials: 'include',
        signal: ctl.signal
      });
      out.ok = r.ok;
      out.status = r.status;
      const keys = ['content-type', 'content-disposition', 'x-accel-redirect', 'x-cache-hit', 'x-upstream-code', 'cache-control'];
      keys.forEach(k => {
        const v = r.headers.get(k);
        if (v) out.headers[k] = v;
      });
    } catch (e) {
      out.error = (e && e.message) || String(e);
    } finally {
      clearTimeout(t);
    }
    return out;
  }
}
