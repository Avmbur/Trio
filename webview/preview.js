/* Local UI prototype. This file never connects to a model or extension host. */
(function () {
  'use strict';
  const M = window.TrioPreview;
  const $ = id => document.getElementById(id);
  const storageKey = 'trio.interface-preview.v1';
  let state = load();
  let timer = null;
  let ownedReply = null;
  let settingsAgent = null;
  let composing = false;
  let follow = true;
  let lastRecipientOptions = '';
  let lastAgents = '';
  const initials = { human: 'А', claude: 'К', codex: 'Ж', grok: 'Г' };

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(storageKey));
      if (s?.version === 1 && Array.isArray(s.messages) && Array.isArray(s.agents)
        && s.agents.length === 3 && s.agents.some(a => a.enabled)
        && s.agents.every(a => ['claude', 'codex', 'grok'].includes(a.id))
        && typeof s.draft === 'string') return s;
    } catch { /* Storage can be disabled in a local browser window. */ }
    return M.fresh();
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); }
    catch { state.notice = 'Браузер не разрешил сохранение. Макет работает до закрытия этой страницы.'; }
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, onClick, className) {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }
  function author(key) { return key === 'human' ? 'Антон' : M.person(state, key)?.name || key; }
  function change(fn, scroll = false) {
    // Take newer state when this preview is also open on a second monitor.
    try {
      const current = localStorage.getItem(storageKey);
      if (current) state = load();
    } catch { /* Keep the in-memory state. */ }
    const previousReply = state.active?.replyId;
    fn(state);
    if (scroll) follow = true;
    save(); render();
    if (state.active && state.active.replyId !== previousReply) simulate(state.active.replyId);
  }
  function renderMessages() {
    const feed = $('feed');
    const query = $('search').value.trim().toLocaleLowerCase('ru');
    const existing = new Map([...feed.querySelectorAll('.message')].map(n => [n.dataset.id, n]));
    let count = 0;
    for (const m of state.messages) {
      let node = existing.get(m.id);
      if (!node) {
        node = el('article', 'message'); node.dataset.id = m.id;
        const avatar = el('div', 'avatar ' + m.author, initials[m.author] || '?');
        avatar.setAttribute('aria-hidden', 'true');
        const content = el('div', 'message-content');
        const head = el('div', 'message-head');
        head.append(el('strong'), el('span'), el('span', 'partial'));
        content.append(head, el('div', 'message-body'));
        node.append(avatar, content); feed.append(node);
      }
      existing.delete(m.id);
      node.classList.toggle('human', m.author === 'human');
      node.classList.toggle('active', state.active?.replyId === m.id);
      const head = node.querySelector('.message-head');
      head.children[0].textContent = author(m.author);
      head.children[1].textContent = m.sample ? 'Пример' : 'Ты';
      head.children[2].textContent = m.partial ? 'Остановлен' : (m.queued ? 'Ждёт твоей команды' : '');
      const body = node.querySelector('.message-body');
      if (body.textContent !== m.text) body.textContent = m.text;
      node.hidden = !!query && !(author(m.author) + ' ' + m.text).toLocaleLowerCase('ru').includes(query);
      if (!node.hidden) count++;
    }
    for (const node of existing.values()) node.remove();
    $('search-count').textContent = query ? 'Найдено: ' + count : '';
    if (follow) feed.scrollTop = feed.scrollHeight;
    $('latest').hidden = follow || count === 0;
  }
  function renderAgents() {
    const signature = JSON.stringify([state.agents, state.active?.agentId]);
    if (signature === lastAgents) { $('recipient').value = state.recipient; return; }
    lastAgents = signature;
    const area = $('agents'); area.replaceChildren();
    for (const a of state.agents) {
      const busy = state.active?.agentId === a.id;
      const card = el('section', 'agent' + (a.enabled ? '' : ' disabled') + (busy ? ' running' : ''));
      card.dataset.agent = a.id;
      const top = el('div', 'agent-top');
      const identity = el('div', 'agent-identity');
      const label = el('div'); label.append(el('span', 'agent-name', a.name), el('span', 'provider', a.provider));
      identity.append(el('span', 'avatar ' + a.id, initials[a.id]), label);
      const toggleLabel = el('label', 'switch');
      const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = a.enabled;
      toggle.setAttribute('aria-label', 'Подключить: ' + a.name);
      toggle.addEventListener('change', () => change(s => M.toggle(s, a.id, toggle.checked)));
      toggleLabel.append(toggle); top.append(identity, toggleLabel);
      card.append(top, el('div', 'agent-status', !a.enabled ? 'Не участвует' : busy ? 'Пишет пример ответа…' : 'Ждёт твоего обращения'));
      const controls = el('div', 'agent-bottom');
      const summary = el('span', 'model-summary', a.mode + ' · ' + a.model); summary.title = summary.textContent;
      const settings = button('Настройки', () => openSettings(a.id));
      settings.setAttribute('aria-label', 'Настройки: ' + a.name);
      const stop = button('■ Стоп', () => change(s => M.stop(s, a.id)), 'stop-one');
      stop.disabled = !busy; stop.setAttribute('aria-label', 'Остановить: ' + a.name);
      controls.append(summary, settings, stop); card.append(controls); area.append(card);
    }
    const options = ['all', ...M.enabled(state).map(a => a.id)].join('|');
    if (options !== lastRecipientOptions) {
      const selector = $('recipient'); selector.replaceChildren();
      const everyone = el('option', '', M.enabled(state).length === 2 ? 'Обоим' : M.enabled(state).length === 1 ? 'Участнику' : 'Всем');
      everyone.value = 'all'; selector.append(everyone);
      for (const a of M.enabled(state)) { const option = el('option', '', a.name); option.value = a.id; selector.append(option); }
      lastRecipientOptions = options;
    }
    $('recipient').value = state.recipient;
  }
  function render() {
    renderMessages(); renderAgents();
    if ($('draft').value !== state.draft && document.activeElement !== $('draft')) $('draft').value = state.draft;
    const active = state.active && M.person(state, state.active.agentId);
    $('floor-title').textContent = active ? active.name + ' отвечает' : state.pending ? 'Кому передать слово?' : 'Слово у тебя';
    $('floor-dot').classList.toggle('busy', !!active);
    $('floor-detail').textContent = active ? 'Демонстрация · можно остановить' : 'Следующий участник ждёт твоей команды';
    const handoffs = $('handoffs'); handoffs.replaceChildren();
    for (const a of M.enabled(state)) {
      const next = button('→ ' + a.name, () => change(s => M.handoff(s, a.id), true));
      next.disabled = !!active;
      next.setAttribute('aria-label', 'Передать слово: ' + a.name);
      handoffs.append(next);
    }
    $('notice').hidden = !state.notice;
    if ($('notice').textContent !== state.notice) $('notice').textContent = state.notice;
    $('stop-all').disabled = !state.active && !state.pending;
    $('send').textContent = active ? 'Сохранить ↑' : 'Отправить ↑';
    $('send').disabled = !state.draft.trim();
    const queued = state.messages.filter(m => m.queued && m.id !== state.pending);
    const queue = $('queued'); queue.hidden = !queued.length; queue.replaceChildren();
    if (queued.length) queue.append(el('strong', '', 'Ждут твоего решения: ' + queued.length));
    for (const m of queued) {
      const row = el('div', 'queued-row');
      const text = el('span', '', m.text); text.title = m.text; row.append(text);
      const choose = button('Выбрать отвечающего', () => change(s => { s.pending = m.id; s.notice = 'Выбери участника кнопкой передачи слова.'; }));
      choose.disabled = !!active; row.append(choose);
      queue.append(row);
    }
  }
  function simulate(replyId) {
    clearTimeout(timer); ownedReply = replyId;
    const a = M.person(state, state.active.agentId);
    const source = state.messages.find(m => m.id === state.active.sourceId);
    const work = a.mode === 'Выполнение' || /делай|сделай|реализуй|исправь|выполни/iu.test(source.text);
    const text = work
      ? 'Пример выполнения поручения для ' + a.name + '.\n\nВ рабочем Trio здесь будут ход задачи, команды, изменения файлов и результаты проверок. Сейчас мы проверяем только интерфейс: код проекта не менялся.\n\nОтчёт завершён. Дальше слово у тебя.'
      : 'Демонстрационный ответ участника «' + a.name + '».\n\nВ рабочем Trio агент получит твоё сообщение и общую переписку. В этом макете можно проверить передачу слова, остановку и сообщения во время ответа.\n\nСледующий участник сам не начнёт. Передай ему слово, когда прочитаешь.';
    let offset = 0;
    function tick() {
      try { if (localStorage.getItem(storageKey)) state = load(); } catch { /* In-memory mode. */ }
      if (state.active?.replyId !== replyId) { ownedReply = null; render(); return; }
      M.chunk(state, replyId, text.slice(offset, offset + 8)); offset += 8;
      if (offset >= text.length) { M.finish(state, replyId); ownedReply = null; }
      save(); render();
      if (state.active?.replyId === replyId) timer = setTimeout(tick, 90);
    }
    timer = setTimeout(tick, 600);
  }
  function openSettings(key) {
    settingsAgent = key;
    const a = M.person(state, key);
    $('settings-title').textContent = a.name + ' · ' + a.provider;
    $('model').value = a.model;
    $('mode').value = a.mode;
    $('effort').value = a.effort;
    $('settings-dialog').showModal();
  }
  $('settings-form').addEventListener('submit', e => {
    e.preventDefault();
    change(s => {
      const a = M.person(s, settingsAgent);
      a.model = $('model').value.trim() || 'По умолчанию'; a.mode = $('mode').value; a.effort = $('effort').value;
      s.notice = 'Настройки ' + a.name + ' сохранены в макете. Они не запускают агента.';
    });
    $('settings-dialog').close();
  });
  $('close-settings').addEventListener('click', () => $('settings-dialog').close());
  $('composer').addEventListener('submit', e => {
    e.preventDefault();
    if (composing) return;
    const text = $('draft').value, target = $('recipient').value;
    change(s => M.send(s, text, target), true);
    $('draft').value = state.draft;
    $('draft').focus();
  });
  $('draft').addEventListener('input', () => {
    state.draft = $('draft').value; save(); $('send').disabled = !state.draft.trim();
  });
  $('draft').addEventListener('compositionstart', () => { composing = true; });
  $('draft').addEventListener('compositionend', () => { composing = false; });
  $('draft').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) {
      e.preventDefault(); $('composer').requestSubmit();
    }
  });
  $('recipient').addEventListener('change', () => { state.recipient = $('recipient').value; save(); });
  $('stop-all').addEventListener('click', () => change(s => M.stop(s)));
  $('search-toggle').addEventListener('click', () => {
    const opening = $('search-box').hidden;
    $('search-box').hidden = !opening; $('search-toggle').setAttribute('aria-expanded', String(opening));
    if (opening) $('search').focus(); else { $('search').value = ''; renderMessages(); }
  });
  $('search').addEventListener('input', renderMessages);
  $('feed').addEventListener('scroll', () => {
    const f = $('feed'); follow = f.scrollHeight - f.scrollTop - f.clientHeight < 45;
    $('latest').hidden = follow;
  });
  $('latest').addEventListener('click', () => { follow = true; renderMessages(); });
  $('export').addEventListener('click', () => {
    const text = '# Trio — переписка из макета\n\nВсе ответы агентов демонстрационные.\n\n' + state.messages.map(m => '--- ' + author(m.author) + ' ---\n' + (m.partial ? '[Остановлен]\n' : '') + m.text).join('\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = 'trio-preview.md'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('reset').addEventListener('click', () => $('reset-dialog').showModal());
  $('cancel-reset').addEventListener('click', () => $('reset-dialog').close());
  $('confirm-reset').addEventListener('click', () => {
    clearTimeout(timer); ownedReply = null; state = M.fresh(); follow = true; save(); render(); $('draft').value = ''; $('reset-dialog').close();
  });
  $('popout').addEventListener('click', () => {
    save();
    const popup = window.open(window.location.href, 'trio-interface-preview', 'popup,width=1120,height=940');
    if (popup) popup.focus();
    else change(s => { s.notice = 'Браузер заблокировал окно. Разреши всплывающие окна для этого макета.'; });
  });
  window.addEventListener('storage', e => {
    if (e.key !== storageKey) return;
    state = load(); render();
  });
  window.addEventListener('beforeunload', () => {
    if (ownedReply && state.active?.replyId === ownedReply) { M.stop(state); save(); }
  });
  // Reloading the owner window must never silently restart a simulated task.
  if (state.active && !window.opener) M.stop(state);
  save(); render();
})();
