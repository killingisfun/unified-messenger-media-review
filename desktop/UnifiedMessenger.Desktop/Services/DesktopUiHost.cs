using Microsoft.Web.WebView2.Core;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.IO;

namespace UnifiedMessenger.Desktop.Services;

/// <summary>
/// Serves the packaged UI from a WebView virtual host and substitutes only
/// allowlisted API requests with authenticated native HTTPS calls. No loopback
/// PHP listener, SSH tunnel, or browser-held bearer credential is involved.
/// </summary>
public sealed class DesktopUiHost : IDisposable
{
    public const string VirtualHost = "appassets.local";
    private readonly string _uiRoot;
    private readonly DesktopApiClient _api;
    // Madeline uses one Telegram session writer. WebView's media element can
    // probe the same video with several byte ranges at once; serializing those
    // probes prevents the server-side session lock from turning healthy reads
    // into 503 "busy" responses.
    private readonly SemaphoreSlim _telegramMediaGate = new(1, 1);
    private CoreWebView2? _webView;
    private bool _disposed;

    public DesktopUiHost(DesktopApiClient api, string uiRoot)
    {
        _api = api;
        _uiRoot = uiRoot;
        if (!File.Exists(Path.Combine(_uiRoot, "main.php")))
            throw new InvalidOperationException("Не найден встроенный интерфейс приложения.");
    }

    public void Attach(CoreWebView2 webView)
    {
        ThrowIfDisposed();
        if (_webView is not null) throw new InvalidOperationException("Desktop UI уже подключён.");
        _webView = webView;
        // Do not use SetVirtualHostNameToFolderMapping here. Mapped files are
        // served before WebResourceRequested, which exposes main.php as text
        // and bypasses the native authenticated API boundary. C# serves both
        // static assets and the small dynamic allowlist below.
        _webView.AddWebResourceRequestedFilter($"https://{VirtualHost}/*", CoreWebView2WebResourceContext.All);
        _webView.WebResourceRequested += WebResourceRequested;
    }

    public Uri StartUri => new($"https://{VirtualHost}/main.php");

    private void WebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs eventArgs)
    {
        if (!Uri.TryCreate(eventArgs.Request.Uri, UriKind.Absolute, out var requestUri)
            || !requestUri.Host.Equals(VirtualHost, StringComparison.OrdinalIgnoreCase)) return;
        var deferral = eventArgs.GetDeferral();
        _ = HandleResourceAsync(eventArgs, requestUri, deferral);
    }

    private CoreWebView2WebResourceResponse ServeStaticAsset(string absolutePath)
    {
        var decodedPath = Uri.UnescapeDataString(absolutePath);
        var relativePath = decodedPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        var root = Path.GetFullPath(_uiRoot);
        var candidate = Path.GetFullPath(Path.Combine(root, relativePath));
        var contained = candidate.Equals(root, StringComparison.OrdinalIgnoreCase)
            || candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        if (!contained) return CreateTextResponse("Forbidden", 403, "Forbidden", "text/plain; charset=utf-8");
        // main.php is rendered above; no other packaged PHP file is a static
        // resource and must never be revealed as source code to the WebView.
        if (Path.GetExtension(candidate).Equals(".php", StringComparison.OrdinalIgnoreCase))
            return CreateTextResponse("Not found", 404, "Not Found", "text/plain; charset=utf-8");
        if (!File.Exists(candidate)) return CreateTextResponse("Not found", 404, "Not Found", "text/plain; charset=utf-8");

        var file = new FileInfo(candidate);
        var contentType = Path.GetExtension(candidate).ToLowerInvariant() switch
        {
            ".js" or ".mjs" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".html" => "text/html; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            ".ico" => "image/x-icon",
            ".woff2" => "font/woff2",
            ".woff" => "font/woff",
            _ => "application/octet-stream",
        };
        return _webView!.Environment.CreateWebResourceResponse(
            File.OpenRead(candidate), 200, "OK",
            $"Content-Type: {contentType}\r\nContent-Length: {file.Length}\r\nCache-Control: no-store");
    }

    private async Task HandleResourceAsync(CoreWebView2WebResourceRequestedEventArgs eventArgs, Uri requestUri, CoreWebView2Deferral deferral)
    {
        try
        {
            var path = requestUri.AbsolutePath;
            if (path.Equals("/main.php", StringComparison.OrdinalIgnoreCase))
            {
                eventArgs.Response = CreateTextResponse(RenderMainDocument(), 200, "OK", "text/html; charset=utf-8");
                return;
            }
            if (path.Equals("/index.php", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/desktop_api.php", StringComparison.OrdinalIgnoreCase))
            {
                eventArgs.Response = await ForwardApiAsync(eventArgs.Request, requestUri);
                return;
            }
            if (path.Equals("/telegram_service/rest.php", StringComparison.OrdinalIgnoreCase))
            {
                eventArgs.Response = await ForwardTelegramMediaAsync(eventArgs.Request, requestUri);
                return;
            }
            if (path.Equals("/telegram_download.php", StringComparison.OrdinalIgnoreCase))
            {
                eventArgs.Response = await ForwardTelegramDownloadAsync(eventArgs.Request, requestUri);
                return;
            }
            if (path.Equals("/max_api.php", StringComparison.OrdinalIgnoreCase))
            {
                eventArgs.Response = await ForwardMaxMediaAsync(eventArgs.Request, requestUri);
                return;
            }
            if (path.Equals("/media_stream.php", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/media_proxy.php", StringComparison.OrdinalIgnoreCase))
            {
                // VK and Avito histories deliberately keep their media behind
                // a same-origin streaming relay. The virtual UI host keeps
                // that contract through the authenticated desktop facade.
                eventArgs.Response = await ForwardExternalMediaAsync(eventArgs.Request, requestUri);
                return;
            }
            if (path.StartsWith("/uploads/avatar/", StringComparison.OrdinalIgnoreCase))
            {
                eventArgs.Response = await ForwardAvatarAsync(eventArgs.Request, requestUri);
                return;
            }
            if (ProviderRoutes.Contains(path))
            {
                eventArgs.Response = await ForwardProviderRouteAsync(eventArgs.Request, requestUri, path.TrimStart('/'));
                return;
            }
            eventArgs.Response = ServeStaticAsset(requestUri.AbsolutePath);
        }
        catch (Exception exception)
        {
            var requestPath = "unknown";
            try { requestPath = new Uri(eventArgs.Request.Uri).AbsolutePath; } catch { }
            var message = exception.Message.Replace('\r', ' ').Replace('\n', ' ');
            if (message.Length > 160) message = message[..160];
            var detail = $"{requestPath}:{exception.GetType().Name}:0x{exception.HResult:X8}:{message}";
            RecordTransport("unhandled", 502, detail);
            eventArgs.Response = CreateTextResponse(
                "{\"success\":false,\"message\":\"Desktop transport request failed.\"}",
                502,
                "Bad Gateway",
                "application/json; charset=utf-8");
            System.Diagnostics.Debug.WriteLine(exception);
        }
        finally { deferral.Complete(); }
    }

    private async Task<CoreWebView2WebResourceResponse> ForwardTelegramMediaAsync(CoreWebView2WebResourceRequest request, Uri requestUri)
    {
        if (!string.Equals(request.Method, "GET", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(request.Method, "HEAD", StringComparison.OrdinalIgnoreCase))
            return CreateTextResponse("Method not allowed", 405, "Method Not Allowed", "text/plain; charset=utf-8");
        var parameters = ParseQuery(requestUri.Query);
        if (!parameters.Remove("action", out var action) || (action != "downloadMedia" && action != "downloadThumb"))
            return CreateTextResponse("Not found", 404, "Not Found", "text/plain; charset=utf-8");
        var rangeHeaders = ReadSingleRangeHeader(request);
        if (rangeHeaders is null)
            return CreateTextResponse("Range not satisfiable", 416, "Range Not Satisfiable", "text/plain; charset=utf-8");
        parameters["telegram_action"] = action;
        return await CreateTelegramMediaResponseAsync(
            () => SendTelegramMediaWithThumbnailFallbackAsync(
                new HttpMethod(request.Method), parameters, requestHeaders: rangeHeaders),
            request.Method);
    }

    private async Task<CoreWebView2WebResourceResponse> ForwardTelegramDownloadAsync(CoreWebView2WebResourceRequest request, Uri requestUri)
    {
        if (!string.Equals(request.Method, "GET", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(request.Method, "HEAD", StringComparison.OrdinalIgnoreCase))
            return CreateTextResponse("Method not allowed", 405, "Method Not Allowed", "text/plain; charset=utf-8");

        var source = ParseQuery(requestUri.Query);
        if (!source.TryGetValue("chat_id", out var chatId) || !TelegramChatIdPattern.IsMatch(chatId)
            || !source.TryGetValue("message_id", out var messageId) || !TelegramMessageIdPattern.IsMatch(messageId)
            || source.Any(pair => pair.Key is not ("chat_id" or "message_id" or "name" or "inline" or "dl" or "thumb" or "kind" or "r"))
                || !TelegramOptionalFlagValuesAreValid(source))
            return CreateTextResponse("Not found", 404, "Not Found", "text/plain; charset=utf-8");

        // telegram_download.php is the production browser route generated by
        // the Telegram adapter.  Convert only its bounded identifiers to the
        // existing authenticated direct relay; do not expose arbitrary URLs.
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["telegram_action"] = source.TryGetValue("thumb", out var thumb) && thumb == "1" ? "downloadThumb" : "downloadMedia",
            ["chatId"] = chatId,
            ["messageId"] = messageId,
        };
        if (source.TryGetValue("dl", out var download)) parameters["dl"] = download;
        var rangeHeaders = ReadSingleRangeHeader(request);
        if (rangeHeaders is null)
            return CreateTextResponse("Range not satisfiable", 416, "Range Not Satisfiable", "text/plain; charset=utf-8");
        // A missing Telegram thumbnail can safely use the original only for
        // an image tile. A video element expects an image poster, never MP4
        // bytes, so replacing its absent poster with the original video
        // corrupts the browser media contract and can surface as a video
        // error even though the file itself is available.
        var canFallbackToOriginalImage = source.TryGetValue("kind", out var kind)
            && (kind.Equals("photo", StringComparison.OrdinalIgnoreCase)
                || kind.Equals("image", StringComparison.OrdinalIgnoreCase));
        return await CreateTelegramMediaResponseAsync(
            () => SendTelegramMediaWithThumbnailFallbackAsync(
                new HttpMethod(request.Method), parameters, canFallbackToOriginalImage, rangeHeaders),
            request.Method);
    }

    private async Task<CoreWebView2WebResourceResponse> CreateTelegramMediaResponseAsync(
        Func<Task<HttpResponseMessage>> send,
        string requestMethod)
    {
        var acquiredGate = false;
        var releaseGate = true;
        HttpResponseMessage? response = null;
        try
        {
            using var queueTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try
            {
                await _telegramMediaGate.WaitAsync(queueTimeout.Token);
                acquiredGate = true;
            }
            catch (OperationCanceledException) when (queueTimeout.IsCancellationRequested)
            {
                RecordTransport("telegram_media_queue", 503, requestMethod);
                return CreateTextResponse(
                    "Telegram media queue timed out; retry the request.",
                    503,
                    "Service Unavailable",
                    "text/plain; charset=utf-8");
            }
            response = await send();
            RecordTransport("telegram_media", (int)response.StatusCode, requestMethod);
            var stream = await response.Content.ReadAsStreamAsync();
            var headers = BuildResponseHeaders(response);
            var statusCode = (int)response.StatusCode;
            var reasonPhrase = response.ReasonPhrase ?? "OK";
            var ownedResponse = response;
            response = null;
            var ownedStream = new ResponseOwnedStream(
                stream,
                ownedResponse,
                () => _telegramMediaGate.Release(),
                ownedResponse.Content.Headers.ContentLength,
                readTimeout: TimeSpan.FromSeconds(30));
            try
            {
                var webResponse = _webView!.Environment.CreateWebResourceResponse(
                    ownedStream, statusCode, reasonPhrase, headers);
                releaseGate = false;
                return webResponse;
            }
            catch
            {
                // The WebView factory can throw. Make that path release both
                // the response and the gate instead of stalling every poster.
                ownedStream.Dispose();
                releaseGate = false;
                throw;
            }
        }
        finally
        {
            response?.Dispose();
            if (acquiredGate && releaseGate) _telegramMediaGate.Release();
        }
    }

    /// <summary>
    /// Telegram messages are allowed to have no thumbnail while their original
    /// media is available. Only photo/image previews can use that original as
    /// a replacement: video and audio previews must retain their own media
    /// contract. Authorization and transient provider failures stay visible
    /// to the UI unchanged.
    /// </summary>
    private async Task<HttpResponseMessage> SendTelegramMediaWithThumbnailFallbackAsync(
        HttpMethod method,
        Dictionary<string, string> parameters,
        bool canFallbackToOriginalImage = false,
        IReadOnlyDictionary<string, string>? requestHeaders = null)
    {
        var response = await _api.SendApiAsync(
            method, "telegram_media", parameters, requestHeaders: requestHeaders);
        var legacyTinyPngPlaceholder = string.Equals(
                response.Content.Headers.ContentType?.MediaType,
                "image/png",
                StringComparison.OrdinalIgnoreCase)
            && response.Content.Headers.ContentLength is > 0 and <= 128;
        var missingThumbnail = response.StatusCode == HttpStatusCode.NotFound
            || response.Headers.TryGetValues("X-Unified-Telegram-Thumbnail-Placeholder", out var values)
                && values.Any(value => string.Equals(value, "1", StringComparison.Ordinal))
            || legacyTinyPngPlaceholder;
        if (!canFallbackToOriginalImage
            || !missingThumbnail
            || !parameters.TryGetValue("telegram_action", out var action)
            || !string.Equals(action, "downloadThumb", StringComparison.Ordinal))
            return response;

        response.Dispose();
        parameters["telegram_action"] = "downloadMedia";
        return await _api.SendApiAsync(
            method, "telegram_media", parameters, requestHeaders: requestHeaders);
    }

    private async Task<CoreWebView2WebResourceResponse> ForwardMaxMediaAsync(CoreWebView2WebResourceRequest request, Uri requestUri)
    {
        if (!string.Equals(request.Method, "GET", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(request.Method, "HEAD", StringComparison.OrdinalIgnoreCase))
            return CreateTextResponse("Method not allowed", 405, "Method Not Allowed", "text/plain; charset=utf-8");

        var parameters = ParseQuery(requestUri.Query);
        if (!parameters.Remove("resource", out var resource) || resource != "media"
            || !parameters.Remove("ref", out var mediaRef) || !MaxMediaRefPattern.IsMatch(mediaRef)
            || parameters.Any(pair => pair.Key != "r" || !CacheBusterPattern.IsMatch(pair.Value)))
            return CreateTextResponse("Not found", 404, "Not Found", "text/plain; charset=utf-8");

        var headers = ReadSingleRangeHeader(request);
        if (headers is null)
            return CreateTextResponse("Range not satisfiable", 416, "Range Not Satisfiable", "text/plain; charset=utf-8");

        var response = await _api.SendApiAsync(
            new HttpMethod(request.Method), "max_media",
            new Dictionary<string, string>(StringComparer.Ordinal) { ["ref"] = mediaRef },
            requestHeaders: headers);
        RecordTransport("max_media", (int)response.StatusCode, request.Method);
        var stream = await response.Content.ReadAsStreamAsync();
        return _webView!.Environment.CreateWebResourceResponse(
            new ResponseOwnedStream(stream, response), (int)response.StatusCode,
            response.ReasonPhrase ?? "OK", BuildResponseHeaders(response));
    }

    private static Dictionary<string, string>? ReadSingleRangeHeader(CoreWebView2WebResourceRequest request)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? range = null;
        // WebView2 throws COMException for GetHeader when an optional header
        // is absent. Ordinary image requests do not carry Range, so check
        // presence first and still keep a defensive catch.
        try
        {
            if (request.Headers.Contains("Range")) range = request.Headers.GetHeader("Range");
        }
        catch (System.Runtime.InteropServices.COMException) { range = null; }
        if (!string.IsNullOrWhiteSpace(range))
        {
            if (!RangePattern.IsMatch(range)) return null;
            headers["Range"] = range;
        }
        return headers;
    }

    private async Task<CoreWebView2WebResourceResponse> ForwardExternalMediaAsync(CoreWebView2WebResourceRequest request, Uri requestUri)
    {
        if (!string.Equals(request.Method, "GET", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(request.Method, "HEAD", StringComparison.OrdinalIgnoreCase))
            return CreateTextResponse("Method not allowed", 405, "Method Not Allowed", "text/plain; charset=utf-8");

        var parameters = ParseQuery(requestUri.Query);
        if (!parameters.Remove("u", out var upstream)
            || !IsTrustedExternalMediaUri(upstream)
            || !ExternalMediaParametersAreValid(parameters))
            return CreateTextResponse("Not found", 404, "Not Found", "text/plain; charset=utf-8");
        parameters["u"] = upstream;

        var rangeHeaders = ReadSingleRangeHeader(request);
        if (rangeHeaders is null)
            return CreateTextResponse("Range not satisfiable", 416, "Range Not Satisfiable", "text/plain; charset=utf-8");

        var response = await _api.SendApiAsync(
            new HttpMethod(request.Method), "stream_external_media", parameters, requestHeaders: rangeHeaders);
        RecordTransport("stream_external_media", (int)response.StatusCode, request.Method);
        var stream = await response.Content.ReadAsStreamAsync();
        return _webView!.Environment.CreateWebResourceResponse(
            new ResponseOwnedStream(stream, response), (int)response.StatusCode,
            response.ReasonPhrase ?? "OK", BuildResponseHeaders(response));
    }

    private async Task<CoreWebView2WebResourceResponse> ForwardAvatarAsync(CoreWebView2WebResourceRequest request, Uri requestUri)
    {
        if (!string.Equals(request.Method, "GET", StringComparison.OrdinalIgnoreCase))
            return CreateTextResponse("Method not allowed", 405, "Method Not Allowed", "text/plain; charset=utf-8");
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["avatar_path"] = requestUri.AbsolutePath,
        };
        var response = await _api.SendApiAsync(HttpMethod.Get, "stream_avatar", parameters);
        RecordTransport("stream_avatar", (int)response.StatusCode, request.Method);
        var stream = await response.Content.ReadAsStreamAsync();
        return _webView!.Environment.CreateWebResourceResponse(
            new ResponseOwnedStream(stream, response), (int)response.StatusCode,
            response.ReasonPhrase ?? "OK", BuildResponseHeaders(response));
    }

    private async Task<CoreWebView2WebResourceResponse> ForwardProviderRouteAsync(CoreWebView2WebResourceRequest request, Uri requestUri, string route)
    {
        var parameters = ParseQuery(requestUri.Query);
        parameters["route"] = route;
        var method = new HttpMethod(request.Method);
        var content = ForwardRequestContent(request);
        HttpResponseMessage response;
        try
        {
            response = await _api.SendApiAsync(method, "provider_route", parameters, content);
        }
        catch
        {
            content?.Dispose();
            throw;
        }
        var stream = await response.Content.ReadAsStreamAsync();
        return _webView!.Environment.CreateWebResourceResponse(new ResponseOwnedStream(stream, response), (int)response.StatusCode, response.ReasonPhrase ?? "OK", BuildResponseHeaders(response));
    }

    private async Task<CoreWebView2WebResourceResponse> ForwardApiAsync(CoreWebView2WebResourceRequest request, Uri requestUri)
    {
        var parameters = ParseQuery(requestUri.Query);
        var method = new HttpMethod(request.Method);
        HttpContent? content = null;
        parameters.Remove("action", out var action);
        if (request.Content is not null)
        {
            var contentType = RequestContentType(request);
            if (string.IsNullOrWhiteSpace(action))
            {
                // The UI puts `action` before any attachment. Inspect only a
                // small bounded prefix, replay it, and stream the remaining
                // bytes to HTTPS.  A video must never become a MemoryStream.
                var prefix = await ReadRequestPrefixAsync(request.Content, contentType?.MediaType);
                action = ExtractBodyAction(prefix, contentType?.MediaType);
                if (string.IsNullOrWhiteSpace(action))
                {
                    request.Content.Dispose();
                    return CreateTextResponse("{\"success\":false,\"message\":\"Missing desktop action.\"}", 400, "Bad Request", "application/json; charset=utf-8");
                }
                content = new StreamContent(new PrefixReplayStream(prefix, request.Content), 81920);
            }
            else
            {
                content = new StreamContent(request.Content, 81920);
            }
            if (contentType is not null) content.Headers.ContentType = contentType;
        }
        if (string.IsNullOrWhiteSpace(action))
            return CreateTextResponse("{\"success\":false,\"message\":\"Missing desktop action.\"}", 400, "Bad Request", "application/json; charset=utf-8");

        RecordTransport("api_action", 0, $"{method.Method}:{action}");
        HttpResponseMessage response;
        try
        {
            response = await _api.SendApiAsync(method, action, parameters, content);
        }
        catch
        {
            content?.Dispose();
            throw;
        }
        if (action is "get_chats_json" or "get_messages_json" or "get_new_messages")
            RecordTransport(action, (int)response.StatusCode, request.Method);
        var stream = await response.Content.ReadAsStreamAsync();
        var headers = BuildResponseHeaders(response);
        return _webView!.Environment.CreateWebResourceResponse(
            new ResponseOwnedStream(stream, response),
            (int)response.StatusCode,
            response.ReasonPhrase ?? "OK",
            headers);
    }

    private static MediaTypeHeaderValue? RequestContentType(CoreWebView2WebResourceRequest request)
    {
        try
        {
            return MediaTypeHeaderValue.TryParse(request.Headers.GetHeader("Content-Type"), out var value) ? value : null;
        }
        catch (System.Runtime.InteropServices.COMException)
        {
            return null;
        }
    }

    private static HttpContent? ForwardRequestContent(CoreWebView2WebResourceRequest request)
    {
        if (request.Content is null) return null;
        var content = new StreamContent(request.Content, 81920);
        var contentType = RequestContentType(request);
        if (contentType is not null) content.Headers.ContentType = contentType;
        return content;
    }

    private static async Task<byte[]> ReadRequestPrefixAsync(Stream input, string? mediaType)
    {
        const int maximumBytes = 64 * 1024;
        var buffer = new byte[4096];
        using var captured = new MemoryStream(Math.Min(maximumBytes, buffer.Length));
        while (captured.Length < maximumBytes)
        {
            var wanted = Math.Min(buffer.Length, maximumBytes - (int)captured.Length);
            var read = await input.ReadAsync(buffer.AsMemory(0, wanted));
            if (read == 0) break;
            captured.Write(buffer, 0, read);
            var prefix = captured.ToArray();
            if (!string.IsNullOrWhiteSpace(ExtractBodyAction(prefix, mediaType))) return prefix;
        }
        return captured.ToArray();
    }

    private static string? ExtractBodyAction(byte[]? body, string? mediaType)
    {
        if (body is null || body.Length == 0 || body.Length > 1024 * 1024) return null;
        var value = Encoding.UTF8.GetString(body);
        if (string.Equals(mediaType, "application/x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var part in value.Split('&'))
            {
                if (!part.StartsWith("action=", StringComparison.Ordinal)) continue;
                return Uri.UnescapeDataString(part[7..].Replace('+', ' '));
            }
        }
        if (string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                using var document = JsonDocument.Parse(body);
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("action", out var action)
                    && action.ValueKind == JsonValueKind.String)
                    return action.GetString();
            }
            catch (JsonException) { return null; }
        }
        var match = Regex.Match(value, "name=\\\"action\\\"\\s*\\r?\\n\\r?\\n(?<action>[A-Za-z0-9_]{1,80})", RegexOptions.CultureInvariant);
        return match.Success ? match.Groups["action"].Value : null;
    }

    private CoreWebView2WebResourceResponse CreateTextResponse(string body, int status, string reason, string contentType)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        return _webView!.Environment.CreateWebResourceResponse(
            new MemoryStream(bytes), status, reason,
            $"Content-Type: {contentType}\r\nContent-Length: {bytes.Length}\r\nCache-Control: no-store");
    }

    private string RenderMainDocument()
    {
        var template = File.ReadAllText(Path.Combine(_uiRoot, "main.php"));
        var start = template.IndexOf("<!DOCTYPE html>", StringComparison.OrdinalIgnoreCase);
        if (start < 0) throw new InvalidOperationException("Встроенный интерфейс повреждён.");
        var html = template[start..];
        const string config = "window.APP_CONFIG = { telegramUrl: '', wppconnectUrl: '', wppconnectKey: '', defaultAvatar: '', previewMode: false, bridgeMode: false, realtimeUrl: '', historyWorkerUrl: '', bridgeToken: '', chatCacheScope: '', autoMarkRead: true, desktopMode: true };";
        html = Regex.Replace(html, @"window\.APP_CONFIG\s*=\s*\{[\s\S]*?\n\s*\};", config, RegexOptions.CultureInvariant);
        html = Regex.Replace(html, @"<\?=[\s\S]*?\?>", "''", RegexOptions.CultureInvariant);
        return html;
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var item in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = item.IndexOf('=');
            var key = Uri.UnescapeDataString(separator < 0 ? item : item[..separator]);
            var value = Uri.UnescapeDataString(separator < 0 ? "" : item[(separator + 1)..]);
            if (key.Length > 0 && key.Length <= 128 && value.Length <= 16 * 1024) result[key] = value;
        }
        return result;
    }

    private static string BuildResponseHeaders(HttpResponseMessage response)
    {
        var headers = new StringBuilder("Cache-Control: no-store\r\n");
        foreach (var header in response.Headers.Concat(response.Content.Headers))
        {
            if (!AllowedResponseHeaders.Contains(header.Key)) continue;
            var value = string.Join(",", header.Value).Replace("\r", "").Replace("\n", "");
            headers.Append(header.Key).Append(": ").Append(value).Append("\r\n");
        }
        return headers.ToString();
    }

    private static readonly HashSet<string> AllowedResponseHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Content-Type", "Content-Length", "Content-Range", "Content-Disposition", "Accept-Ranges",
    };

    private static readonly Regex MaxMediaRefPattern = new("^[A-Za-z0-9_-]{20,128}$", RegexOptions.CultureInvariant);
    private static readonly Regex CacheBusterPattern = new("^[0-9]{1,20}$", RegexOptions.CultureInvariant);
    private static readonly Regex RangePattern = new("^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$", RegexOptions.CultureInvariant);
    private static readonly Regex TelegramChatIdPattern = new("^-?[0-9]{1,20}$", RegexOptions.CultureInvariant);
    private static readonly Regex TelegramMessageIdPattern = new("^[1-9][0-9]{0,19}$", RegexOptions.CultureInvariant);

    private static bool ExternalMediaParametersAreValid(IReadOnlyDictionary<string, string> parameters)
    {
        foreach (var parameter in parameters)
        {
            var valid = parameter.Key switch
            {
                "download" or "dl" or "view" => parameter.Value is "0" or "1",
                "name" or "fn" => parameter.Value.Length is > 0 and <= 255
                    && !parameter.Value.Contains('\0'),
                "_r" => CacheBusterPattern.IsMatch(parameter.Value),
                _ => false,
            };
            if (!valid) return false;
        }
        return true;
    }

    private static bool IsTrustedExternalMediaUri(string value)
    {
        if (value.Length is 0 or > 8192 || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || uri.UserInfo.Length != 0) return false;
        if (uri.Port != -1 && !((uri.Scheme == Uri.UriSchemeHttps && uri.Port == 443)
            || (uri.Scheme == Uri.UriSchemeHttp && uri.Port == 80))) return false;
        var host = uri.Host.TrimEnd('.');
        if (host.Length == 0 || !Regex.IsMatch(host, "^[a-z0-9.-]+$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) return false;
        return TrustedExternalMediaHosts.Any(suffix => host.Equals(suffix, StringComparison.OrdinalIgnoreCase)
            || host.EndsWith('.' + suffix, StringComparison.OrdinalIgnoreCase));
    }

    private static readonly string[] TrustedExternalMediaHosts =
    {
        "vk.com", "vkuseraudio.net", "userapi.com", "vkuser.net", "vk-cdn.net",
        "avito.ru", "avito.st", "avito.net",
    };

    private static bool TelegramOptionalFlagValuesAreValid(IReadOnlyDictionary<string, string> parameters)
    {
        foreach (var key in new[] { "inline", "dl", "thumb" })
        {
            if (parameters.TryGetValue(key, out var value) && value is not ("0" or "1")) return false;
        }
        if (parameters.TryGetValue("name", out var name) && name.Length > 255) return false;
        // Shared media retry adds a numeric cache buster (`r`). It is not
        // forwarded to Telegram, but it must be accepted by this bounded
        // browser route or the first retry turns a recoverable video read
        // into a local 404.
        if (parameters.TryGetValue("r", out var cacheBuster) && !CacheBusterPattern.IsMatch(cacheBuster)) return false;
        return !parameters.TryGetValue("kind", out var kind)
            || kind is "photo" or "image" or "sticker" or "video" or "audio" or "document";
    }

    private static readonly object TransportLogLock = new();
    private static string TransportLogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "UnifiedMessenger", "desktop-transport.log");

    private static void RecordTransport(string route, int status, string detail)
    {
        try
        {
            var directory = Path.GetDirectoryName(TransportLogPath)!;
            Directory.CreateDirectory(directory);
            lock (TransportLogLock)
            {
                var info = new FileInfo(TransportLogPath);
                if (info.Exists && info.Length > 256 * 1024)
                    File.Move(TransportLogPath, TransportLogPath + ".previous", true);
                File.AppendAllText(TransportLogPath,
                    $"{DateTimeOffset.UtcNow:O} route={route} status={status} detail={detail}\r\n");
            }
        }
        catch { /* diagnostics must never affect the transport */ }
    }

    private static readonly HashSet<string> ProviderRoutes = new(StringComparer.OrdinalIgnoreCase)
    {
        "/ai_api.php", "/telegram_auth.php", "/max_auth.php", "/wpp_status.php", "/wpp_link_code.php", "/wpp_proxy.php", "/provider_logout.php",
    };

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_webView is not null) _webView.WebResourceRequested -= WebResourceRequested;
        _api.Dispose();
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(DesktopUiHost));
    }

    /// <summary>
    /// Replays the small inspected request prefix before continuing from the
    /// original WebView stream. Disposing it also closes that input stream,
    /// which is owned by the outgoing HttpRequestMessage.
    /// </summary>
    private sealed class PrefixReplayStream(byte[] prefix, Stream source) : Stream
    {
        private int _offset;

        public override bool CanRead => source.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_offset < prefix.Length)
            {
                var available = Math.Min(count, prefix.Length - _offset);
                Buffer.BlockCopy(prefix, _offset, buffer, offset, available);
                _offset += available;
                return available;
            }
            return source.Read(buffer, offset, count);
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_offset < prefix.Length)
            {
                var available = Math.Min(buffer.Length, prefix.Length - _offset);
                prefix.AsMemory(_offset, available).CopyTo(buffer);
                _offset += available;
                return available;
            }
            return await source.ReadAsync(buffer, cancellationToken);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) source.Dispose();
            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            await source.DisposeAsync();
            GC.SuppressFinalize(this);
        }
    }

    private sealed class ResponseOwnedStream(
        Stream stream,
        HttpResponseMessage response,
        Action? onDispose = null,
        long? contentLength = null,
        CancellationTokenSource? bodyLifetime = null,
        TimeSpan? readTimeout = null) : Stream
    {
        private long _bytesRead;
        private int _ownersReleased;
        private readonly CancellationTokenSource _bodyLifetime = bodyLifetime ?? new CancellationTokenSource();
        private readonly TimeSpan _readTimeout = readTimeout ?? TimeSpan.FromSeconds(30);
        public override bool CanRead => Volatile.Read(ref _ownersReleased) == 0 && stream.CanRead;
        public override bool CanSeek => stream.CanSeek;
        public override bool CanWrite => false;
        public override long Length => stream.Length;
        public override long Position { get => stream.Position; set => stream.Position = value; }
        public override void Flush() => stream.Flush();
        public override Task FlushAsync(CancellationToken cancellationToken) => stream.FlushAsync(cancellationToken);
        public override int Read(byte[] buffer, int offset, int count)
            => ReadCore(count, () => ReadSyncWithTimeout(buffer, offset, count));
        public override int Read(Span<byte> buffer)
        {
            if (buffer.Length == 0 || Volatile.Read(ref _ownersReleased) != 0) return 0;
            try
            {
                return CompleteRead(buffer.Length, stream.Read(buffer));
            }
            catch
            {
                DisposeOwners();
                throw;
            }
        }
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => await ReadCoreAsync(count, token => stream.ReadAsync(buffer, offset, count, token), cancellationToken);
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => await ReadCoreAsync(buffer.Length, token => stream.ReadAsync(buffer, token).AsTask(), cancellationToken);
        public override long Seek(long offset, SeekOrigin origin) => stream.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing) DisposeOwners();
            base.Dispose(disposing);
        }
        public override async ValueTask DisposeAsync()
        {
            DisposeOwners();
            await base.DisposeAsync();
        }

        private void DisposeOwners()
        {
            if (Interlocked.Exchange(ref _ownersReleased, 1) != 0) return;
            try { _bodyLifetime.Cancel(); }
            finally
            {
                try { stream.Dispose(); }
                finally
                {
                    try { response.Dispose(); }
                    finally
                    {
                        try { _bodyLifetime.Dispose(); }
                        finally { onDispose?.Invoke(); }
                    }
                }
            }
        }

        private int ReadSyncWithTimeout(byte[] buffer, int offset, int count)
            => ReadWithTimeoutAsync(token => stream.ReadAsync(buffer, offset, count, token), CancellationToken.None)
                .GetAwaiter().GetResult();

        private int ReadCore(int requestedCount, Func<int> read)
        {
            if (requestedCount == 0 || Volatile.Read(ref _ownersReleased) != 0) return 0;
            try
            {
                return CompleteRead(requestedCount, read());
            }
            catch
            {
                DisposeOwners();
                throw;
            }
        }

        private async Task<int> ReadCoreAsync(
            int requestedCount,
            Func<CancellationToken, Task<int>> read,
            CancellationToken cancellationToken)
        {
            if (requestedCount == 0 || Volatile.Read(ref _ownersReleased) != 0) return 0;
            try
            {
                return CompleteRead(requestedCount, await ReadWithTimeoutAsync(read, cancellationToken));
            }
            catch
            {
                DisposeOwners();
                throw;
            }
        }

        private async Task<int> ReadWithTimeoutAsync(
            Func<CancellationToken, Task<int>> read,
            CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken, _bodyLifetime.Token);
            timeout.CancelAfter(_readTimeout);
            return await read(timeout.Token);
        }

        private int CompleteRead(int requestedCount, int bytesRead)
        {
            if (bytesRead > 0)
            {
                var totalRead = Interlocked.Add(ref _bytesRead, bytesRead);
                // A known Content-Length is definitive: WebView need not make
                // one more read solely to discover EOF before the next media
                // request can proceed.
                if (contentLength is long expected && totalRead >= expected) DisposeOwners();
            }
            else if (requestedCount > 0)
            {
                // A zero-length read with a non-empty destination means EOF.
                DisposeOwners();
            }
            return bytesRead;
        }
    }
}
