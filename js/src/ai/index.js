import './listStatus.js?v=20261004-perf-r1';
import { request, context } from './api.js?v=20261004-perf-r1';
import { settingsView, readSettings, knowledgeView, conversationView, decisionsView, e } from './views.js?v=20261004-perf-r1';
import { subscribeAiStatuses } from './statusStore.js?v=20261004-perf-r1';

const dialog = document.createElement('dialog');
dialog.className = 'ai-dialog';
dialog.setAttribute('aria-labelledby','ai-title');
dialog.innerHTML = `<header><div><small>Единое пространство</small><h2 id="ai-title">AI-консультант</h2></div><button data-close aria-label="Закрыть">×</button></header><div class="ai-layout"><nav aria-label="Разделы AI">${[['settings','Настройки'],['conversation','Этот диалог'],['knowledge','Знания'],['decisions','Журнал решений']].map(([id,label])=>`<button data-tab="${id}">${label}</button>`).join('')}</nav><main><p id="ai-notice" role="status" hidden></p><div id="ai-content"></div></main></div>`;
document.body.append(dialog);
const content = dialog.querySelector('#ai-content');
const notice = dialog.querySelector('#ai-notice');
let tab = 'settings', version = 0, busy = false, items = [];
const headerButton = document.createElement('button');
headerButton.className = 'ai-badge';
headerButton.textContent = 'AI';
headerButton.title = 'AI для этого диалога';
headerButton.hidden = !context().db_id;
document.querySelector('.chat-header-actions')?.prepend(headerButton);
const toggleButton=document.createElement('button');
toggleButton.className='ai-badge';
toggleButton.hidden=true;
headerButton.after(toggleButton);
const debugButton=document.createElement('button');debugButton.className='ai-badge';debugButton.textContent='Дебаг AI';debugButton.hidden=true;toggleButton.after(debugButton);
const thinking=document.createElement('div');
thinking.className='ai-thinking';
thinking.setAttribute('role','status');
thinking.setAttribute('aria-live','polite');
thinking.textContent='AI думает…';
thinking.hidden=true;
let thinkingExpiry=null;
let queueStatus=null;
function showThinking(until=0) {
  clearTimeout(thinkingExpiry);
  const remaining=Number(until)*1000-Date.now();
  const area=document.querySelector('.message-area');
  const appeared=thinking.hidden;
  const nearBottom=area && area.scrollHeight-area.scrollTop-area.clientHeight<80;
  if(area && thinking.parentElement!==area)area.append(thinking);
  const queued=queueStatus?.queue_state;
  thinking.textContent=queued==='queued'?'AI: сообщение получено, ожидает обработки…':['blocked','delayed','unknown','failed'].includes(queued)?'AI: обработка требует проверки оператора':'AI думает…';
  thinking.hidden=(remaining<=0 && !queued) || !area;
  if(!thinking.hidden){
    if(remaining>0)thinkingExpiry=setTimeout(()=>showThinking(),Math.min(remaining,60000));
    if(appeared&&nearBottom)area.scrollTop=area.scrollHeight;
  }
}
debugButton.onclick=()=>{if(!confirm('Сбросить служебную память и журнал AI? Агент сохранит доступ ко всей переписке и вложениям. Новый тест начнётся со следующего сообщения.'))return;const ctx=context();perform(async()=>{await request('reset_test',ctx);await updateBadge();if(dialog.open&&tab==='conversation'){content.innerHTML=conversationView(await request('conversation',ctx));message('Тест сброшен. Отправьте новое сообщение с тестового аккаунта.');}});};
let badgeState=null;
const globalButton = document.createElement('button');
globalButton.className = 'rail-btn';
globalButton.textContent = 'AI';
globalButton.title = 'Настройки AI';
globalButton.setAttribute('aria-label','Настройки AI');
document.querySelector('[data-open-connections]')?.after(globalButton);
const mobileButton=globalButton.cloneNode(true);
mobileButton.className='icon-button ai-mobile-open';
document.querySelector('.sidebar-title-actions')?.prepend(mobileButton);

function message(text, error = false) {
  notice.textContent = text; notice.hidden = !text; notice.classList.toggle('is-error',error);
}
async function perform(fn) {
  if (busy) return;
  busy = true;
  const controls = [...content.querySelectorAll('button')];
  controls.forEach(b=>b.disabled=true);
  message('Выполняется…');
  try { await fn(); }
  catch (error) { message(error.message,true); }
  finally { busy=false; controls.forEach(b=>b.disabled=false); }
}
async function load(next = tab) {
  if (busy) return;
  tab = next; const own = ++version;
  message('');
  content.innerHTML='<p class="ai-empty">Загрузка…</p>';
  content.parentElement.scrollTop=0;
  dialog.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.tab===tab)));
  try {
    if (tab==='conversation' && !context().db_id) { content.innerHTML='<p class="ai-empty">Сначала выберите диалог.</p>'; return; }
    const data = await request(tab, tab==='conversation'?context():{});
    if (own!==version || !dialog.open) return;
    if (tab==='settings') content.innerHTML=settingsView(data);
    if (tab==='knowledge') { items=data; content.innerHTML=knowledgeView(data); }
    if (tab==='decisions') content.innerHTML=decisionsView(data);
    if (tab==='conversation') content.innerHTML=conversationView(data);
  } catch(error) { if (own===version) { content.innerHTML='<button data-reload>Повторить загрузку</button>'; message(error.message,true); } }
}
function open(next) { if (!dialog.open) dialog.showModal(); load(next); }
globalButton.onclick=()=>open('settings');
mobileButton.onclick=()=>open('settings');
headerButton.onclick=()=>open('conversation');
const autoAllowed=c=>c.auto_reply==='enabled'||((c.auto_reply||'inherit')==='inherit'&&c.chat_scope==='private');
toggleButton.onclick=async()=>{
  const ctx=context(), snapshot=badgeState;
  if(!snapshot||snapshot.key!==JSON.stringify(ctx))return;
  toggleButton.disabled=true;
  try {
    const c=await request('conversation',ctx);
    const enabling=!autoAllowed(c)||c.state!=='ACTIVE'||c.mode==='manual';
    await request('save_conversation',{...ctx,data:{auto_reply:enabling?'enabled':'disabled',mode:enabling&&c.mode==='manual'?'default':c.mode,instructions:c.instructions,summary:c.summary||''}});
    await updateBadge();
  } catch(error) { if(JSON.stringify(ctx)===JSON.stringify(context())){open('conversation');message(error.message,true);} }
  finally {toggleButton.disabled=false;}
};
dialog.querySelector('[data-close]').onclick=()=>dialog.close();
dialog.addEventListener('close',()=>{ version++; content.innerHTML=''; message(''); });
dialog.addEventListener('change',event=>{
  if (event.target.name==='provider') content.querySelectorAll('[data-custom]').forEach(el=>el.hidden=event.target.value==='openai');
});
dialog.addEventListener('submit',event=>{
  event.preventDefault();
  const form=event.target;
  perform(async()=>{
    if (form.getAttribute('id')==='ai-settings-form') {
      await request('save_settings',{data:readSettings(form)});
      form.elements.api_key.value='';
      message('Настройки сохранены.');
    } else if (form.getAttribute('id')==='ai-conversation-form') {
      await request('save_conversation',{...context(),data:{auto_reply:form.elements.auto_reply.value,mode:form.elements.mode.value,instructions:form.elements.instructions.value,summary:form.elements.summary.value}});
      message('Режим диалога сохранён.'); await updateBadge();
    } else if (form.getAttribute('id')==='ai-knowledge-form') {
      await request('save_knowledge',{data:Object.fromEntries(new FormData(form))});
      items=await request('knowledge'); content.innerHTML=knowledgeView(items); message('Добавлено в знания.');
    }
  });
});
dialog.addEventListener('click',event=>{
  const b=event.target.closest('button'); if (!b) return;
  if (b.dataset.tab) { load(b.dataset.tab); return; }
  if (b.hasAttribute('data-reload')) { load(); return; }
  if (b.dataset.edit) {
    const item=items.find(x=>x.id===b.dataset.edit), form=content.querySelector('form');
    for (const key of ['id','kind','title','content']) form.elements[key].value=item[key];
    form.elements.title.focus(); return;
  }
  if (b.dataset.delete) {
    if (!confirm('Удалить эту запись из базы знаний?')) return;
    perform(async()=>{await request('delete_knowledge',{id:b.dataset.delete}); items=await request('knowledge'); content.innerHTML=knowledgeView(items); message('Запись удалена.');}); return;
  }
  if (b.hasAttribute('data-check')) perform(async()=>{
    const form=content.querySelector('form');
    const previous=form.elements.model.value;
    const data=await request('check',{data:readSettings(form)});
    form.elements.model.innerHTML='<option value="">Выберите модель</option>'+data.models.map(id=>`<option value="${e(id)}">${e(id)}</option>`).join('');
    if(data.models.includes(previous))form.elements.model.value=previous;
    form.elements.api_key.value='';
    form.elements.api_key.placeholder='Ключ сохранён — оставьте пустым, чтобы сохранить';
    const saved=await request('settings');
    form.elements.enabled.checked=saved.enabled;
    message('Подключение сохранено. Список моделей обновлён.');
  });
  if (b.hasAttribute('data-takeover')) perform(async()=>{
    const form=content.querySelector('form');
    await request('save_conversation',{...context(),data:{auto_reply:form.elements.auto_reply.value,mode:'manual',instructions:form.elements.instructions.value,summary:form.elements.summary.value}});
    form.elements.mode.value='manual'; message('Диалог передан менеджеру.'); await updateBadge();
  });
  if (b.hasAttribute('data-training')) perform(async()=>{
    const selected=JSON.stringify(context());
    const data=await request('training',context());
    if(selected!==JSON.stringify(context()))return;
    const target=content.querySelector('#ai-training-result');
    if(!target)return;
    target.replaceChildren();
    for(const item of data.candidates){
      const card=document.createElement('article');card.className='ai-card';
      const title=document.createElement('input');title.value=item.title;title.setAttribute('aria-label','Вопрос');
      const text=document.createElement('textarea');text.value=item.content;text.setAttribute('aria-label','Правильный ответ');
      const add=document.createElement('button');add.textContent='Проверено — добавить в знания';
      add.onclick=()=>perform(async()=>{await request('save_knowledge',{data:{id:'',kind:'faq',title:title.value,content:text.value}});card.remove();message('Проверенный FAQ добавлен.');});
      card.append(title,text,add);target.append(card);
    }
    message(data.candidates.length?'Проверьте предложения перед добавлением.':'В этом разговоре не найдено подходящих FAQ.');
  });
  if (b.hasAttribute('data-draft')) {
    const selected=JSON.stringify(context());
    perform(async()=>{
      const data=await request('draft',context());
      if (selected!==JSON.stringify(context())) return;
      const decision=data.decision;
      const target=content.querySelector('#ai-draft-result');
      if (!target) return;
      target.innerHTML=`<p class="ai-pre">${e(decision.message||decision.manager_note||'Ответ не требуется')}</p>`;
      if (data.status==='ready' && decision.action==='reply') {
        const use=document.createElement('button'); use.textContent='Вставить в поле сообщения';
        use.onclick=()=>{if(selected!==JSON.stringify(context()))return;const input=document.getElementById('message-input');if(input.value.trim()&&!confirm('Заменить текущий черновик?'))return;input.value=decision.message;input.dispatchEvent(new Event('input',{bubbles:true}));dialog.close();input.focus();};
        target.append(use);
      }
      message(data.status==='stale'?'Диалог изменился. Этот ответ нельзя использовать.':'Черновик подготовлен. Клиенту ничего не отправлено.');
    });
  }
});
let badgeVersion=0, badgeContext='', badgeInFlight=0;
async function updateBadge() {
  const own=++badgeVersion, ctx=context(), key=JSON.stringify(ctx);
  badgeInFlight++;
  if(key!==badgeContext){
    badgeContext=key;badgeState=null;showThinking();
    toggleButton.hidden=!ctx.db_id;toggleButton.disabled=true;
    toggleButton.textContent='Включить AI';headerButton.textContent='AI';
  }
  headerButton.hidden=!ctx.db_id;

  debugButton.hidden=ctx.source!=='telegram'||!ctx.db_id;
  if (!ctx.db_id) {badgeInFlight--;showThinking();return;}
  try {
    const [c,s]=await Promise.all([request('conversation',ctx),request('settings')]);
    if(own!==badgeVersion||key!==JSON.stringify(context()))return;
    showThinking(c.thinking_until);
    toggleButton.disabled=false;
    badgeState={key:JSON.stringify(ctx)};
    const allowed=autoAllowed(c);
    toggleButton.hidden=false;
    toggleButton.textContent=allowed&&c.state==='ACTIVE'&&c.mode!=='manual'?'Выключить AI':'Включить AI';
    toggleButton.title='Изменить автоответы только в этом чате';
    const mode=c.mode==='default'?s.channels[ctx.source]?.mode:c.mode;
    headerButton.textContent=!allowed?'AI: выключен':c.state==='MANUAL_REQUIRED'?'Нужен менеджер':c.state==='MANUAL'||mode==='manual'?'AI: менеджер':c.state==='FIRST_REPLIED'?'AI: первый ответ дан':!s.enabled||!s.channels[ctx.source]?.enabled?'AI: выключен':mode==='first_reply'?'AI: первый ответ':'AI: авто';
    headerButton.dataset.state=c.state==='MANUAL_REQUIRED'?'handoff':allowed&&s.enabled&&s.channels[ctx.source]?.enabled&&c.state==='ACTIVE'&&mode!=='manual'?'active':'manual';
  } catch { if(own===badgeVersion){showThinking();headerButton.textContent='AI: недоступен';headerButton.dataset.state='manual';} }
  finally {badgeInFlight--;}
}
subscribeAiStatuses(detail=>{queueStatus=detail.chats?.[context().db_id]||null;if(queueStatus)showThinking(queueStatus.thinking_until);if(detail.stale&&context().db_id){headerButton.textContent='AI: статус не обновлён';headerButton.dataset.state='manual';}});
let badgeRefreshTimer=null;
function scheduleBadgeRefresh(delay=3500) {
  if(badgeRefreshTimer!==null)clearTimeout(badgeRefreshTimer);
  badgeRefreshTimer=setTimeout(()=>{badgeRefreshTimer=null;void updateBadge();},delay);
}
document.addEventListener('chat:opened',()=>{queueStatus=null;showThinking();scheduleBadgeRefresh();if(dialog.open&&tab==='conversation')load();});
document.addEventListener('chat:reset',()=>{queueStatus=null;badgeVersion++;headerButton.hidden=true;toggleButton.hidden=true;debugButton.hidden=true;showThinking();badgeState=null;badgeContext='';});
if(context().db_id)scheduleBadgeRefresh(4500);

setInterval(()=>{if(!document.hidden&&context().db_id&&!busy&&!badgeInFlight)updateBadge();},15000);
