import { ApiService } from '../core/ApiService.js';
const api = new ApiService();
export async function request(action, args = {}) {
  const result = await api._asyncFetchJson('ai_api.php', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...args }),
  }, 65000);
  if (!result.success) throw new Error(result.message || 'Не удалось выполнить действие');
  return result.data;
}
export function context() {
  const query = new URLSearchParams(location.search);
  return { source: (query.get('source') || '').toLowerCase(), chat_id: query.get('chat_id') || '', db_id: query.get('db_id') || '' };
}
