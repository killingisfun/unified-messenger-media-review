import { escapeHtml as e } from '../ui/components/ChatListItem.js';
export { e };
export const sources = { telegram:'Telegram', whatsapp:'WhatsApp', vk:'VK', avito:'Avito', max:'MAX' };
const reasons = { SEND_UNKNOWN:'Неизвестен результат отправки', SEND_REJECTED:'Отправка отклонена', TOOL_ERROR:'Ошибка AI-провайдера', UNKNOWN:'Недостаточно информации', CUSTOMER_REQUESTED_HUMAN:'Клиент просит человека', COMPLAINT:'Жалоба', REFUND:'Возврат', PAYMENT_PROBLEM:'Проблема с оплатой', LEGAL_QUESTION:'Юридический вопрос', ORDER_CHANGE:'Изменение заказа' };
export function settingsView(s) {
  return `<form id="ai-settings-form"><section class="ai-card">
    <div class="ai-section-title"><div><h3>AI-консультант</h3><p>Отвечает по вашим правилам и передаёт сложные вопросы менеджеру.</p></div>
    <label class="ai-toggle"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> Включён</label></div>
    <div class="ai-fields"><label>Провайдер<select name="provider"><option value="openai" ${s.provider==='openai'?'selected':''}>OpenAI</option><option value="compatible" ${s.provider==='compatible'?'selected':''}>Совместимый сервер</option></select></label>
    <label>API-ключ<input name="api_key" type="password" autocomplete="new-password" placeholder="${s.key_configured?'Ключ сохранён — оставьте пустым, чтобы сохранить':'Введите API-ключ'}"></label>
    <label data-custom ${s.provider==='openai'?'hidden':''}>Base URL<input name="base_url" type="url" value="${e(s.base_url)}"></label>
    <label data-custom ${s.provider==='openai'?'hidden':''}>Режим API<select name="api_mode">${[['auto','Автоматически'],['responses','Responses API'],['chat','Chat Completions']].map(([v,t])=>`<option value="${v}" ${v===s.api_mode?'selected':''}>${t}</option>`).join('')}</select></label>
    <label>Модель<select name="model"><option value="">Сначала проверьте подключение</option>${[...new Set([s.model,...(s.models||[])])].filter(Boolean).map(id=>`<option value="${e(id)}" ${id===s.model?'selected':''}>${e(id)}</option>`).join('')}</select><small>Список получен от подключённого API. Доступ в Codex Free не включает бесплатные API-вызовы.</small></label>
    <label>Сообщений в контексте<input name="context_limit" type="number" min="1" max="40" value="${s.context_limit}"></label></div>
    <button type="button" data-check>Сохранить подключение и загрузить модели</button></section>
    <section class="ai-card"><h3>Поведение и стиль</h3><label>Инструкции AI<textarea name="instructions" rows="6" maxlength="16000" placeholder="Как обращаться к клиентам, что предлагать и когда звать менеджера…">${e(s.instructions)}</textarea></label>
    <label class="ai-toggle"><input type="checkbox" name="manager_pauses" ${s.manager_pauses?'checked':''}> При ответе менеджера ставить AI на паузу</label></section>
    <section class="ai-card"><h3>Каналы</h3><p>Общие настройки действуют только в личных чатах. В группах и каналах AI выключен, пока вы отдельно не включите его в шапке чата.</p>${Object.entries(sources).map(([id,name])=>`<div class="ai-channel"><label class="ai-toggle"><input name="channel_${id}" type="checkbox" ${s.channels[id]?.enabled?'checked':''}>${name}</label><select name="mode_${id}" aria-label="Режим ${name}"><option value="first_reply">Только первый ответ</option><option value="continuous" ${s.channels[id]?.mode==='continuous'?'selected':''}>Вести разговор</option></select></div>`).join('')}</section>
    <section class="ai-card"><h3>Передача менеджеру</h3><div class="ai-fields">${Object.entries(reasons).map(([id,name])=>`<label class="ai-toggle"><input name="handoff" value="${id}" type="checkbox" ${s.handoff.includes(id)?'checked':''}>${name}</label>`).join('')}</div><p>Остатки, цены, заказы и CRM пока не подключены. AI передаст такие запросы человеку.</p></section>
    <div class="ai-actions"><button class="ai-primary" type="submit">Сохранить настройки</button></div></form>`;
}
export function readSettings(form) {
  const f = new FormData(form);
  return { enabled:f.has('enabled'), provider:f.get('provider'), base_url:f.get('base_url'), api_mode:f.get('api_mode'),
    api_key:f.get('api_key'), model:f.get('model'), instructions:f.get('instructions'), context_limit:Number(f.get('context_limit')),
    manager_pauses:f.has('manager_pauses'), handoff:f.getAll('handoff'),
    channels:Object.fromEntries(Object.keys(sources).map(id=>[id,{enabled:f.has('channel_'+id),mode:f.get('mode_'+id)}])) };
}
export function knowledgeView(items) {
  return `<section class="ai-card"><h3>Знания для ответов</h3><p>Добавляйте проверенные сведения, FAQ и примеры хороших ответов. История не становится знаниями без вашего подтверждения.</p>
    <form id="ai-knowledge-form"><input name="id" type="hidden"><div class="ai-fields"><label>Тип<select name="kind"><option value="text">Информация</option><option value="faq">Вопрос и ответ</option><option value="example">Пример диалога</option><option value="style">Стиль общения</option></select></label><label>Название / вопрос<input name="title" required maxlength="200"></label></div>
    <label>Текст / правильный ответ<textarea name="content" required rows="5" maxlength="12000"></textarea></label><div class="ai-actions"><button class="ai-primary">Добавить в знания</button><button type="reset">Очистить форму</button></div></form></section>
    <div class="ai-knowledge-list">${items.length?items.map(x=>`<article class="ai-card"><h3>${e(x.title)}</h3><p class="ai-pre">${e(x.content)}</p><div class="ai-actions"><button data-edit="${e(x.id)}">Редактировать</button><button data-delete="${e(x.id)}">Удалить</button></div></article>`).join(''):'<p class="ai-empty">Пока нет записей. Начните с условий доставки или частых вопросов.</p>'}</div>`;
}
export function decisionsView(items) {
  return items.length ? items.map(x=>`<article class="ai-card"><div class="ai-section-title"><strong>${{reply:'Ответ',handoff:'Передача менеджеру',ignore:'Без ответа'}[x.decision?.action]||'Решение'}</strong><small>${e(new Date(x.created*1000).toLocaleString('ru-RU'))}</small></div>
    <p class="ai-pre">${e(x.decision?.message||x.decision?.manager_note||'Без текста')}</p>
    ${x.outcome==='unknown'||x.outcome==='rejected'?`<p class="ai-dispatch-warning">${x.outcome==='unknown'?'Результат отправки неизвестен. AI остановлен, чтобы не отправить дубль. Проверьте переписку в мессенджере.':'Провайдер отклонил отправку. Нужна проверка менеджера.'}</p>`:''}
    ${x.decision?.manager_note&&x.decision.manager_note!==x.decision.message?`<p><strong>Причина:</strong> ${e(x.decision.manager_note)}</p>`:''}
    <small>${x.preview?'Черновик · ':''}${x.stale?'Отменено: состояние диалога изменилось · ':''}${e(x.model)} · ${x.latency_ms} мс</small>
    ${x.decision?.handoff_reason?`<p>${e(reasons[x.decision.handoff_reason]||x.decision.handoff_reason)}</p>`:''}
    <details><summary>Использованные данные</summary><p>Сообщений: ${x.message_ids?.length||0} · Изображений: ${x.vision_image_count||0} · Из истории: ${x.history_message_ids?.length||0} · Записей знаний: ${x.knowledge_ids?.length||0}</p><pre>${e(JSON.stringify(x.usage||{},null,2))}</pre></details></article>`).join('') : '<p class="ai-empty">Решений пока нет. Здесь появятся ответы, причины передачи менеджеру и использованные данные.</p>';
}
export function conversationView(c) {
  return `<section class="ai-card"><h3>Управление диалогом</h3><p>${e((c.auto_reply==='disabled'||((c.auto_reply||'inherit')==='inherit'&&c.chat_scope!=='private'))?'Автоответы выключены в этом чате':{ACTIVE:'AI готов к работе по настройкам канала',MANUAL:'Диалог ведёт менеджер',MANUAL_REQUIRED:'Нужен менеджер',FIRST_REPLIED:'Первый ответ дан. Дальше отвечает менеджер',PAUSED:'AI на паузе'}[c.state]||c.state)}</p>
    ${c.state==='MANUAL_REQUIRED'?`<p class="ai-dispatch-warning"><strong>${e(reasons[c.handoff_reason]||'Нужен менеджер')}</strong><br>${e(c.manager_note||'Подробности — в последних решениях ниже.')}</p>`:''}<form id="ai-conversation-form"><label>Автоответы в этом чате<select name="auto_reply">${[['inherit',c.chat_scope==='private'?'По общим настройкам':'Выключены по умолчанию'],['enabled','Включены для этого чата'],['disabled','Выключены для этого чата']].map(([v,t])=>`<option value="${v}" ${(c.auto_reply||'inherit')===v?'selected':''}>${t}</option>`).join('')}</select></label><p>Общий выключатель AI и доступность провайдера действуют всегда. Черновики не отправляются автоматически.</p><label>Режим<select name="mode">${[['default','Общие настройки'],['continuous','Вести разговор'],['first_reply','Ответить только на следующее сообщение'],['manual','Менеджер — остановить AI']].map(([v,t])=>`<option value="${v}" ${c.mode===v?'selected':''}>${t}</option>`).join('')}</select></label>
    <label>Инструкции для этого клиента<textarea name="instructions" rows="4" maxlength="8000">${e(c.instructions)}</textarea></label><label>Краткая память разговора<textarea name="summary" rows="4" maxlength="4000">${e(c.summary||'')}</textarea></label><div class="ai-actions"><button class="ai-primary">Сохранить</button><button type="button" data-takeover>Забрать диалог</button></div></form></section>
    <section class="ai-card"><h3>Помощь менеджеру</h3><p>Подготовить ответ по последним сообщениям. Черновик не отправляется клиенту.</p><button data-draft>Подготовить ответ</button><div id="ai-draft-result"></div></section>
    <section class="ai-card"><h3>Учиться на этом разговоре</h3><p>AI предложит FAQ по последним 30 сообщениям. В знания попадёт только то, что вы проверите и добавите.</p><button data-training>Предложить FAQ</button><div id="ai-training-result"></div></section><h3>Последние решения</h3>${decisionsView(c.decisions||[])}`;
}
