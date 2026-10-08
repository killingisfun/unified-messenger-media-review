const paths = {
  mediaPlay: '<path d="m8 5 11 7-11 7Z"/>',
  mediaPause: '<path d="M8 5v14M16 5v14"/>',
  mediaSound: '<path d="M4 9h4l5-4v14l-5-4H4ZM17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14"/>',
  mediaDownload: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/><path d="M8 10h8M8 14h5"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
  compose: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"/><path d="m16 3 5 5M11 18l-5 1 1-5L18 3a2.1 2.1 0 0 1 3 3z"/>',
  connections: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
  arrowLeft: '<path d="m12 5-7 7 7 7M5 12h15"/>',
  arrowDown: '<path d="m5 12 7 7 7-7M12 4v15"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  paperclip: '<path d="m21 11-8.2 8.2a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.2-8.2"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M8 9h.01M16 9h.01"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  reply: '<path d="m9 5-6 6 6 6M3 11h11a7 7 0 0 1 7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
  health: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16.5 8.5"/>',
  checkAll: '<path d="m2 12 4 4L16 6M10 16l2 2L22 8"/>',
  box: '<path d="m12 3 9 5v9l-9 5-9-5V8ZM3 8l9 5 9-5M12 13v9M7.5 5.5l9 5"/>',
  settings: '<path d="m9 3-.5 2-2 .9-1.8-.6-2 3.4 1.5 1.5v2.3l-1.5 1.4 2 3.5 1.9-.5 2 .9.4 2.2h4l.5-2.2 2-.9 1.9.5 2-3.5-1.5-1.4v-2.3l1.5-1.5-2-3.4-1.8.6-2-.9-.5-2Z"/><circle cx="11" cy="11.5" r="3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 5.2 2 2 0 0 1 5.1 3h3a2 2 0 0 1 2 1.7l.4 2.8a2 2 0 0 1-.6 1.7L8.6 10.5a16 16 0 0 0 5 5l1.3-1.3a2 2 0 0 1 1.7-.6l2.8.4a2 2 0 0 1 1.7 2Z"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 4 5"/>',
  pin: '<path d="m15 4 5 5-3 2v4l-4 4-3-3-4 4-2-2 4-4-3-3 4-4h4Z"/><path d="m14 10-4-4"/>',
};
export function icon(name, className = '') {
  return `<svg class="ui-icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
}

export function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
}
