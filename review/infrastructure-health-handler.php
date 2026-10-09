<?php
declare(strict_types=1);

/*
 * Exact extracted body of index.php?action=get_infrastructure_health.
 * The production dispatcher, bootstrap and database configuration are omitted
 * from this review snapshot. `$pdo` is the already-open production PDO handle.
 */
header('Content-Type: application/json');
$healthFile = __DIR__ . '/../runtime/health/infrastructure.json';
$healthRaw = is_file($healthFile) ? file_get_contents($healthFile) : false;
$health = is_string($healthRaw) ? json_decode($healthRaw, true) : null;
$state = is_array($health) ? strtolower((string)($health['state'] ?? 'unknown')) : 'unknown';
$updatedAt = is_array($health) ? (int)($health['updated_at'] ?? 0) : 0;
$staleAfterSeconds = 16 * 60;
$healthAge = $updatedAt > 0 ? time() - $updatedAt : PHP_INT_MAX;
if ($updatedAt <= 0 || $healthAge > $staleAfterSeconds || $healthAge < -120) {
    $state = 'stale';
} elseif (!in_array($state, ['healthy', 'critical'], true)) {
    $state = 'stale';
}
$message = is_array($health) ? trim((string)($health['message'] ?? '')) : '';
$historyRecovery = \App\Services\HistoryRecoveryStatus::snapshot($pdo);
$unavailableProviders = [];
foreach ($historyRecovery as $provider) {
    if (!is_array($provider)) continue;
    $providerState = (string)($provider['state'] ?? '');
    if (in_array($providerState, ['unavailable', 'stale'], true)) {
        $unavailableProviders[] = (string)($provider['source'] ?? 'провайдер');
    }
}
if ($state === 'stale') {
    $message = 'Результат проверки сервера устарел. Нужна повторная проверка.';
} elseif ($state === 'healthy' && $unavailableProviders !== []) {
    $state = 'critical';
    $message = 'Не подтверждена работа провайдеров: ' . implode(', ', $unavailableProviders) . '.';
} elseif ($message === '') {
    $message = 'Состояние инфраструктуры обновлено.';
}
echo json_encode([
    'success' => true,
    'state' => $state,
    'updated_at' => $updatedAt,
    'message' => mb_substr($message, 0, 240),
    'history_recovery' => $historyRecovery,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
