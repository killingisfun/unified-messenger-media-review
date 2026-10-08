// Этот файл содержит общие вспомогательные функции

/**
 * Форматирует timestamp в строку "день месяц" на русском.
 * @param {number} timestamp - Unix timestamp в секундах.
 * @returns {string}
 */
export function formatDateWithRussianMonth(timestamp) {
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const date = new Date(timestamp * 1000);
    return `${date.getDate()} ${months[date.getMonth()]}`;
}

/**
 * Форматирует timestamp в строку "день месяц год" на русском.
 * @param {number} timestamp - Unix timestamp в секундах.
 * @returns {string}
 */
export function formatDateFullRu(timestamp) {
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    const d = new Date(timestamp * 1000);
    const day = d.getDate();
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
}

/** Формат времени в едином виде для медиа-групп и статусов. */
export function formatHmStockholm(timestamp) {
    const date = new Date(Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp));
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Стабильный цвет для небольших служебных маркеров UI. */
export function mapColor(value) {
    const palette = ['#6f42c1', '#0d6efd', '#198754', '#fd7e14', '#d63384', '#20c997'];
    const text = String(value ?? '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
}


/**
 * Форматирует дату как в WhatsApp для бэйджа между сообщениями:
 * Сегодня / Вчера / d/m/yyyy (без ведущих нулей).
 * @param {number} timestamp - Unix timestamp (sec)
 */
export function formatDateWhatsBadge(timestamp) {
    const d = new Date(timestamp * 1000);
    const now = new Date();
    const makeKey = (dt) => `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;

    const k = makeKey(d);
    const kToday = makeKey(now);
    const y = new Date(now); y.setDate(now.getDate() - 1);
    const kYest = makeKey(y);

    if (k === kToday) return 'Сегодня';
    if (k === kYest) return 'Вчера';

    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}
