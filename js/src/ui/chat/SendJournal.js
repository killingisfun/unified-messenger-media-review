

/** Durable request outcomes, account scoping and recovery after reload. */
export class SendJournal {
  constructor(chat) { this.chat = chat; }

  _outgoingOperationStoreKey() {
    return 'unified-outgoing-operations-v2';
  }

  _operationAccountKeyFromConfig() {
    const source = String(this.chat.source || '').trim().toLowerCase();
    const config = globalThis.APP_CONFIG || {};
    const configured = String(config.providerAccountId || config.accountId || config.account_id || '').trim();
    return configured ? `${source}:${configured}` : `${source}:unbound`;
  }

  _legacyOutgoingOperationStoreKey() {
    return 'unified-outgoing-operations-v1';
  }

  _normalizeOperationComponents(value, files = [], result = null, componentIndex = null, compositionKnown = true) {
    const existing = Array.isArray(value) ? value : [];
    const resultIds = [result?.message_id, ...(Array.isArray(result?.message_ids) ? result.message_ids : [])]
      .map(item => String(item || '').trim()).filter(Boolean);
    let components = existing.map((item, index) => ({
      key: String(item?.key || `file:${item?.index ?? index}`), index: Number(item?.index ?? index),
      kind: String(item?.kind || 'file'), status: String(item?.status || 'unknown'),
      messageId: String(item?.messageId ?? item?.message_id ?? '').trim(),
      name: String(item?.name || ''), size: Math.max(0, Number(item?.size || 0) || 0),
    }));
    if (!components.length && Array.isArray(files) && files.length) {
      components = files.map((file, index) => ({ key: `file:${index}`, index, kind: 'file', status: 'pending', messageId: '', name: String(file?.name || ''), size: Math.max(0, Number(file?.size || 0) || 0) }));
    }
    if (!components.length && compositionKnown) {
      components = [{ key: 'text:0', index: 0, kind: 'text', status: 'pending', messageId: '', name: '', size: 0 }];
    }
    const attachmentRows = Array.isArray(result?.attachments) ? result.attachments : [];
    for (const attachment of attachmentRows) {
      const index = Number(attachment?.index);
      if (!Number.isInteger(index) || index < 0 || !components[index]) continue;
      const messageId = String(attachment?.message_id ?? attachment?.messageId ?? '').trim();
      const status = String(attachment?.status || '').toLowerCase();
      const inferred = attachment?.success === true && messageId ? 'accepted'
        : attachment?.success === false ? (['rejected', 'failed'].includes(String(attachment?.outcome || '').toLowerCase()) ? 'rejected' : 'unknown')
          : components[index].status;
      const explicitStatus = ['accepted', 'rejected', 'unknown'].includes(status);
      // An indexed attachment is stronger evidence than the aggregate
      // message_ids list. An explicit unknown must not inherit another
      // file's native ID.
      components[index] = {
        ...components[index],
        messageId: messageId || (explicitStatus ? '' : components[index].messageId),
        status: explicitStatus ? status : inferred,
      };
    }
    // A native message can prove at most one original input. Repair old
    // duplicate journal entries conservatively: keep the first and make every
    // later duplicate unknown until it has its own evidence.
    const usedMessageIds = new Set();
    components = components.map(component => {
      const messageId = String(component.messageId || '').trim();
      if (!messageId || !usedMessageIds.has(messageId)) {
        if (messageId) usedMessageIds.add(messageId);
        return component;
      }
      return { ...component, messageId: '', status: 'unknown' };
    });
    const target = Number.isInteger(componentIndex) && componentIndex >= 0 ? componentIndex
      : (components.length === 1 ? 0 : null);
    if (target !== null && components[target]) {
      const messageId = resultIds[0] || components[target].messageId;
      // The whole request becomes unknown once an earlier item was accepted,
      // but the current item can still have a confirmed provider rejection.
      // Keep these two facts separate: only the latter is safe to offer for
      // a manual retry.
      const explicit = String(result?.component_outcome || result?.outcome || '').toLowerCase();
      const status = result?.success === true && messageId ? 'accepted'
        : ['rejected', 'failed'].includes(explicit) ? 'rejected'
          : result ? 'unknown' : components[target].status;
      components[target] = { ...components[target], messageId, status };
    } else if (resultIds.length) {
      let cursor = 0;
      components = components.map(component => {
        if (component.messageId || component.status !== 'pending') return component;
        while (cursor < resultIds.length && usedMessageIds.has(resultIds[cursor])) cursor++;
        if (cursor >= resultIds.length) return component;
        const messageId = resultIds[cursor++];
        usedMessageIds.add(messageId);
        return { ...component, messageId, status: 'accepted' };
      });
    }
    return components;
  }

  _operationStatusFromComponents(requestedStatus, components = []) {
    const requested = String(requestedStatus || '').toLowerCase();
    // Queue lifecycle states describe the browser request before any provider
    // result is known. Do not turn them into a delivery result prematurely.
    if (['queued', 'started', 'pending', 'abandoned', 'resolved', 'resolved_partial'].includes(requested)) return requested;
    const statuses = (Array.isArray(components) ? components : []).map(item => String(item?.status || 'unknown').toLowerCase());
    if (!statuses.length || statuses.some(status => status === 'pending' || status === 'unknown')) return 'unknown';
    if (statuses.every(status => status === 'accepted')) return 'accepted';
    if (statuses.every(status => status === 'rejected')) return 'rejected';
    return 'partial_failed';
  }

  _rejectedSendFileStore() {
    return globalThis.__unifiedRejectedSendFiles ??= new Map();
  }

  _rememberRejectedSendFiles(requestId, files, components = []) {
    const id = String(requestId || '').trim();
    if (!id || !Array.isArray(files)) return;
    const rejected = new Set((Array.isArray(components) ? components : [])
      .filter(item => String(item?.kind || '') === 'file' && String(item?.status || '') === 'rejected')
      .map(item => Number(item.index)).filter(Number.isInteger));
    if (!rejected.size) return;
    const selected = files.filter((_, index) => rejected.has(index));
    if (selected.length) this.chat._rejectedSendFileStore().set(id, selected);
  }

  _findOutgoingOperation(requestId) {
    const id = String(requestId || '').trim();
    return id ? this.chat._readOutgoingOperations().find(item => String(item?.requestId || '') === id) || null : null;
  }

  _renderSendOperationOutcome(element, requestId, error = null) {
    if (!element?.isConnected) return;
    const operation = this.chat._findOutgoingOperation(requestId);
    const components = Array.isArray(operation?.components) ? operation.components : [];
    const exceptional = components.filter(item => ['rejected', 'unknown'].includes(String(item?.status || '').toLowerCase()));
    if (!exceptional.length) return;
    let progress = element.querySelector('.send-progress');
    if (!progress) {
      progress = document.createElement('div');
      progress.className = 'send-progress';
      const meta = element.querySelector('.meta');
      if (meta) meta.parentNode.insertBefore(progress, meta);
      else element.querySelector('.bubble')?.appendChild(progress);
    }
    progress.replaceChildren();
    const accepted = components.filter(item => item.status === 'accepted').length;
    const rejected = components.filter(item => item.status === 'rejected');
    const unknown = components.filter(item => item.status === 'unknown' || item.status === 'pending');
    const title = document.createElement('strong');
    title.className = 'send-operation-outcome__title';
    title.textContent = accepted ? 'Пачка отправлена частично' : (unknown.length ? 'Результат отправки не подтверждён' : 'Пачка не отправлена');
    progress.appendChild(title);
    const summary = document.createElement('span');
    summary.className = 'send-operation-outcome__summary';
    summary.textContent = accepted
      ? `Принято сервисом: ${accepted}; не отправлено: ${rejected.length}; требуется сверка: ${unknown.length}.`
      : `Не отправлено: ${rejected.length}; требуется сверка: ${unknown.length}.`;
    progress.appendChild(summary);
    const list = document.createElement('ul');
    list.className = 'send-operation-outcome__items';
    const labels = { accepted: 'принято сервисом', rejected: 'не отправлено', unknown: 'результат неизвестен', pending: 'результат неизвестен' };
    components.forEach((component, index) => {
      const status = String(component?.status || 'unknown').toLowerCase();
      const item = document.createElement('li');
      item.className = `is-${status}`;
      const name = String(component?.name || (component?.kind === 'text' ? 'Текст сообщения' : `Файл ${index + 1}`));
      item.textContent = `${name} — ${labels[status] || 'результат неизвестен'}`;
      list.appendChild(item);
    });
    progress.appendChild(list);
    if (rejected.length) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'send-operation-outcome__retry';
      retry.dataset.prepareRejectedRetry = String(requestId || '');
      retry.textContent = rejected.some(item => item.kind === 'file')
        ? 'Подготовить повторную отправку отклонённых файлов'
        : 'Подготовить повторную отправку текста';
      progress.appendChild(retry);
    }
  }

  _readOutgoingOperations() {
    const parse = (key) => {
      try {
        const stored = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(stored) ? stored.filter(item => item && typeof item === 'object') : [];
      } catch { return []; }
    };
    const current = parse(this.chat._outgoingOperationStoreKey());
    const legacy = parse(this.chat._legacyOutgoingOperationStoreKey());
    if (!legacy.length) return current;
    const existing = new Set(current.map(item => String(item.requestId || '')));
    const migrated = legacy.filter(item => item?.requestId && !existing.has(String(item.requestId))).map(item => ({
      ...item,
      accountKey: String(item.accountKey || `${String(item.source || '').toLowerCase()}:unbound`),
      // v1 did not record every component, so its known ids are evidence,
      // not proof of a complete provider operation.
      components: this.chat._normalizeOperationComponents(
        (Array.isArray(item.messageIds) ? item.messageIds : []).map((messageId, index) => ({ key: `legacy:${index}`, index, status: 'unknown', messageId })),
        [], null, null, false
      ),
      compositionKnown: false,
      migratedFrom: 'v1',
    }));
    const records = [...current, ...migrated];
    this.chat._writeOutgoingOperations(records);
    return records;
  }

  _writeOutgoingOperations(records) {
    try { localStorage.setItem(this.chat._outgoingOperationStoreKey(), JSON.stringify(records.slice(-100))); } catch {}
  }

  _migrateOutgoingOperationAccountKey(previousKey, nextKey) {
    // Compatibility hook for old bundles. Browser state alone can never
    // prove two stable provider account IDs refer to one account.
    void previousKey;
    void nextKey;
  }

  _rememberOutgoingOperation({ requestId, status = 'queued', element = null, text = '', files = [], result = null, reconciliation = null, componentIndex = null, jobId = '' } = {}) {
    const id = String(requestId || element?.dataset?.sendRequestId || '').trim();
    if (!id) return;
    const now = Date.now();
    const allRecords = this.chat._readOutgoingOperations();
    const previous = allRecords.find(item => item.requestId === id) || null;
    const records = allRecords.filter(item => Number(item.updatedAt || 0) > now - 7 * 24 * 60 * 60 * 1000 && item.requestId !== id);
    const resultComponentIndex = Number.isInteger(result?.component_index) ? result.component_index : null;
    const normalizedComponentIndex = Number.isInteger(componentIndex) ? componentIndex : resultComponentIndex;
    const components = this.chat._normalizeOperationComponents(previous?.components, files, result, normalizedComponentIndex, previous?.compositionKnown !== false);
    const resultIds = [result?.message_id, ...(Array.isArray(result?.message_ids) ? result.message_ids : []), ...components.map(item => item.messageId)]
      .map(value => String(value || '').trim()).filter(Boolean);
    const normalizedStatus = this.chat._operationStatusFromComponents(status, components);
    records.push({
      requestId: id, status: normalizedStatus, source: String(this.chat.source || ''), chatId: String(this.chat.chatId || ''), chatDbId: String(this.chat.chatDbId || ''),
      accountKey: String(previous?.accountKey || this.chat._outgoingAccountKey || this.chat._operationAccountKeyFromConfig()),
      optimisticId: String(element?.dataset?.id || element?._originalData?.id || previous?.optimisticId || ''), text: String(text || element?._originalData?.text || previous?.text || ''),
      messageIds: [...new Set([...(previous?.messageIds || []), ...resultIds])],
      components, compositionKnown: previous?.compositionKnown !== false,
      attachments: Array.isArray(result?.attachments) ? result.attachments : (previous?.attachments || []),
      jobId: String(jobId || result?.job_id || result?.jobId || previous?.jobId || '').trim(),
      reconciliation: reconciliation || previous?.reconciliation || null,
      createdAt: Number(previous?.createdAt || now), updatedAt: now,
    });
    this.chat._writeOutgoingOperations(records);
  }

  _rememberAcceptedSendEvidence(element, result, requestId = '', status = 'accepted', componentIndex = null) {
    if (!result || typeof result !== 'object') return;
    const ids = [result.message_id, ...(Array.isArray(result.message_ids) ? result.message_ids : [])]
      .map(value => String(value || '').trim()).filter(Boolean);
    if (element?.dataset && ids.length) element.dataset.acceptedMessageIds = [...new Set(ids)].join(',');
    if (element) element._sendResult = { ...result, message_ids: ids };
    this.chat._rememberOutgoingOperation({ requestId, status, element, result, componentIndex });
  }

  _operationMatchesCurrentChat(item) {
    const source = String(this.chat.source || '');
    const chatId = String(this.chat.chatId || '');
    const accountKey = String(this.chat._outgoingAccountKey || this.chat._operationAccountKeyFromConfig());
    const storedKey = String(item?.accountKey || `${source.toLowerCase()}:unbound`);
    // Without a stable provider account id there is no proof that a restored
    // entry belongs to the currently connected account. Keep it visible in
    // the journal, but never use history to auto-confirm it.
    if (storedKey.endsWith(':unbound') || accountKey.endsWith(':unbound')) return false;
    return item?.source === source && item?.chatId === chatId && storedKey === accountKey;
  }

  _reconcileOutgoingOperations(messages = []) {
    const seen = this.chat._nativeIdsFromMessages(messages);
    if (!seen.size) return;
    const now = Date.now();
    let changed = false;
    const records = this.chat._readOutgoingOperations().map(item => {
      if (!this.chat._operationMatchesCurrentChat(item) || !['started', 'pending', 'unknown', 'accepted', 'partial_failed', 'resolved_partial'].includes(String(item.status || ''))) return item;
      const components = this.chat._normalizeOperationComponents(item.components, [], null, null, item.compositionKnown !== false);
      const oldMatched = new Set(Array.isArray(item?.reconciliation?.matchedMessageIds) ? item.reconciliation.matchedMessageIds.map(String) : []);
      const nextComponents = components.map(component => {
        const id = String(component.messageId || '').trim();
        if (id && seen.has(id)) oldMatched.add(id);
        return component;
      });
      // Old migrated records do not describe all elements. Their IDs are
      // useful evidence but never prove that the complete request finished.
      const compositionKnown = item.compositionKnown !== false;
      const expected = nextComponents.map(component => String(component.messageId || '').trim()).filter(Boolean);
      const matched = [...oldMatched].filter(id => expected.includes(id));
      if (!matched.length) return item;
      const unresolved = nextComponents.filter(component => {
        const id = String(component.messageId || '').trim();
        return component.status !== 'rejected' && (!id || !oldMatched.has(id));
      });
      const rejected = nextComponents.some(component => component.status === 'rejected');
      const complete = compositionKnown && !rejected && unresolved.length === 0 && nextComponents.length > 0;
      changed = true;
      return {
        ...item,
        components: nextComponents,
        status: complete ? 'resolved' : 'resolved_partial',
        reconciliation: {
          state: complete ? 'confirmed' : 'partially_confirmed',
          expectedMessageIds: expected,
          matchedMessageIds: matched,
          unresolvedComponents: unresolved.map(component => ({ key: component.key, index: component.index, kind: component.kind, status: component.status })),
          checkedAt: now,
          note: complete ? 'Сверено с историей по native ID.' : 'Сверена только часть отправленных элементов; общий результат остаётся неопределённым.',
        },
        updatedAt: now,
      };
    });
    if (changed) this.chat._writeOutgoingOperations(records);
  }

  _resumeUnknownOutgoingOperations() {
    const now = Date.now();
    const records = this.chat._readOutgoingOperations();
    let changed = false;
    const operations = records.map(item => {
      if (!this.chat._operationMatchesCurrentChat(item) || Number(item.updatedAt || 0) <= now - 7 * 24 * 60 * 60 * 1000) return item;
      // Old records called an in-flight request `pending`. New writes use
      // `queued` until it enters _deliverOutgoingMessage, then `started`.
      // A page reload cannot know whether legacy pending reached a provider,
      // so it must be treated as unknown and never retried automatically.
      if (item.status === 'pending') {
        changed = true;
        return { ...item, status: 'unknown', reconciliation: { state: 'unknown', checkedAt: now, note: 'Страница была закрыта во время старой незавершённой операции.' }, updatedAt: now };
      }
      if (item.status === 'queued') {
        changed = true;
        return { ...item, status: 'abandoned', reconciliation: { state: 'not_started', checkedAt: now, note: 'Страница была закрыта до начала запроса; сообщение не отправлялось автоматически.' }, updatedAt: now };
      }
      return item;
    });
    if (changed) this.chat._writeOutgoingOperations(operations);
    const active = operations.filter(item => this.chat._operationMatchesCurrentChat(item)
      && ['started', 'unknown', 'accepted', 'resolved_partial'].includes(String(item.status || ''))
      && Number(item.updatedAt || 0) > now - 7 * 24 * 60 * 60 * 1000);
    if (!active.length) return;
    this.chat._showFeatureNotice('Проверяем результат предыдущей отправки. Повторно ничего не отправляем.');
    [0, 2000, 10000, 30000].forEach(delay => this.chat.lifetime.timeout(() => {
      if (!this.chat._isActiveInstance()) return;
      active.forEach(operation => {
        if (operation.jobId) this.chat._refreshOutgoingSendJob(operation).catch(() => {});
      });
      this.chat.fetchNewMessages().catch(() => {});
    }, delay));
  }
}
