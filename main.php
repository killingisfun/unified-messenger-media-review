<?php
// The production installation supplies these values in config.php. Keeping
// the page renderable without that private file makes a local UI-only preview
// possible while deliberately leaving every connection setting blank.
$configPath = __DIR__ . '/config.php';
if (is_file($configPath)) require_once $configPath;
foreach ([
    'TELEGRAM_API_URL' => '',
    'WPPCONNECT_API_URL' => '',
    'WPPCONNECT_SECRET_KEY' => '',
    'DEFAULT_AVATAR_SVG' => '',
] as $constant => $fallback) {
    if (!defined($constant)) define($constant, $fallback);
}
$uiPreview = isset($_GET['preview']) && $_GET['preview'] === '1';
// The local compatibility bridge uses the working server only as a backend.
// Keeping this flag in page configuration lets the UI avoid starting a second
// background synchronizer while still enabling ordinary message actions.
$uiBridgeMode = !$uiPreview && getenv('UNIFIED_LEGACY_BRIDGE_MODE') === 'active';
$uiRealtimeUrl = $uiBridgeMode ? trim((string)getenv('UNIFIED_REALTIME_URL')) : '';
$uiHistoryWorkerUrl = '';
if ($uiBridgeMode && getenv('UNIFIED_LEGACY_HISTORY_WORKER') === '1') {
    $historyWorkerPort = trim((string)getenv('UNIFIED_LEGACY_HISTORY_WORKER_PORT'));
    if ($historyWorkerPort === '') $historyWorkerPort = '18091';
    if (ctype_digit($historyWorkerPort) && (int)$historyWorkerPort >= 1 && (int)$historyWorkerPort <= 65535) {
        $uiHistoryWorkerUrl = 'http://127.0.0.1:' . (int)$historyWorkerPort . '/bridge-history';
    }
}
// Read receipts are part of the normal chat workflow. The active bridge
// enables them after validating the exact chat identity; a local diagnostic
// run can still pause them with UNIFIED_BRIDGE_AUTOREAD=0.
$uiAutoMarkRead = !$uiBridgeMode || getenv('UNIFIED_BRIDGE_AUTOREAD') !== '0';
$uiBridgeToken = '';
$uiCacheScope = '';
if ($uiBridgeMode) {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        $sessionDir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'unified-messenger-bridge-sessions';
        if (!is_dir($sessionDir)) @mkdir($sessionDir, 0700, true);
        if (is_dir($sessionDir) && is_writable($sessionDir)) session_save_path($sessionDir);
        session_set_cookie_params([
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
    }
    if (empty($_SESSION['unified_bridge_token'])) {
        $_SESSION['unified_bridge_token'] = bin2hex(random_bytes(32));
    }
    $uiBridgeToken = (string)$_SESSION['unified_bridge_token'];
    // Opaque namespace for browser snapshots. It carries no provider account
    // ID and changes with the authenticated bridge session.
    $accounts = $_SESSION['unified_bridge_provider_accounts'] ?? [];
    $uiCacheScope = substr(hash('sha256', 'chat-cache-v2:' . $uiBridgeToken . ':' . json_encode($accounts)), 0, 32);
}
$uiExposeProviderConfig = !$uiPreview && !$uiBridgeMode;
?>
<!DOCTYPE html>
<html lang="ru">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Сообщения · Единый мессенджер</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%228%22%20fill%3D%22%230e8978%22%2F%3E%3Cpath%20d%3D%22M8%209h16v12H15l-5%204v-4H8z%22%20fill%3D%22white%22%2F%3E%3C%2Fsvg%3E">

    <!-- Required UI dependencies are served locally: the messenger must stay
         usable when public CDNs are unavailable. The chat gallery is native. -->
    <link href="js/vendor/bootstrap/css/bootstrap.min.css?v=5.3.2" rel="stylesheet">
    <link rel="stylesheet" href="js/vendor/bootstrap-icons/font/bootstrap-icons.min.css?v=1.11.3">

    <link rel="stylesheet" href="js/src/ui/styles/legacy-media-shell.css?v=20261009-profile-avatar-fallback-r1">
    <link rel="stylesheet" href="js/src/ui/styles/albums.css?v=20260923-whatsapp-avatars-r10">
    <!-- Visual panel layer selectively transferred from worktree 45fc. -->
    <link rel="stylesheet" href="js/src/ui/styles/messenger.css?v=20261009-attachment-compose-r1">
    <link rel="stylesheet" href="js/src/ui/styles/message-actions.css?v=20260914-settings">
    <link rel="stylesheet" href="js/src/ui/styles/ai.css?v=20260924-audit-r14">

    <link rel="stylesheet" href="js/src/ui/styles/chat-runtime.css?v=20261010-video-contract-r1">

    <script>
        // Конфиг для WPPConnect и дефолтного аватара (как в твоём main.php)
        window.APP_CONFIG = {
            telegramUrl: <?= json_encode($uiExposeProviderConfig ? TELEGRAM_API_URL : '', JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
            wppconnectUrl: <?= json_encode($uiExposeProviderConfig ? WPPCONNECT_API_URL : '', JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
            wppconnectKey: <?= json_encode($uiExposeProviderConfig ? WPPCONNECT_SECRET_KEY : '', JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
            defaultAvatar: <?= json_encode(DEFAULT_AVATAR_SVG, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
            previewMode: <?= json_encode($uiPreview) ?>,
            bridgeMode: <?= json_encode($uiBridgeMode) ?>,
            realtimeUrl: <?= json_encode($uiRealtimeUrl, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
            historyWorkerUrl: <?= json_encode($uiHistoryWorkerUrl, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
            bridgeToken: <?= json_encode($uiBridgeToken, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
            chatCacheScope: <?= json_encode($uiCacheScope, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>,
            autoMarkRead: <?= json_encode($uiAutoMarkRead) ?>
        };
    </script>
</head>

<body>
    <div id="app" class="app">

        <nav class="nav-rail" aria-label="Основная навигация">
            <a class="app-logo" href="?<?= $uiPreview ? 'preview=1' : '' ?>" aria-label="Единый мессенджер"><span data-icon="chat"></span></a>
            <button type="button" class="rail-btn is-active" id="nav-chats" title="Диалоги" aria-label="Диалоги" aria-current="page"><span data-icon="chat"></span></button>
            <button type="button" class="rail-btn" data-open-connections title="Настройки подключений" aria-label="Настройки подключений" aria-expanded="false"><span data-icon="settings"></span></button>
            <button type="button" class="rail-btn infrastructure-health-button" id="infrastructure-health-button" title="Состояние инфраструктуры" aria-label="Состояние инфраструктуры" aria-expanded="false"><span data-icon="health"></span><span class="infrastructure-health-dot" aria-hidden="true"></span></button>
            <section class="infrastructure-health-panel" id="infrastructure-health-panel" role="status" aria-live="polite" hidden><strong>Проверка сервера</strong><p id="infrastructure-health-message"></p><small id="infrastructure-health-time"></small></section>
            <button type="button" class="rail-btn" id="open-download-library" title="Открыть загрузки" aria-label="Открыть загрузки" hidden><span data-icon="mediaDownload"></span></button>
            <div class="rail-spacer"></div>
            <button type="button" class="rail-btn" id="theme-toggle" title="Сменить тему" aria-label="Включить тёмную тему"><span data-icon="moon"></span></button>
            <span class="workspace-avatar" title="Общее пространство">Я</span>
        </nav>
        <aside class="sidebar" aria-label="Список диалогов">
            <div class="sidebar-header">
                <div class="sidebar-title-row"><div><span class="workspace-label">Единый мессенджер</span><h1>Сообщения <span id="unread-counter" class="unread-total" style="display:none"></span></h1></div>
                    <div class="sidebar-title-actions"><button type="button" class="icon-button mobile-connections" data-open-connections title="Настройки подключений" aria-label="Настройки подключений"><span data-icon="settings"></span></button><button type="button" id="new-chat-btn" class="icon-button new-chat-button" data-open-connections title="Новый диалог" aria-label="Новый диалог"><span data-icon="compose"></span></button></div>
                </div>
                <label class="chat-search"><span data-icon="search"></span><input id="chat-search" type="search" placeholder="Поиск по диалогам" autocomplete="off" aria-label="Поиск по диалогам"><kbd>Ctrl K</kbd></label>
                <div class="inbox-tabs" role="group" aria-label="Показать диалоги"><button type="button" data-inbox-view="all" class="is-active" aria-pressed="true">Все диалоги</button><button type="button" data-inbox-view="unread" aria-pressed="false">Непрочитанные</button><button type="button" data-inbox-view="ai" aria-pressed="false">AI</button></div><div id="ai-inbox-filters" class="ai-inbox-filters" hidden><label>Статус<select id="ai-status-filter"><option value="all">Все диалоги AI</option><option value="manager">Нужен менеджер</option><option value="working">В работе AI</option><option value="stale">Статус не обновлён</option><option value="replied">AI ответил</option></select></label><label>Мессенджер<select id="ai-source-filter"><option value="">Все мессенджеры</option><option>Telegram</option><option>WhatsApp</option><option>VK</option><option>Avito</option><option>MAX</option></select></label></div>
            </div>
            <div class="sidebar-toolbar"><div id="source-filters" class="source-filters" aria-label="Фильтр по провайдеру"></div></div>
            <div class="sidebar-list" id="chat-list-container" aria-label="Диалоги">
                <div id="initial-loader" class="chat-history-state"><div class="spinner-border" role="status"></div><p>Загружаем диалоги…</p></div>
            </div>
            <div id="chat-list-empty" class="list-empty" hidden><span data-icon="search"></span><strong data-empty-title>Ничего не найдено</strong><span data-empty-detail>Попробуйте другой запрос или провайдер</span><button type="button" id="reset-chat-search">Сбросить фильтры</button></div>
            <footer class="sidebar-footer"><span id="sync-indicator" class="sync-indicator"><span class="spinner-border spinner-border-sm" role="status" style="display:none"></span><span class="sync-text">Ожидание обновлений</span></span><span class="provider-count">5 провайдеров</span></footer>
        </aside>
        <div id="split-resizer" class="resizer" role="separator" aria-orientation="vertical" aria-label="Ширина списка диалогов" tabindex="0"></div>
        <section class="chat-pane" aria-label="Открытый диалог">
            <div class="conversation-welcome"><div class="welcome-symbol"><span data-icon="chat"></span></div><span class="welcome-eyebrow">Всегда на связи</span><h2>Все разговоры.<br>Одно место.</h2><p>Telegram, WhatsApp, VK, Avito и MAX —<br>в одном удобном пространстве.</p><div class="welcome-providers" id="welcome-providers"></div><span class="welcome-hint">Выберите диалог, чтобы начать общение</span></div>
            <header class="chat-header">
                <button type="button" class="icon-button" id="back-to-list" title="Назад к списку" aria-label="Назад к списку"><span data-icon="arrowLeft"></span></button>
                <button type="button" class="contact-trigger" id="contact-profile-trigger" title="Сведения о контакте" aria-label="Открыть сведения о контакте">
                    <img id="chat-avatar" src="" class="header-avatar" alt="">
                    <span class="chat-title-box"><span id="chat-title">Диалог</span><span class="chat-meta-line"><span id="chat-provider-badge" class="header-provider"></span><span id="presence-dot" class="presence-dot"></span><span id="presence-label"></span><span id="chat-presence"></span></span></span>
                </button>
                <div class="chat-header-actions"><button type="button" class="icon-button" id="conversation-search-toggle" title="Поиск в загруженных сообщениях" aria-label="Поиск в загруженных сообщениях" aria-expanded="false"><span data-icon="search"></span></button><button type="button" class="icon-button" disabled title="Звонки пока не подключены" aria-label="Звонки пока не подключены"><span data-icon="phone"></span></button><span class="header-divider"></span><button type="button" class="icon-button" id="contact-info-btn" title="Мой аккаунт" aria-label="Открыть сведения моего аккаунта"><span data-icon="info"></span></button></div>
            </header>
            <div id="conversation-search-bar" class="conversation-search-bar" hidden><span data-icon="search"></span><input id="conversation-search" type="search" placeholder="Поиск в истории" aria-label="Поиск в истории"><span id="conversation-search-count" role="status"></span><button type="button" class="search-history-button" id="conversation-search-history" hidden>Искать всю историю</button><button type="button" class="icon-button" id="conversation-search-prev" title="Предыдущее совпадение" aria-label="Предыдущее совпадение" hidden>↑</button><button type="button" class="icon-button" id="conversation-search-next" title="Следующее совпадение" aria-label="Следующее совпадение" hidden>↓</button><button type="button" class="icon-button" id="conversation-search-close" aria-label="Закрыть поиск"><span data-icon="close"></span></button></div>
            <div id="chat-context-banner" class="chat-context-banner" hidden></div>
            <div class="message-area"><div id="loader" class="chat-history-state" style="display:none"><div class="spinner-border" role="status"></div></div><div id="messages-container"></div></div>
            <button type="button" class="jump-latest" id="jump-latest" aria-label="К последним сообщениям" title="К последним сообщениям" hidden><span data-icon="arrowDown"></span></button>
            <div class="chat-input-area">
                <form id="message-form" method="POST" enctype="multipart/form-data" autocomplete="off">
                    <input type="hidden" name="action" value="send_message"><input type="hidden" name="source" id="form-source"><input type="hidden" name="chat_id" id="form-chat-id">
                    <div id="chat-feature-notice" class="chat-feature-notice" role="status" aria-live="polite" hidden></div>
                    <div id="composer-reply-preview"></div><div id="attachment-preview"></div>
                    <div class="input-group composer-row"><button type="button" id="attach-btn" class="icon-button" title="Прикрепить файл" aria-label="Прикрепить файл"><span data-icon="paperclip"></span></button><input type="file" name="attachment" id="attachment-input" hidden multiple>
                        <textarea id="message-input" name="message" rows="1" class="form-control" placeholder="Написать сообщение…" aria-label="Сообщение"></textarea>
                        <button type="button" id="emoji-btn" class="icon-button" title="Эмодзи" aria-label="Эмодзи" aria-expanded="false"><span data-icon="smile"></span></button>
                        <button id="send-btn" class="send-button" type="submit" title="Отправить сообщение" aria-label="Отправить сообщение"><span class="spinner-border spinner-border-sm" role="status" style="display:none"></span><span class="send-text" data-icon="send"></span></button>
                    </div>
                    <div id="emoji-panel" aria-label="Эмодзи" hidden></div>
                    <div class="composer-footer"><span>Enter — отправить <span class="composer-hint-divider">·</span> Shift + Enter — новая строка</span><span id="composer-provider"></span></div>
                </form>
            </div>
        </section>
        <section id="connections-panel" class="settings-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden>
            <div class="settings-dialog">
                <header class="settings-heading"><div><span class="workspace-label">Единое пространство</span><h2 id="settings-title">Настройки подключений</h2></div><button class="icon-button" type="button" id="connections-close" aria-label="Закрыть настройки"><span data-icon="close"></span></button></header>
                <div class="settings-layout"><nav id="settings-provider-tabs" role="tablist" aria-label="Сервисы"></nav><div id="settings-provider-panels"></div></div>
                <footer class="settings-footer">Параметры и ключи хранятся на сервере. Вход в аккаунт выполняется только по вашему действию.</footer>
                <div id="settings-existing-controls" hidden>            <div class="service-actions">
                <div class="service-group" data-provider="telegram"><button id="tg-login-btn" type="button" class="service-status service-status--telegram"><span class="provider-monogram">TG</span><span><span class="service-label">Telegram</span><span class="service-state">Проверка подключения</span></span></button><button id="tg-logout-btn" type="button" class="service-logout icon-button" title="Выйти из Telegram" aria-label="Выйти из Telegram" style="display:none"><span data-icon="arrowLeft"></span></button></div>
                <div class="service-group" data-provider="whatsapp"><button id="login-btn" type="button" class="service-status service-status--whatsapp"><span class="provider-monogram">WA</span><span><span class="service-label">WhatsApp</span><span class="service-state">Проверка подключения</span></span></button><button id="logout-btn" type="button" class="service-logout icon-button" title="Выйти из WhatsApp" aria-label="Выйти из WhatsApp" style="display:none"><span data-icon="arrowLeft"></span></button></div>
                <div class="service-group" data-provider="vk"><div class="service-status"><span class="provider-monogram">VK</span><span><span class="service-label">VK</span><span class="service-state">Подключение через сервер</span></span></div></div>
                <div class="service-group" data-provider="avito"><div class="service-status"><span class="provider-monogram">A</span><span><span class="service-label">Avito</span><span class="service-state">Подключение через сервер</span></span></div></div>
                <div class="service-group" data-provider="max"><div class="service-status"><span class="provider-monogram">M</span><span><span class="service-label">MAX</span><span class="service-state">Проверка подключения</span></span></div><button id="max-logout-btn" type="button" class="service-logout icon-button" title="Выйти из MAX" aria-label="Выйти из MAX" style="display:none"><span data-icon="arrowLeft"></span></button></div>
            </div></div>
            </div>
        </section>

    </div>

    <div class="modal fade" id="contactProfileModal" tabindex="-1" aria-labelledby="contactProfileModalTitle" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered"><div class="modal-content">
            <div class="modal-header"><h5 class="modal-title" id="contactProfileModalTitle">Сведения о контакте</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть"></button></div>
            <div class="modal-body">
                <div id="contact-profile-summary" class="d-flex align-items-center gap-3 mb-3"><span id="contact-profile-avatar-shell" class="contact-profile-avatar-shell"><span id="contact-profile-avatar-fallback" class="contact-profile-avatar-fallback" aria-hidden="true">?</span><img id="contact-profile-avatar" class="rounded-circle" alt=""></span><div><div class="fw-semibold" id="contact-profile-name">Загрузка…</div><div class="text-muted small" id="contact-profile-subtitle"></div></div></div>
                <div class="profile-skeleton" role="status" aria-label="Загрузка сведений аккаунта"><div class="profile-skeleton-avatar"></div><div class="profile-skeleton-lines"><span></span><span></span><span></span></div></div>
                <div id="contact-profile-loading" class="text-center py-3"><span class="spinner-border spinner-border-sm"></span></div>
                <div id="contact-profile-fields"></div>
                <section id="contact-profile-members" class="contact-profile-members" hidden></section>
                <div id="contact-profile-notice" class="alert alert-secondary small mt-3 d-none"></div>
                <div class="d-flex justify-content-end mt-3"><button type="button" id="contact-profile-refresh" class="btn btn-sm btn-outline-secondary" hidden>Обновить из WhatsApp</button></div>
            </div>
        </div></div>
    </div>

    <div class="modal fade" id="telegramAuthModal" data-bs-backdrop="static" data-bs-keyboard="false" tabindex="-1" aria-labelledby="telegramAuthModalTitle" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered"><div class="modal-content">
            <div class="modal-header"><h5 class="modal-title" id="telegramAuthModalTitle"><i class="bi bi-telegram" style="color:#229ED9"></i> Подключение Telegram</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть"></button></div>
            <div class="modal-body">
                <div class="telegram-auth-steps" aria-hidden="true"><span data-tg-step="phone" class="is-active">1</span><i></i><span data-tg-step="code">2</span><i></i><span data-tg-step="password">3</span></div>
                <section id="tg-auth-phone-step"><p class="mb-3">Введите номер. Telegram пришлёт код в приложение или по SMS.</p><label for="tg-auth-phone" class="form-label">Номер в международном формате</label><div class="input-group"><input id="tg-auth-phone" class="form-control" type="tel" inputmode="tel" autocomplete="tel" placeholder="+79991234567"><button id="tg-auth-send" type="button" class="btn btn-primary">Получить код</button></div></section>
                <section id="tg-auth-code-step" hidden><p class="mb-3">Введите код, который прислал Telegram.</p><label for="tg-auth-code" class="form-label">Код Telegram</label><input id="tg-auth-code" class="form-control" inputmode="numeric" autocomplete="one-time-code" placeholder="12345" disabled></section>
                <section id="tg-auth-password-step" hidden><p class="mb-3">Для аккаунта включена двухэтапная проверка.</p><label for="tg-auth-password" class="form-label">Пароль 2FA</label><input id="tg-auth-password" class="form-control" type="password" autocomplete="current-password" disabled></section>
                <button type="button" id="tg-auth-restart" class="btn btn-sm btn-link px-0 mt-2 d-none">Изменить номер или запросить код заново</button>
                <div id="tg-auth-result" class="small" aria-live="polite"></div>
            </div>
        </div></div>
    </div>

    <div class="modal fade" id="maxAuthModal" data-bs-backdrop="static" data-bs-keyboard="false" tabindex="-1" aria-labelledby="maxAuthModalTitle" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered"><div class="modal-content">
            <div class="modal-header"><h5 class="modal-title" id="maxAuthModalTitle"><i class="bi bi-qr-code"></i> Подключение MAX</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть"></button></div>
            <div class="modal-body text-center">
                <p class="mb-3">MAX подключается как отдельная web-сессия. Отсканируйте QR-код только в своём приложении MAX.</p>
                <div id="max-auth-qr" style="min-height:250px" class="d-flex align-items-center justify-content-center"></div>
                <div id="max-auth-password-panel" class="mt-3 text-start" hidden><label for="max-auth-password" class="form-label">Пароль двухэтапной проверки MAX</label><div class="input-group"><input id="max-auth-password" type="password" class="form-control" autocomplete="current-password"><button id="max-auth-password-submit" type="button" class="btn btn-dark">Подтвердить</button></div></div>
                <div id="max-auth-state" class="small mt-3 text-muted" aria-live="polite"></div>
                <button id="max-auth-restart" type="button" class="btn btn-outline-dark btn-sm mt-3" data-max-auth="qr">Получить QR-код</button>
            </div>
        </div></div>
    </div>

    <!-- ======== МОДАЛКИ (скопировано из твоего main.php, укорочено до нужного) ======== -->
    <div class="modal fade" id="whatsappQrModal" data-bs-backdrop="static" data-bs-keyboard="false" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title"><i class="bi bi-whatsapp" style="color:#25D366"></i> Авторизация WhatsApp</h5>
                </div>
                <div class="modal-body text-center">
                    <p class="mb-3">Выберите способ подключения WhatsApp.</p>
                    <div class="btn-group mb-3" role="group" aria-label="Способ авторизации WhatsApp">
                        <button type="button" id="wa-auth-qr-tab" class="btn btn-outline-success">QR-код</button>
                        <button type="button" id="wa-auth-phone-tab" class="btn btn-outline-success">По номеру и коду</button>
                    </div>

                    <section id="wa-auth-qr-panel" class="d-none">
                        <div id="qr-code-container" style="min-height:260px" class="d-flex align-items-center justify-content-center"></div>
                        <div class="alert alert-info small mt-3 mb-0">
                            Откройте WhatsApp → Настройки → Связанные устройства → Привязка устройства.
                        </div>
                    </section>

                    <section id="wa-auth-phone-panel" class="d-none text-start">
                        <label for="wa-link-phone" class="form-label">Номер WhatsApp в международном формате</label>
                        <div class="input-group">
                            <input id="wa-link-phone" type="tel" class="form-control" inputmode="tel" placeholder="+447453377211" autocomplete="tel">
                            <button type="button" id="wa-link-code-btn" class="btn btn-outline-success">Получить код</button>
                        </div>
                        <div id="wa-link-code-result" class="small mt-3" aria-live="polite"></div>
                    </section>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="vkCaptchaModal" data-bs-backdrop="static" data-bs-keyboard="false" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title"><i class="bi bi-shield-lock" style="color:#0d6efd"></i> Требуется проверка (VK)</h5>
                </div>
                <div class="modal-body text-center">
                    <div id="vk-captcha-container" class="mb-3"></div>
                    <input type="text" id="vk-captcha-input" class="form-control" placeholder="Введите символы с картинки">
                    <div id="vk-captcha-error" class="text-danger small mt-2" style="display:none;"></div>
                    <input type="hidden" id="vk-captcha-sid">
                </div>
                <div class="modal-footer">
                    <button type="button" id="vk-captcha-submit" class="btn btn-primary">Отправить</button>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="waStartChatModal" data-bs-backdrop="static" data-bs-keyboard="false" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
            <form class="modal-content" id="wa-start-chat-form">
                <div class="modal-header">
                    <h5 class="modal-title"><i class="bi bi-whatsapp"></i> Начать чат (WhatsApp)</h5>
                </div>
                <div class="modal-body">
                    <div class="mb-3">
                        <label class="form-label">Телефон (WhatsApp)</label>
                        <input type="text" class="form-control" name="phone" placeholder="+34600111222" required>
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Сообщение</label>
                        <textarea class="form-control" name="message" rows="3" placeholder="Привет! Пишу по вашему запросу…" required></textarea>
                    </div>
                    <div id="wa-start-chat-error" class="alert alert-danger d-none"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Отмена</button>
                    <button type="submit" class="btn btn-primary">Отправить</button>
                </div>
            </form>
        </div>
    </div>

    <div class="modal fade" id="tgStartChatModal" data-bs-backdrop="static" data-bs-keyboard="false" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
            <form class="modal-content" id="tg-start-chat-form">
                <div class="modal-header">
                    <h5 class="modal-title"><i class="bi bi-telegram"></i> Начать чат (Telegram)</h5>
                </div>
                <div class="modal-body">
                    <div class="mb-3">
                        <label class="form-label">Телефон или @username</label>
                        <input type="text" class="form-control" name="target" placeholder="@nickname или +34600111222" required>
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Сообщение</label>
                        <textarea class="form-control" name="message" rows="3" placeholder="Привет! Пишу по вашему запросу…" required></textarea>
                    </div>
                    <div id="tg-start-chat-error" class="alert alert-danger d-none"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Отмена</button>
                    <button type="submit" class="btn btn-primary">Отправить</button>
                </div>
            </form>
        </div>
    </div>

    <!-- ======== Скрипты ======== -->
    <script src="js/vendor/bootstrap/js/bootstrap.bundle.min.js?v=5.3.2"></script>
<script type="module" src="js/src/app/index.js?v=20261009-attachment-compose-r2"></script>

   
</body>

</html>
