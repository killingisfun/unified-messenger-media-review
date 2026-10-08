// src/controllers/resizer.js
// Управляет ресайзом боковой панели (вынесено из main.php)

(function() {
  const app = document.getElementById('app');
  const resizer = document.getElementById('split-resizer');
  const railW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) || 72;
  const minW = 260, maxW = 620;
  const clampWidth = value => Math.max(minW, Math.min(maxW, window.innerWidth - railW - 380, value));
  function setWidth(value) {
    const width = clampWidth(value);
    document.documentElement.style.setProperty('--sidebar-w', width + 'px');
    resizer?.setAttribute('aria-valuenow', String(Math.round(width)));
    return width;
  }

  // Init from localStorage
  const saved = localStorage.getItem('sidebarW');
  if (saved && Number.isFinite(Number(saved))) setWidth(Number(saved));

  function onMove(e) {
    const rect = app.getBoundingClientRect();
    const x = e.clientX - rect.left - railW;
    setWidth(x);
  }

  function onUp() {
    document.body.classList.remove('resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    const value = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 360;
    localStorage.setItem('sidebarW', value);
  }

  function onDown(e) {
    if (e.button !== 0) return;
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  resizer?.addEventListener('mousedown', onDown);
  resizer?.setAttribute('aria-valuemin', String(minW));
  resizer?.setAttribute('aria-valuemax', String(maxW));
  resizer?.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const value = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 356;
    const width = setWidth(value + (e.key === 'ArrowRight' ? 16 : -16));
    localStorage.setItem('sidebarW', String(width));
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) setWidth(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 356);
  });
})();
