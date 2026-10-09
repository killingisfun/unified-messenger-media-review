using System.Net.Http.Headers;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.IO;

namespace UnifiedMessenger.Desktop.Services;

public sealed record DirectConnection(Uri ServerUri, string DeviceId, string DeviceSecret)
{
    public string AuthorizationValue => $"Bearer {DeviceId}.{DeviceSecret}";

    public void Validate()
    {
        if (ServerUri.Scheme != Uri.UriSchemeHttps || string.IsNullOrWhiteSpace(ServerUri.Host))
            throw new InvalidOperationException("Адрес сервера должен использовать HTTPS.");
        if (!System.Text.RegularExpressions.Regex.IsMatch(DeviceId, "^umd_[A-Za-z0-9_-]{16,96}$")
            || !System.Text.RegularExpressions.Regex.IsMatch(DeviceSecret, "^[A-Za-z0-9_-]{32,96}$"))
            throw new InvalidOperationException("Получены некорректные данные устройства.");
    }
}

public static class DirectConnectionStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("UnifiedMessenger/DesktopConnection/v1");

    private static string StoragePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "UnifiedMessenger", "connection.bin");

    public static async Task<DirectConnection?> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(StoragePath)) return null;
        var protectedPayload = await File.ReadAllBytesAsync(StoragePath, cancellationToken);
        var json = ProtectedData.Unprotect(protectedPayload, Entropy, DataProtectionScope.CurrentUser);
        var stored = JsonSerializer.Deserialize<StoredConnection>(json) ?? throw new InvalidOperationException("Файл подключения повреждён.");
        if (!Uri.TryCreate(stored.Server, UriKind.Absolute, out var server)) throw new InvalidOperationException("Файл подключения содержит неверный сервер.");
        var connection = new DirectConnection(server, stored.DeviceId ?? string.Empty, stored.DeviceSecret ?? string.Empty);
        connection.Validate();
        return connection;
    }

    public static async Task SaveAsync(DirectConnection connection, CancellationToken cancellationToken = default)
    {
        connection.Validate();
        var directory = Path.GetDirectoryName(StoragePath)!;
        Directory.CreateDirectory(directory);
        var json = JsonSerializer.SerializeToUtf8Bytes(new StoredConnection(connection.ServerUri.AbsoluteUri, connection.DeviceId, connection.DeviceSecret));
        var protectedPayload = ProtectedData.Protect(json, Entropy, DataProtectionScope.CurrentUser);
        var temporaryPath = StoragePath + ".tmp";
        await File.WriteAllBytesAsync(temporaryPath, protectedPayload, cancellationToken);
        File.Move(temporaryPath, StoragePath, overwrite: true);
    }

    public static void Remove()
    {
        if (File.Exists(StoragePath)) File.Delete(StoragePath);
    }

    private sealed record StoredConnection(string Server, string? DeviceId, string? DeviceSecret);
}

public sealed class InvitationPairingClient(HttpMessageHandler? handler = null) : IDisposable
{
    private readonly HttpClient _http = handler is null ? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) : new HttpClient(handler, disposeHandler: false);

    public async Task<DirectConnection> RedeemAsync(string invitationText, string deviceLabel, CancellationToken cancellationToken = default)
    {
        var invitation = ParseInvitation(invitationText);
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(invitation.ServerUri, "desktop_auth.php"))
        {
            Content = JsonContent.Create(new
            {
                action = "redeem",
                invite = invitation.InviteId,
                secret = invitation.Secret,
                device_label = string.IsNullOrWhiteSpace(deviceLabel) ? Environment.MachineName : deviceLabel,
            }),
        };
        request.Headers.UserAgent.ParseAdd("UnifiedMessengerDesktop/1");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        var document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(timeout.Token));
        if (!response.IsSuccessStatusCode || !document.RootElement.TryGetProperty("success", out var success) || !success.GetBoolean())
            throw new InvalidOperationException("Приглашение не принято сервером.");
        var device = document.RootElement.GetProperty("device");
        var connection = new DirectConnection(
            invitation.ServerUri,
            device.GetProperty("device_id").GetString() ?? string.Empty,
            device.GetProperty("device_secret").GetString() ?? string.Empty);
        connection.Validate();
        return connection;
    }

    public static DesktopInvitation ParseInvitation(string rawInvitation)
    {
        const string prefix = "um1.";
        var value = rawInvitation.Trim();
        if (!value.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidOperationException("Неизвестный формат ключа подключения.");
        var body = value[prefix.Length..].Replace('-', '+').Replace('_', '/');
        body = body.PadRight(body.Length + (4 - body.Length % 4) % 4, '=');
        JsonDocument document;
        try { document = JsonDocument.Parse(Convert.FromBase64String(body)); }
        catch (Exception exception) when (exception is FormatException or JsonException) { throw new InvalidOperationException("Ключ подключения повреждён."); }
        using (document)
        {
            var root = document.RootElement;
            if (!root.TryGetProperty("v", out var version) || version.GetInt32() != 1
                || !Uri.TryCreate(root.GetProperty("server").GetString(), UriKind.Absolute, out var server)
                || server.Scheme != Uri.UriSchemeHttps) throw new InvalidOperationException("Ключ подключения содержит неверный сервер.");
            var invite = root.GetProperty("invite").GetString() ?? string.Empty;
            var secret = root.GetProperty("secret").GetString() ?? string.Empty;
            if (!System.Text.RegularExpressions.Regex.IsMatch(invite, "^[A-Za-z0-9_-]{16,64}$")
                || !System.Text.RegularExpressions.Regex.IsMatch(secret, "^[A-Za-z0-9_-]{32,96}$")) throw new InvalidOperationException("Ключ подключения повреждён.");
            return new DesktopInvitation(server, invite, secret);
        }
    }

    public void Dispose() => _http.Dispose();
}

public sealed record DesktopInvitation(Uri ServerUri, string InviteId, string Secret);

public sealed class DesktopApiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly DirectConnection _connection;
    private readonly SemaphoreSlim _mediaGate = new(3, 3);

    public DesktopApiClient(DirectConnection connection, HttpMessageHandler? handler = null)
    {
        connection.Validate();
        _connection = connection;
        _http = handler is null ? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) : new HttpClient(handler, disposeHandler: false);
    }

    public async Task<HttpResponseMessage> SendApiAsync(HttpMethod method, string action, IReadOnlyDictionary<string, string>? values = null, HttpContent? content = null, CancellationToken cancellationToken = default, IReadOnlyDictionary<string, string>? requestHeaders = null)
    {
        if (!AllowedActions.Contains(action)) throw new InvalidOperationException("Desktop action is not permitted.");
        var builder = new UriBuilder(new Uri(_connection.ServerUri, "desktop_api.php"));
        var pairs = new List<string> { "desktop_action=" + Uri.EscapeDataString(action) };
        // Provider routes have both a POST body and a small routing query
        // (for example wpp_proxy.php?action=logout). Preserve that query for
        // every HTTP verb; the native desktop_action remains authoritative.
        if (values is not null)
            pairs.AddRange(values.Select(pair => Uri.EscapeDataString(pair.Key) + "=" + Uri.EscapeDataString(pair.Value)));
        builder.Query = string.Join("&", pairs);
        // The WebView host may hand us a multipart upload stream.  Keep the
        // request alive only until HttpClient has finished uploading it; do
        // not retain the whole attachment in managed memory.
        using var request = new HttpRequestMessage(method, builder.Uri) { Content = content };
        request.Headers.Authorization = AuthenticationHeaderValue.Parse(_connection.AuthorizationValue);
        request.Headers.Accept.ParseAdd("application/json, text/plain, */*");
        if (requestHeaders is not null)
        {
            foreach (var header in requestHeaders)
            {
                var isRange = header.Key.Equals("Range", StringComparison.OrdinalIgnoreCase);
                var isTrace = header.Key.Equals("X-Unified-Media-Trace", StringComparison.OrdinalIgnoreCase)
                    && System.Text.RegularExpressions.Regex.IsMatch(header.Value, "^d[0-9a-f]{1,16}-[0-9a-f]{1,16}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
                if (!isRange && !isTrace)
                    throw new InvalidOperationException("Desktop request header is not permitted.");
                request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
        }
        if (method != HttpMethod.Get && method != HttpMethod.Head && values is not null && content is null)
            request.Content = new FormUrlEncodedContent(values.Append(new KeyValuePair<string, string>("action", action)));
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        // Uploading a real attachment can legitimately exceed the ordinary
        // API budget. Keep a finite cancellation window, but never abort a
        // healthy large stream merely because it crossed a metadata timeout.
        var isAttachmentUpload = action is "send_message" or "send_message_batch"
            && string.Equals(request.Content?.Headers.ContentType?.MediaType, "multipart/form-data", StringComparison.OrdinalIgnoreCase);
        timeout.CancelAfter(isAttachmentUpload ? TimeSpan.FromMinutes(10) : TimeSpan.FromSeconds(45));
        return await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
    }

    public async Task CopyMediaAsync(Uri mediaUri, Stream destination, CancellationToken cancellationToken = default)
    {
        await _mediaGate.WaitAsync(cancellationToken);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, mediaUri);
            request.Headers.Authorization = AuthenticationHeaderValue.Parse(_connection.AuthorizationValue);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromMinutes(2));
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            response.EnsureSuccessStatusCode();
            await using var source = await response.Content.ReadAsStreamAsync(timeout.Token);
            await source.CopyToAsync(destination, 81920, timeout.Token);
        }
        finally { _mediaGate.Release(); }
    }

    public void Dispose()
    {
        _mediaGate.Dispose();
        _http.Dispose();
    }

    private static readonly HashSet<string> AllowedActions = new(StringComparer.Ordinal)
    {
        "clear_provider_cache", "save_provider_settings", "get_provider_capabilities", "get_whatsapp_self_avatar", "get_provider_self_profile",
        "get_reaction_actor_avatar", "get_message_reactions", "wa_get_preview", "wa_get_media", "get_chat_details",
        "get_contact_profile", "send_telegram_comment", "get_telegram_discussion", "get_message_sender_profile", "get_chats_json",
        "get_send_job", "send_message_batch", "get_infrastructure_health", "get_unread_count", "get_chats_meta", "send_message",
        "send_reaction", "retry_vk_request", "get_messages_json", "get_new_messages", "get_whatsapp_status",
        "get_updated_chats", "get_local_messages", "mark_chat_read", "send_message_by_target", "send_message_by_phone",
        "delete_chat_universal", "clear_whatsapp_data", "stream_external_media",
        "telegram_media", "stream_avatar", "max_media", "provider_route",
    };
}
