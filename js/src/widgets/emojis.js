/*! emojis.js
 * Лёгкий эмодзи-пикер. Подключать ПОСЛЕ BaseChat.js.
 * Ищет кнопку с атрибутом [data-emoji-btn] или #emoji-btn и поле ввода #message-input.
 * Если кнопки нет — создаёт минимальную рядом с полем.
 */
(function(){
  'use strict';

  const COMMON = [
    '😀','😁','😂','🤣','😊','😉','😍','😘','😎','🤗',
    '👍','👏','👌','🙏','💪','🔥','✨','🎉','💯','✅',
    '👇','👉','🙌','🤝','🫶','🤔','😅','🙈','🫡','😴',
    '📷','🎥','🎵','📎','📍','⏳','🕑'
  ];

  function ensureTrigger(input){
    let btn = document.querySelector('[data-emoji-btn]') || document.getElementById('emoji-btn');
    if (btn) return btn;
    // создаём компактную кнопку, если своей нет
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'emoji-btn';
    btn.setAttribute('aria-label','Эмодзи');
    btn.style.marginLeft = '6px';
    btn.className = 'btn btn-light btn-sm';
    btn.innerHTML = '😊';
    // вставим рядом с полем
    if (input && input.parentElement) input.parentElement.appendChild(btn);
    return btn;
  }

  function insertAtCursor(input, text){
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end   = input.selectionEnd   ?? input.value.length;
    const before = input.value.slice(0,start);
    const after  = input.value.slice(end);
    input.value = before + text + after;
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function buildPanel(){
    const panel = document.getElementById('emoji-panel') || document.createElement('div');
    panel.hidden = false;
    panel.replaceChildren();
    panel.id = 'emoji-panel';
    panel.style.position = 'absolute';
    panel.style.bottom = '46px';
    panel.style.right = '6px';
    panel.style.zIndex = '1000';
    panel.style.background = '#fff';
    panel.style.border = '1px solid #ddd';
    panel.style.borderRadius = '10px';
    panel.style.boxShadow = '0 6px 18px rgba(0,0,0,.12)';
    panel.style.padding = '8px';
    panel.style.maxWidth = '320px';
    panel.style.maxHeight = '180px';
    panel.style.overflow = 'auto';
    panel.style.display = 'none';

    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(10, 1fr)';
    grid.style.gap = '6px';

    for (const e of COMMON) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-light btn-sm';
      b.textContent = e;
      b.style.fontSize = '18px';
      b.style.lineHeight = '1';
      b.style.padding = '6px 0';
      b.style.textAlign = 'center';
      grid.appendChild(b);
    }
    panel.appendChild(grid);
    document.body.appendChild(panel);

    return { panel, grid };
  }

  function init(){
    const input = document.getElementById('message-input');
    if (!input) { document.addEventListener('DOMContentLoaded', init, { once:true }); return; }

    const trigger = ensureTrigger(input);
    const { panel, grid } = buildPanel();

    function placePanel(){
      const r = trigger.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, r.right - panel.offsetWidth)) + 'px';
      panel.style.top  = (r.top - (panel.offsetHeight + 8)) + 'px';
    }

    function show(){ panel.style.display = 'block'; trigger.setAttribute('aria-expanded', 'true'); placePanel(); }
    function hide(){ panel.style.display = 'none'; trigger.setAttribute('aria-expanded', 'false'); }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
    document.addEventListener('chat:reset', hide);
    window.addEventListener('resize', hide);

    trigger.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); panel.style.display === 'block' ? hide() : show(); }, false);
    document.addEventListener('click', (e)=>{
      if (!panel.contains(e.target) && e.target !== trigger) hide();
    });

    grid.addEventListener('click', (e)=>{
      const b = e.target.closest('button'); if (!b) return;
      insertAtCursor(input, b.textContent);
      hide();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();