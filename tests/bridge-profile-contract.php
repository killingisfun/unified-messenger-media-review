<?php
declare(strict_types=1);

function bridge_profile_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$router = file_get_contents(__DIR__ . '/../live-readonly-router.php');
bridge_profile_assert(is_string($router), 'bridge router is readable');
bridge_profile_assert(str_contains($router, "'get_provider_self_profile'"), 'bridge permits the fixed own-profile action');
bridge_profile_assert(str_contains($router, "if (\$action === 'get_provider_self_profile')"), 'bridge serves own profile through an explicit route');
bridge_profile_assert(str_contains($router, 'live_normalize_own_profile'), 'own profile is normalized before reaching browser');
bridge_profile_assert(str_contains($router, "['whatsapp', 'telegram']"), 'bridge permits the implemented Telegram own profile path');
bridge_profile_assert(str_contains($router, '?? live_chat_avatar_target($rawAvatar)'), 'Telegram cached own avatar becomes an opaque bridge relay');
bridge_profile_assert(str_contains($router, 'function live_provider_account_id'), 'bridge scopes Telegram avatar references to the current account');
bridge_profile_assert(str_contains($router, "'message_id' => 'contact-avatar'"), 'contact avatar receives an opaque relay reference');
bridge_profile_assert(str_contains($router, "'message_id' => 'profile-avatar'"), 'own avatar receives an opaque relay reference');
bridge_profile_assert(!str_contains($router, "'avatar' => \$rawAvatar"), 'raw provider avatar is never returned directly');
bridge_profile_assert(str_contains($router, "['whatsapp', 'vk', 'telegram', 'max']"), 'bridge explicitly allows the supported contact-profile providers');
bridge_profile_assert(str_contains($router, 'function live_fetch_contact_profile'), 'bridge uses one provider-neutral profile fetcher');
bridge_profile_assert(!str_contains($router, "strcasecmp(\$source, 'WhatsApp') !== 0 || \$chatId === '' || \$dbId < 1"), 'VK and Telegram are not rejected by a WhatsApp-only fetch guard');
bridge_profile_assert(str_contains($router, "\$provider === 'whatsapp'"), 'only WhatsApp defers the first lookup to avoid its interactive queue');
echo "bridge-profile-contract-ok\n";
