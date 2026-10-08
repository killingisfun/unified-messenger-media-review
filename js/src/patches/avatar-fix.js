/*! avatar-fix.js v2
 * Унификация аватаров Telegram: если не загрузилось — ставим data:svg (единый и для левой панели, и для шапки).
 * Делает это постфактум + на будущее (MutationObserver) + глобальный обработчик error (capture).
 */
(function(){
  const DEF = (window.APP_CONFIG && window.APP_CONFIG.defaultAvatar) ||
   'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAwIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2NjYyIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTIwIDIxdi0yYTQgNCAwIDAgMC00LTRIOGE0IDQgMCAwIDAtNCA0djIiPjwvcGF0aD48Y2lyY2xlIGN4PSIxMiIgY3k9IjciIHI9IjQiPjwvY2lyY2xlPjwvc3ZnPg==';

  function isBadSrc(src){
    if (!src) return true;
    // относительный/абсолютный путь на default.svg
    if (/\buploads\/telegram\/default\.svg$/i.test(src)) return true;
    if (/\/uploads\/telegram\/default\.svg$/i.test(src)) return true;
    return false;
  }
  function apply(img){
    if (!img || img.dataset.avatarFixed==='1') return;
    const src = img.getAttribute('src') || '';
    if (isBadSrc(src)) {
      img.setAttribute('src', DEF);
    }
    img.dataset.avatarFixed='1';
  }

  // мгновенно для текущих
  function scan(root){
  if (!root || !root.querySelectorAll) root = document;
  root.querySelectorAll('#chat-avatar, .chat-avatar, img[data-role="avatar"]').forEach(apply);
}
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', () => scan()); else scan();

  // на будущие узлы
  const mo = new MutationObserver(list=>{
    for (const m of list) for (const n of m.addedNodes||[]) if (n.nodeType===1) scan(n);
  });
  mo.observe(document.documentElement, { childList:true, subtree:true });

  // глобальный обработчик ошибок загрузки
  window.addEventListener('error', (ev)=>{
    const el = ev.target;
    if (el && el.tagName==='IMG' && isBadSrc(el.getAttribute('src')||'')) {
      el.setAttribute('src', DEF);
    }
  }, true);
})();

/** Унифицированный выбор аватара для списка и шапки чата */
;(function(){
  if (!window.pickAvatarURL) {
    window.pickAvatarURL = function(chat){
      try {
        if (!chat) return (window.APP_CONFIG && window.APP_CONFIG.defaultAvatar) || '';
        const cand = chat.avatar || chat.avatar_url || chat.photo || chat.image || '';
        if (cand) return cand;
        return (window.APP_CONFIG && window.APP_CONFIG.defaultAvatar) || '';
      } catch(_) { return (window.APP_CONFIG && window.APP_CONFIG.defaultAvatar) || ''; }
    };
  }
})();
