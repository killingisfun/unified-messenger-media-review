/** Provider placeholders are not photographs and must not mask another field. */
export function originalAvatar(...values) {
  return values.map(value => String(value || '').trim()).find(value => value
    && !/^data:image\/svg\+xml/i.test(value)
    && !/(?:^|\/)(?:default|placeholder|no-avatar)\.(?:svg|png)(?:[?#]|$)/i.test(value)
    && !/^(?:javascript|vbscript):/i.test(value)) || '';
}
export function chatAvatar(chat) {
  const original = originalAvatar(chat?.avatar_url, chat?.avatar, chat?.photo, chat?.image);
  if (original) return original;
  return String(chat?.source || '').toLowerCase() === 'whatsapp' && String(chat?.chat_id ?? chat?.chatId ?? '') === '0@c.us'
    ? new URL('./assets/whatsapp-service.svg', import.meta.url).href : '';
}

/** A relay/local URL is a photograph; generated data URLs are UI fallbacks. */
export function isAvatarPhotoSource(value) {
  const source = originalAvatar(value);
  return Boolean(source && !/^data:image\//i.test(source));
}

/**
 * A list refresh can occur before the browser has decoded an image.  The
 * URL is still a known photo and is therefore stronger evidence than an
 * incoming generated-initials fallback.
 */
export function hasAvatarPhotoSource(image) {
  if (!(image instanceof HTMLImageElement)) return false;
  return isAvatarPhotoSource(image.currentSrc || image.getAttribute('src') || '');
}

/**
 * Do not let a later, less complete snapshot erase a photograph the browser
 * has already decoded.  This is intentionally stricter than a non-empty
 * `src`: the transparent opening GIF and generated initials are not photos.
 */
export function hasDecodedAvatarPhoto(image) {
  return hasAvatarPhotoSource(image)
    && image.naturalWidth > 1
    && image.naturalHeight > 1;
}

/** Whether a refreshed UI node may safely retain its already known photo. */
export function shouldRetainAvatarPhoto(currentImage, incomingImage) {
  if (!(currentImage instanceof HTMLImageElement) || !(incomingImage instanceof HTMLImageElement)) return false;
  return currentImage.src === incomingImage.src
    || (hasAvatarPhotoSource(currentImage)
      && !isAvatarPhotoSource(incomingImage.getAttribute('src')));
}

/**
 * Header identity is shared by the initial chat row, chat details and late
 * provider profile hydration. An error from an older image request must never
 * replace a newer, already visible avatar with initials.
 */
export function setHeaderAvatar(image, value, fallback = '', { replace = false } = {}) {
  if (!(image instanceof HTMLImageElement)) return false;
  const source = originalAvatar(value);
  if (!source) return false;

  // A profile refresh can contain a new, stale relay URL after a usable
  // photo was painted by the chat row. Keep that proven image as the recovery
  // target rather than replacing it with generated initials on an error.
  const previousPhoto = hasDecodedAvatarPhoto(image)
    ? originalAvatar(image.currentSrc || image.getAttribute('src'))
    : '';

  // List/details snapshots commonly receive a newly issued relay URL for the
  // same photo.  Do not restart that image or briefly show its initials on
  // every refresh.  A deliberate profile refresh can pass { replace: true }
  // when the provider has confirmed a changed avatar.
  if (previousPhoto && previousPhoto !== source && !replace) return true;
  if (previousPhoto === source) return true;

  const revision = String(Number(image.dataset.avatarRevision || '0') + 1);
  image.dataset.avatarRevision = revision;
  image.dataset.avatarSource = source;
  image.onload = null;
  image.onerror = () => {
    if (image.dataset.avatarRevision !== revision || image.dataset.avatarSource !== source) return;
    image.onerror = null;
    if (previousPhoto && previousPhoto !== source) {
      image.dataset.avatarRevision = String(Number(revision) + 1);
      image.dataset.avatarSource = previousPhoto;
      delete image.dataset.fallback;
      image.src = previousPhoto;
      return;
    }
    // The fallback is generated inside the UI as a data-SVG. It is purposely
    // not an "originalAvatar", but it still must not accept executable URLs.
    const replacement = String(typeof fallback === 'function' ? fallback() : fallback || '').trim();
    if (!replacement || /^(?:javascript|vbscript):/i.test(replacement)) return;
    image.dataset.avatarRevision = String(Number(revision) + 1);
    image.dataset.avatarSource = replacement;
    image.dataset.fallback = '1';
    image.src = replacement;
  };
  image.classList.remove('avatar-pending');
  delete image.dataset.fallback;
  image.src = source;
  return true;
}
