import '../controllers/uiShell.js?v=20261003-avatar-cache-r18';
// src/app/index.js
// Единый вход: подключает фиксы/патчи, логику списка чатов и glue для правой панели.
import '../patches/chat-patches.js?v=20261004-chat-zip-r2'; // legacy download helpers; no prototype patches
import '../widgets/emojis.js';           // IIFE
import '../controllers/mainPage.js?v=20261007-desktop-realtime-r1'; // логику главной (рендер списка)
import '../controllers/spaGlue.js?v=20261004-chat-zip-r21'; // glue: клики по списку -> правая панель чата
import '../controllers/resizer.js';
import '../controllers/whatsappAuth.js?v=20260925-wa-status-render-r2'; // QR/phone-code bridge for current WPPConnect
import '../controllers/telegramAuth.js?v=20260918-telegram-auth';
import '../controllers/maxAuth.js?v=20260920-max-auth-r3';
import '../controllers/startChats.js';
import '../ai/index.js?v=20261004-perf-r1';
