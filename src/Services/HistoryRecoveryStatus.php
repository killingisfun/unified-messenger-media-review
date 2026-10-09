<?php
declare(strict_types=1);

namespace App\Services;

/** Compact, read-only recovery health for the operator panel and scheduler. */
final class HistoryRecoveryStatus
{
    /** @var list<string> */
    private const SOURCES = ['Telegram', 'WhatsApp', 'VK', 'Avito', 'MAX'];

    public static function install(\PDO $db): void
    {
        $db->exec('CREATE TABLE IF NOT EXISTS history_recovery_sources (
            source TEXT PRIMARY KEY, discovered_at INTEGER NOT NULL DEFAULT 0,
            retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
            last_attempt_at INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT ""
        )');
        $columns = $db->query('PRAGMA table_info(history_recovery_sources)')->fetchAll(\PDO::FETCH_COLUMN, 1);
        foreach ([
            'last_attempt_at' => 'INTEGER NOT NULL DEFAULT 0',
            'last_success_at' => 'INTEGER NOT NULL DEFAULT 0',
            'error' => 'TEXT NOT NULL DEFAULT ""',
        ] as $column => $definition) {
            if (!in_array($column, $columns, true)) $db->exec("ALTER TABLE history_recovery_sources ADD COLUMN {$column} {$definition}");
        }
        $insert = $db->prepare('INSERT OR IGNORE INTO history_recovery_sources(source) VALUES(?)');
        foreach (self::SOURCES as $source) $insert->execute([$source]);
    }

    public static function attempted(\PDO $db, string $source, int $now): void
    {
        self::install($db);
        $db->prepare('UPDATE history_recovery_sources SET last_attempt_at=? WHERE source=?')->execute([$now, $source]);
    }

    public static function succeeded(\PDO $db, string $source, int $now): void
    {
        self::install($db);
        $db->prepare('UPDATE history_recovery_sources SET last_success_at=?,failures=0,retry_at=0,error="" WHERE source=?')->execute([$now, $source]);
    }

    public static function failed(\PDO $db, string $source, int $now, string $reason): void
    {
        self::install($db);
        $row = $db->prepare('SELECT failures FROM history_recovery_sources WHERE source=?');
        $row->execute([$source]);
        $failures = min(10, (int)$row->fetchColumn() + 1);
        $retry = $now + ($reason === 'history_restricted' ? 6 * 3600 : min(900, 30 * (2 ** $failures)));
        $db->prepare('UPDATE history_recovery_sources SET failures=?,retry_at=?,error=? WHERE source=?')
            ->execute([$failures, $retry, $reason, $source]);
    }

    /** @return array<string,array<string,int|string>> */
    public static function snapshot(\PDO $db, ?int $now = null): array
    {
        $now ??= time();
        self::install($db);
        HistoryRecovery::install($db);
        $sourceRows = $db->query('SELECT * FROM history_recovery_sources')->fetchAll(\PDO::FETCH_ASSOC);
        $bySource = [];
        foreach ($sourceRows as $row) $bySource[(string)$row['source']] = $row;
        $counts = $db->query('SELECT c.source,COUNT(*) AS chats,
            SUM(CASE WHEN r.error="history_restricted" THEN 1 ELSE 0 END) AS restricted,
            SUM(CASE WHEN r.error="provider_unavailable" THEN 1 ELSE 0 END) AS unavailable,
            SUM(CASE WHEN r.checked_at>0 THEN 1 ELSE 0 END) AS checked
            FROM chats c LEFT JOIN history_recovery r ON r.chat_db_id=c.id GROUP BY c.source')->fetchAll(\PDO::FETCH_ASSOC);
        $byCount = [];
        foreach ($counts as $row) $byCount[(string)$row['source']] = $row;
        $out = [];
        foreach (self::SOURCES as $source) {
            $row = $bySource[$source] ?? [];
            $count = $byCount[$source] ?? [];
            $chats = (int)($count['chats'] ?? 0);
            $restricted = (int)($count['restricted'] ?? 0);
            $lastSuccess = (int)($row['last_success_at'] ?? 0);
            $age = $lastSuccess > 0 ? max(0, $now - $lastSuccess) : 0;
            $limit = $source === 'Avito' ? 6 * 3600 : ($source === 'VK' ? 2 * 3600 : 20 * 60);
            $error = (string)($row['error'] ?? '');
            $mostlyRestricted = $restricted > 0 && $restricted * 100 >= $chats * 80;
            $state = $chats === 0 ? 'empty'
                : ($mostlyRestricted ? 'restricted'
                : ($error === 'provider_unavailable' && (int)($row['failures'] ?? 0) > 0 ? 'unavailable'
                : ($lastSuccess === 0 || $age > $limit ? 'stale' : 'healthy')));
            $out[strtolower($source)] = [
                'source' => $source, 'state' => $state, 'chats' => $chats,
                'checked' => (int)($count['checked'] ?? 0), 'restricted' => $restricted,
                'last_attempt_at' => (int)($row['last_attempt_at'] ?? 0),
                'last_success_at' => $lastSuccess, 'age_seconds' => $age,
                'error' => $error,
            ];
        }
        return $out;
    }
}
