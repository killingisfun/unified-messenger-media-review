<?php
declare(strict_types=1);

function document_read_assert(bool $condition, string $message): void {
    if (!$condition) throw new RuntimeException($message);
}

function document_read_function(string $source, string $name): string {
    $start = strpos($source, 'function ' . $name . '(');
    if ($start === false) throw new RuntimeException('Function not found: ' . $name);
    $brace = strpos($source, '{', $start);
    $depth = 0;
    for ($cursor = $brace, $length = strlen($source); $cursor < $length; $cursor++) {
        if ($source[$cursor] === '{') $depth++;
        if ($source[$cursor] === '}' && --$depth === 0) return substr($source, $start, $cursor - $start + 1);
    }
    throw new RuntimeException('Unclosed function: ' . $name);
}

$root = getenv('UNIFIED_TEST_ROOT') ?: dirname(__DIR__);
$rest = (string)file_get_contents($root . '/telegram_service/rest.php');
$client = (string)file_get_contents($root . '/src/Services/TelegramClient.php');
eval(document_read_function($rest, 'tg_document_message_type'));

$jpg = ['mime_type' => 'image/jpeg', 'attributes' => [['_' => 'documentAttributeFilename', 'file_name' => 'photo.jpg']]];
$png = ['mime_type' => 'image/png', 'attributes' => [['_' => 'documentAttributeFilename', 'file_name' => 'photo.png']]];
$video = ['mime_type' => 'video/mp4', 'attributes' => [['_' => 'documentAttributeVideo', 'round_message' => false]]];
$sticker = ['mime_type' => 'image/webp', 'attributes' => [['_' => 'documentAttributeSticker']]];
$animation = ['mime_type' => 'image/gif', 'attributes' => [['_' => 'documentAttributeAnimated']]];

document_read_assert(tg_document_message_type($jpg) === 'document', 'JPG messageMediaDocument stays document');
document_read_assert(tg_document_message_type($png) === 'document', 'PNG messageMediaDocument stays document');
document_read_assert(tg_document_message_type($video) === 'video', 'ordinary video document retains video presentation');
document_read_assert(tg_document_message_type($sticker) === 'sticker', 'documentAttributeSticker retains sticker presentation');
document_read_assert(tg_document_message_type($animation) === 'animation', 'documentAttributeAnimated retains animation presentation');
document_read_assert(substr_count($rest, 'tg_document_message_type($media[\'document\'])') >= 4, 'history, get-by-id and webhook share document classification');
document_read_assert(!str_contains($rest, "str_starts_with(strtolower(\$mime), 'image/')"), 'no read route promotes image documents to photos by MIME');
document_read_assert(str_contains($rest, "'source_type' => \$kind === 'document' ? 'document' : ''"), 'normalized Telegram document retains source_type');
document_read_assert(str_contains($client, "'source_type' => (string)(\$attachment['source_type'] ?? (\$type === 'document' ? 'document' : ''))"), 'PHP adapter preserves source_type from REST');

echo "telegram-document-read-contract-ok\n";
