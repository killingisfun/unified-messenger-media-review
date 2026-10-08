# Telegram media — пакет для технического ревью

Этот документ — точка входа для ревью текущей загрузки Telegram photo/video в
Windows desktop-клиенте. Это временный публичный snapshot с ограниченным
набором исходников. Он не содержит Telegram session, device secret, ключи
SSH, SQLite с рабочими данными, cookies или полные production logs.

## Вопрос для ревью

Как заменить временную сериализацию Telegram media requests в desktop-клиенте
на серверный block cache с единственным владельцем Madeline session, сохранив
корректный HTTP Range и поведение, близкое к Telegram Web:

- быстрый отдельный poster;
- старт и seek без скачивания файла целиком;
- ограниченная параллельность клиентских запросов;
- cache, пригодный для повторных Range без обращения к Telegram;
- отсутствие 503 при обычном ожидании нужного блока.

## Текущая схема

```text
WebView2 → C# virtual host / authenticated HTTPS → desktop_api.php
        → telegram_service/rest.php → MadelineProto → Telegram
```

`desktop_api.php` и Telegram engine развёрнуты на сервере. Локальная копия
`telegram_service/rest.php` — рабочий исходник для узких release; перед
внесением серверных изменений нужно сверить её с `/opt/unified-messenger`.

## Важные активные файлы

| Роль | Файл |
| --- | --- |
| Direct desktop facade, auth/allowlist | [`desktop_api.php`](../desktop_api.php) |
| Telegram media route, lock, poster, Range stream | [`telegram_service/rest.php`](../telegram_service/rest.php) |
| Range parser/cache file response | [`telegram_service/media_range.php`](../telegram_service/media_range.php) |
| C# WebView2 media relay | [`DesktopUiHost.cs`](../desktop/UnifiedMessenger.Desktop/Services/DesktopUiHost.cs) |
| C# authenticated HTTPS client | [`DirectConnection.cs`](../desktop/UnifiedMessenger.Desktop/Services/DirectConnection.cs) |
| Telegram history/attachment URL adapter | [`TelegramClient.php`](../src/Services/TelegramClient.php) |
| UI lazy-load, spinner/fallback | [`MediaLoader.js`](../js/src/ui/chat/MediaLoader.js) |
| UI video/poster markup | [`MessageRenderer.js`](../js/src/ui/chat/MessageRenderer.js) |
| Existing static contract | [`desktop-telegram-download-contract.cjs`](../tests/desktop-telegram-download-contract.cjs) |
| Server range and media relay contract checks | [`server-media-range-contract.php`](../tests/server-media-range-contract.php), [`telegram-media-relay-contract.php`](../tests/telegram-media-relay-contract.php) |

## Добавленный UI-контекст

Для отдельного поиска UI-ошибок snapshot также содержит актуальные
[`main.php`](../main.php) и весь [`js/src/`](../js/src/): state/store,
provider adapters, shared chat components, lazy media loader, renderer,
styles и controllers. Это исходники единого интерфейса, которые desktop
поставляет внутри WebView2.

Проверять стоит прежде всего единый контракт нормализованных сообщений и
вложений между провайдерами, состояние loading/error/retry, отмену запросов
при смене чата, повторные subscriptions/realtime handlers, accessibility и
layout при узком окне. В snapshot намеренно отсутствуют runtime-config,
bridge router, `.env`, production data, browser session и любые секреты;
поэтому UI не предназначен для самостоятельного запуска против production.

## Изменения после первого ревью

Во втором snapshot исправлены конкретные дефекты, найденные при первом
ревью. Просьба проверить и эти изменения, и остающиеся архитектурные риски.

- Установленный MadelineProto 8.7 использует **исключающую** верхнюю границу
  `$end`; HTTP Range использует включающую. Для HTTP `bytes=A-B` relay теперь
  вызывает `downloadToCallable(..., A, B + 1)` и сверяет число реально
  переданных bytes с `Content-Length`.
- Кэш публикуется только после точной проверки размера временного файла.
  Рядом хранится атомарный sidecar `*.meta.json` с MIME и размером; неполный
  файл не может пройти обычный fast-path `downloadMedia`.
- Устаревший directory-lock с 90-секундным TTL заменён на kernel-owned
  `flock`. Активную загрузку больше нельзя случайно «разлочить» по времени.
- C#-очередь пока остаётся временной мерой, но имеет предел ожидания 30 секунд,
  безопасно освобождается при ошибке фабрики WebView, настоящем EOF,
  исключении чтения и после известного `Content-Length`. Нулевой read с
  нулевым буфером не считается EOF.
- После начала binary body PHP больше не дописывает JSON ошибки в
  image/video-response, включая fatal shutdown handler.
- Временные `dl_*` регистрируются в request-local cleanup на shutdown.
  Общий cache contract вынесен в
  [`media_cache.php`](../telegram_service/media_cache.php): writers публикуют
  payload и sidecar атомарно, а readers `downloadMedia`, `ensure`, `pub` и
  prefetch используют одну проверку готовности.
- `HEAD` для Telegram cache игнорирует `Range` и описывает полное
  представление без body.

## Подтверждённые факты

- Для проверенного MP4 сервер отдавал `206`, `Content-Range`,
  `Accept-Ranges`, `Content-Type: video/mp4`; первые bytes приходили без
  полной загрузки файла.
- Для видео с реальным Telegram thumbnail отдельный poster теперь отдаётся
  как JPEG. `photoStrippedSize` намеренно не используется как самостоятельный
  скачиваемый файл.
- `downloadToCallable` вызывается с `seekable=false`; callback отдаёт bytes в
  той же последовательности, в которой их запрашивает текущий HTTP response.
- Для полного GET текущий путь одновременно stream'ит и создаёт cache file
  только после точной проверки размера. Частичный Range в cache не считается
  готовым файлом.
- `503` может быть сформирован нашим кодом: global
  `madeline_session.guard` в `start_madeline_locked()` либо media cache lock,
  а не обязательно внутренним lock Madeline.
- C#-сериализация Telegram streams всё ещё не является целевой архитектурой:
  большой активный Range всё равно способен задержать другой poster или seek.
  Нужен server-side owner/block cache ниже.

## Что проверить в первую очередь

1. Один и два байта, открытый и суффиксный Range: тело, `Content-Range`,
   `Content-Length`, порядок bytes, 416 и HEAD.
2. Источник каждого `503`: session guard, cache lock, PHP timeout, proxy или
   C# cancellation.
3. Не буферизует ли C#/WebView весь response и не закрывает ли upstream раньше
   чтения WebView.
4. Семантику `$offset/$end` установленной версии MadelineProto; callback
   должен возвращать число фактически принятых bytes.
5. Поведение при одновременных запросах начала/конца одного видео, нескольких
   быстрых seek и thumbnail другого сообщения.

## Желаемый серверный дизайн

- Один постоянно работающий владелец Madeline session для аккаунта.
- Внутренний IPC/RPC от PHP facade к media worker; browser/desktop не получает
  Telegram credentials и file references.
- Disk cache диапазонов с metadata: media identity/version, MIME, total size,
  ready ranges и in-flight ranges.
- Дедупликация: два HTTP requests одного блока разделяют одну Telegram
  download task.
- Приоритеты: thumbnail и metadata → текущий playback/seek → read-ahead →
  background cache.
- Частичный cache не выдаётся как полный: используется range map или другой
  явный индекс готовых блоков.
- HTTP request ожидает нужный блок асинхронно в ограниченный срок; обычное
  ожидание очереди не превращается в 503.

## Ограничения проекта

- Не отправлять тестовые сообщения, не менять read receipts, реакции, QR,
  provider sessions или production database при диагностике.
- Не публиковать внутренние порты и не передавать Telegram auth/session на
  клиент.
- Перед live patch: narrow diff, backup, hashes, lint, rollback note и
  перезапускать только необходимый service.
