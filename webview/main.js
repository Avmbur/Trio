/* The extension host owns messages, attachments, queue and processes. */
(() => {
  'use strict';
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  const clientId = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  const names = {claude: 'Колян', codex: 'Жека', grok: 'Гриха'};
  const genitive = {'Колян': 'Коляна', 'Жека': 'Жеки', 'Гриха': 'Грихи'};
  const dative = {claude: 'Коляну', codex: 'Жеке', grok: 'Грихе'};
  const authors = {'Колян': 'claude', 'Жека': 'codex', 'Гриха': 'grok', 'Антон': 'human', Trio: 'system'};
  const summaryAuthor = 'Trio · кнопка «Новый»';
  let snapshot, initialized = false, nextRequest = 0, sendPending = false, attaching = false, resetPending = false;
  let responseOrder = [], attachments = [], draftTimer, agentSignature = '', queueSignature = '';
  let queueEditing = {messageId: '', text: ''}, queueEditBox, queueDrag = '', pauseWants = true;
  let orderDrag = -1, droppedNote = '', suppressMarkSync = false, queuePassNotes = {};
  let layout = {side: 'right', width: 400}, dragging = false, draftDragging = false;
  let snippets = [], editingSnippet = '', instructionAgent = '', draftCaret = {start: 0, end: 0}, snippetUndo = [];
  let searchMatches = [], searchIndex = -1, searchTerm = '', searchTimer, tickTimer;
  // Question number → message id for the render that is painting links. Rebuilt at each render.
  let liveRefs = new Map();
  const loadingCatalog = new Set(), loadingUsage = new Set();
  const effortLabels = {'': 'По умолчанию', minimal: 'Минимальное', low: 'Низкое', medium: 'Среднее',
    high: 'Высокое', xhigh: 'Очень высокое', max: 'Максимальное'};
  const effortRank = {minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5};
  function rankedEfforts(list) {
    const seen = new Set(), out = [];
    for (const e of list) if (typeof e === 'string' && e && !seen.has(e)) {seen.add(e); out.push(e);}
    return out.sort((a, b) => (effortRank[a] ?? 50) - (effortRank[b] ?? 50));
  }
  const requests = new Map(), rows = new Map();
  let askDraft = {id: '', index: 0, answers: {}};
  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
    if (m) return m + ' мин' + (sec ? ' ' + sec + ' с' : '');
    return sec + ' с';
  }
  function turnElapsed(turn, running) {
    if (!turn || typeof turn.startedAt !== 'number') return '';
    const end = running ? Date.now() : (typeof turn.endedAt === 'number' ? turn.endedAt : turn.startedAt);
    return formatElapsed(end - turn.startedAt);
  }
  function statusLine(message, running, turn, cancelled) {
    if (message.question) return message.question.answered ? '' : 'ждёт ответа';
    const elapsed = message.author === 'Антон' || message.control ? '' : turnElapsed(turn, running);
    const base = running ? 'отвечает' : cancelled ? 'снят' : message.partial ? 'прервано' : message.error ? 'ошибка' : '';
    return [base, elapsed].filter(Boolean).join(' · ');
  }
  // Anton's own clock: the webview runs on his machine, so Intl takes his zone and
  // Trio neither stores nor guesses one. The author column is 64px, so the date and
  // the time take a line each instead of wrapping wherever they happen to fit.
  const stampDate = new Intl.DateTimeFormat('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric'});
  const stampTime = new Intl.DateTimeFormat('ru-RU', {hour: '2-digit', minute: '2-digit'});
  const stampLong = new Intl.DateTimeFormat('ru-RU',
    {weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'});
  const eventStamp = new Intl.DateTimeFormat('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
  const moment = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  // An answer is stamped when it finished, everything else when it was written. Posts
  // from before the stamp borrow the times of their turn rather than show nothing.
  function messageMoment(message, turn) {
    const answer = message.author !== 'Антон' && !message.control;
    return answer
      ? moment(turn?.endedAt) ?? moment(message.at) ?? moment(turn?.startedAt)
      : moment(message.at) ?? moment(turn?.startedAt);
  }
  function liveQuota(quota) {
    if (!quota || typeof quota.percent !== 'number') return;
    if (typeof quota.resetsAt === 'number' && Number.isFinite(quota.resetsAt) && quota.resetsAt <= Date.now()) return;
    return quota;
  }
  function formatUntil(at) {
    const sec = Math.max(0, Math.floor((at - Date.now()) / 1000));
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m >= 60) return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
    return m + ':' + String(s).padStart(2, '0');
  }
  function formatAgo(at) {
    const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 45) return 'только что';
    const min = Math.round(sec / 60);
    if (min < 60) return min + ' мин назад';
    const h = Math.round(min / 60);
    if (h < 48) return h + ' ч назад';
    return Math.round(h / 24) + ' д назад';
  }
  function quotaHint(quota) {
    const parts = [];
    if (typeof quota.resetsAt === 'number') parts.push('сброс через ' + formatUntil(quota.resetsAt));
    else if (quota.resets) parts.push('сброс ' + quota.resets);
    if (typeof quota.at === 'number' && quota.at > 0) parts.push(formatAgo(quota.at));
    return parts.join(' · ');
  }
  function compactTokens(value, precise) {
    if (value < 1000) return String(Math.round(value));
    if (precise && value < 10000) {
      const k = Math.round(value / 100) / 10;
      return String(k).replace('.', ',') + 'к';
    }
    if (value < 1000000) return Math.round(value / 1000) + 'к';
    const millions = Math.round(value / 100000) / 10;
    return (Number.isInteger(millions) ? String(millions) : String(millions).replace('.', ',')) + 'М';
  }
  function spentLine(turn) {
    if (typeof turn?.spent !== 'number') return '';
    const total = compactTokens(turn.spent) + ' ток.';
    const match = String(turn.spentHint || '').match(/выход (\d+)/);
    const output = match ? Number(match[1]) : undefined;
    if (output === undefined || output === turn.spent) return total;
    return total + '\nвыход ' + compactTokens(output, true);
  }
  function paintStamp(node, message, turn) {
    const at = messageMoment(message, turn);
    const when = at === undefined ? undefined : new Date(at);
    const ownsTurn = !message.question && (!turn?.replyId || turn.replyId === message.id);
    const spent = message.author !== 'Антон' && !message.control && ownsTurn ? spentLine(turn) : '';
    node.textContent = [when ? stampDate.format(when) + '\n' + stampTime.format(when) : '', spent].filter(Boolean).join('\n');
    node.title = [when ? stampLong.format(when) : '', ownsTurn ? turn?.spentHint || '' : ''].filter(Boolean).join('\n');
  }
  function paintTimes() {
    if (!snapshot) return;
    const {state, active, permissions, compacting} = snapshot;
    for (const message of state.messages) {
      const row = rows.get(message.id);
      if (!row) continue;
      const running = active?.turnId === message.turn && message.author !== 'Антон';
      const group = feedIndex.byMessage.get(message.id) || [];
      const cancelled = !!message.cancelled || (message.author === 'Антон' && group.length > 0
        && !group.some(t => t.executor) && group.every(t => t.status === 'interrupted'));
      const turn = message.turn ? feedIndex.byTurnId.get(message.turn) : undefined;
      const status = row.querySelector('.message-status');
      if (status) status.textContent = statusLine(message, running, turn, cancelled);
      const stamp = row.querySelector('.message-stamp');
      if (stamp) paintStamp(stamp, message, turn);
    }
    if (active && !(permissions || []).length && !compacting && !state.messages.some(m => m.question && !m.question.answered)) {
      const live = feedIndex.byTurnId.get(active.turnId);
      const liveTime = turnElapsed(live, true);
      $('floor-title').textContent = answeringLine(state, active, liveTime);
    }
    paintUsageClock();
  }
  function paintUsageClock() {
    const root = $('agents');
    if (!root || typeof root.querySelectorAll !== 'function' || !snapshot) return;
    for (const node of root.querySelectorAll('.usage-one')) {
      const occupancy = (snapshot.state.usage || {})[node.dataset.provider];
      const quota = liveQuota(occupancy && occupancy.quota);
      if (!quota) continue;
      const hint = quotaHint(quota);
      if (hint) node.title = Math.round(quota.percent) + '% · ' + quotaTitle(quota) + ' · ' + hint + '. Клик откроет подробности.';
    }
  }
  function post(type, data = {}, callback) {
    const requestId = ++nextRequest;
    if (callback) requests.set(requestId, callback);
    api.postMessage({type, ...data, conversationId: snapshot?.state.conversationId, clientId, clientRequestId: requestId});
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, fn, disabled = false, className) {
    const b = element('button', className, text); b.type = 'button'; b.disabled = disabled; b.onclick = fn; return b;
  }
  // The bar sits over the composer: it clamps to two lines (click shows all), closes on ×,
  // and leaves by itself — hints after 5 s, errors after 15 s, never while under the pointer
  // or once opened to be read in full.
  let noticeTimer = 0, noticeDelay = 0;
  function notice(text, error = false) {
    clearTimeout(noticeTimer); noticeTimer = 0;
    $('notice-text').textContent = text; $('notice').hidden = !text;
    $('notice').classList.remove('open'); $('notice').classList.toggle('error', !!text && error);
    noticeDelay = error ? 15000 : 5000;
    if (text) noticeTimer = setTimeout(() => notice(''), noticeDelay);
  }
  $('notice-close').onclick = () => notice('');
  $('notice-text').onclick = () => {$('notice').classList.add('open'); clearTimeout(noticeTimer); noticeTimer = 0;};
  $('notice').onmouseenter = () => {clearTimeout(noticeTimer); noticeTimer = 0;};
  $('notice').onmouseleave = () => {if (!$('notice').hidden && !$('notice').classList.contains('open') && !noticeTimer) noticeTimer = setTimeout(() => notice(''), noticeDelay);};
  function usageTitle(label) {
    if (label === '5 ч') return 'Сессия · 5 ч';
    if (label === 'неделя') return 'Неделя';
    if (label && label.startsWith('неделя')) return 'Неделя' + label.slice('неделя'.length);
    if (label === 'окно') return 'Окно подписки';
    return label || 'лимит';
  }
  function usageBar(label, percent, hint) {
    const row = element('div', 'usage-row');
    const head = element('div', 'usage-row-head');
    const value = percent == null || !Number.isFinite(percent) ? '—' : Math.round(percent) + '%';
    head.append(element('span', '', label), element('span', '', value));
    const bar = element('div', 'usage-bar' + (percent >= 90 ? ' over' : percent >= 50 ? ' high' : ''));
    const fill = element('div', 'usage-bar-fill');
    fill.style.width = Math.min(100, percent > 0 ? percent : 0) + '%';
    bar.append(fill);
    row.append(head, bar);
    if (hint) row.append(element('p', 'usage-row-hint', hint));
    return row;
  }
  function quotaTitle(quota) {
    return (quota.limitName ? quota.limitName + ' · ' : '') + usageTitle(quota.label);
  }
  function showUsage(data, fallback) {
    $('usage-title').textContent = data?.title || fallback + ' — расход';
    const body = $('usage-body');
    body.replaceChildren();
    if (data?.plan) body.append(element('p', 'usage-plan', 'План: ' + data.plan));
    const quotas = (data?.quotas || []).filter(liveQuota);
    for (const q of quotas)
      body.append(usageBar(quotaTitle(q), q.percent, quotaHint(q)));
    if (!quotas.length)
      body.append(element('p', 'usage-row-hint', data?.hint
        || (data?.plan ? 'Процент лимита CLI в этом ответе не отдаёт.'
          : 'Тариф не прочитан. Сделай ход этим участником, если токен CLI просрочен.')));
    const sess = data?.session;
    if (sess && (sess.totalTokens != null || sess.limit != null)) {
      const percent = sess.totalTokens != null && sess.limit ? Math.round(sess.totalTokens / sess.limit * 100) : undefined;
      const hint = [sess.totalTokens != null ? sess.totalTokens.toLocaleString('ru-RU') + (sess.limit ? ' из ' + sess.limit.toLocaleString('ru-RU') : '') + ' токенов' : '']
        .filter(Boolean).join(' · ');
      body.append(usageBar('Сессия CLI', percent, hint));
    }
    const occ = data?.occupancy;
    if (occ && (occ.percent != null || occ.tokens != null)) {
      const hint = [occ.tokens != null ? occ.tokens.toLocaleString('ru-RU') + (occ.window ? ' из ' + occ.window.toLocaleString('ru-RU') : '') + ' токенов' : '',
        occ.source ? 'источник: ' + occ.source : ''].filter(Boolean).join(' · ');
      body.append(usageBar('Окно контекста', occ.percent, hint));
    }
    if (data?.text && /CLI:/.test(data.text) && quotas.length)
      body.append(element('pre', 'usage-extra', data.text.slice(data.text.indexOf('CLI:'))));
    else if (!quotas.length && !data?.hint && data?.text)
      body.append(element('pre', 'usage-extra', data.text));
    if (!$('usage-dialog').open) $('usage-dialog').showModal();
  }
  function dropdown(options, value, disabled, onChange) {
    const node = element('select');
    for (const option of options) {
      const item = element('option', '', option.label);
      item.value = option.value;
      if (option.description) item.title = option.description;
      node.append(item);
    }
    node.value = value; node.disabled = disabled;
    node.onchange = () => onChange(node.value);
    return node;
  }
  // Engine's own window after its last answer. Never the trio.contextChars limit on the feed,
  // and never zero when the engine has not reported anything yet.
  function meter(usage) {
    const box = element('div', 'meter');
    const tokens = usage && typeof usage.tokens === 'number' ? usage.tokens : undefined;
    const window = usage && typeof usage.window === 'number' && usage.window > 0 ? usage.window : undefined;
    const percent = tokens !== undefined && window !== undefined ? Math.round(tokens / window * 100) : undefined;
    // A figure above the window means Trio read the wrong number, not a full context.
    // Clamping it to a tidy 100% would hide exactly the defect worth seeing.
    const over = percent !== undefined && percent > 100;
    if (over) box.classList.add('over');
    else if (percent !== undefined && percent >= 85) box.classList.add('high');
    const fill = element('div', 'meter-fill');
    fill.style.width = Math.min(100, percent ?? 0) + '%';
    const compactTokens = value => {
      if (value < 1000) return String(Math.round(value));
      if (value < 1000000) return Math.round(value / 1000) + 'к';
      const millions = Math.round(value / 100000) / 10;
      return (Number.isInteger(millions) ? String(millions) : String(millions).replace('.', ',')) + 'М';
    };
    const label = tokens !== undefined && window !== undefined
      ? (over ? '! ' : '') + compactTokens(tokens) + ' из ' + compactTokens(window)
      : tokens !== undefined ? compactTokens(tokens) : '—';
    box.append(fill, element('span', 'meter-text', label));
    box.setAttribute('role', 'progressbar');
    box.setAttribute('aria-valuemin', '0'); box.setAttribute('aria-valuemax', '100');
    if (percent !== undefined) box.setAttribute('aria-valuenow', String(Math.min(100, percent)));
    const sourceBit = usage && usage.source ? 'Источник: ' + usage.source + '. ' : '';
    const peak = usage && usage.source && usage.source !== 'auto-compact' && usage.source !== 'fresh-session';
    box.title = tokens === undefined && window === undefined
      ? 'Движок ещё не сообщал расход своего контекста. ' + sourceBit + 'Это не лимит ленты Trio.'
      : 'Окно движка после последнего ответа: '
        + (tokens !== undefined ? tokens.toLocaleString('ru-RU') : '?') + ' из '
        + (window !== undefined ? window.toLocaleString('ru-RU') : '?') + ' токенов. '
        + sourceBit
        + (over ? 'Больше окна — значит Trio прочитал не то число, смотри «Диагностику». ' : '')
        + (!over && percent !== undefined && percent >= 85 ? 'Близко к порогу автоматического сжатия движка. ' : '')
        + (peak ? 'Пик с последнего сжатия: короткие ответы не двигают полоску вниз. ' : '')
        + 'Это не лимит ленты Trio.';
    return box;
  }
  function field(label, control, extra) {
    const row = element('div', 'agent-field');
    row.append(element('span', 'field-label', label), control);
    if (extra) row.append(extra);
    return row;
  }
  function draftValue() {
    return {text: $('draft').value, recipient: 'all', responseOrder: [...responseOrder],
      attachments: [...attachments], layout: {...layout}, conversationId: snapshot?.state.conversationId};
  }
  function preserveDraft() {clearTimeout(draftTimer); const value = draftValue(); api.setState(value); if (initialized) post('draft', value);}
  function codeDetails(label, text) {
    const details = element('details', 'code-attachment');
    details.append(element('summary', '', label + ' · ' + text.split('\n').length + ' строк · ' + text.length.toLocaleString('ru-RU') + ' симв.'),
      element('pre', '', text));
    return details;
  }
  function isDiskImage(a) {
    return !!(a.preview || /^Изображение на диске:/m.test(a.text || '') || /\.(png|jpe?g|gif|webp|bmp)(?:\s|·|$)/i.test(a.label || ''));
  }
  function attachmentView(a) {
    if (!isDiskImage(a)) return codeDetails(a.label, a.text);
    const box = element('button', 'image-thumb');
    box.type = 'button';
    box.title = a.label + ' — открыть';
    if (a.preview) {
      const img = element('img', 'image-thumb-img');
      img.src = a.preview;
      img.alt = a.label;
      img.onerror = () => {img.remove(); box.classList.add('broken');};
      box.append(img);
    } else box.classList.add('broken');
    box.append(element('span', 'image-thumb-label', a.label));
    box.onclick = () => showImage(a);
    return box;
  }
  function showImage(a) {
    const img = $('image-full');
    img.src = a.preview || '';
    img.alt = a.label || '';
    img.dataset.id = a.id;
    if (!$('image-dialog').open) $('image-dialog').showModal();
  }
  function renderAttachments() {
    const container = $('attachments');
    const key = JSON.stringify([attachments, sendPending, resetPending]);
    if (container.dataset.key === key) return;
    container.dataset.key = key;
    container.replaceChildren(...attachments.map(a => {
      const row = element('div', 'attachment-row');
      row.append(attachmentView(a), button('×', () => {
        attachments = attachments.filter(other => other.id !== a.id);
        preserveDraft(); renderAttachments();
      }, sendPending || resetPending));
      row.children[1].title = 'Убрать ' + a.label;
      return row;
    }));
    fitComposer();
  }
  function responderCap() {
    const n = snapshot?.maxResponders;
    if (!Number.isInteger(n) || n < 1) return 3;
    return Math.min(n, 10);
  }
  // Зеркало passMarks / syncPassMarks из src/shared/model.ts. Webview тот модуль не импортирует.
  const passMarkRe = /^\[Проход ([1-9]|10) из ([1-9]|10): (Колян|Жека|Гриха|\?)\]$/;
  const markProvider = {Колян: 'claude', Жека: 'codex', Гриха: 'grok'};
  function passMarks(text) {
    const marks = [];
    String(text || '').split('\n').forEach((raw, line) => {
      const match = raw.replace(/\r$/, '').match(passMarkRe);
      if (match) marks.push({pass: Number(match[1]), total: Number(match[2]), name: match[3], line});
    });
    return marks;
  }
  function passSpan(marks, chips) {
    const highest = marks.reduce((max, mark) => Math.max(max, mark.pass), 0);
    return Math.max(marks.length, chips, highest);
  }
  function providersFromMarks(text) {
    const slots = [];
    for (const mark of passMarks(text)) if (markProvider[mark.name]) slots[mark.pass - 1] = markProvider[mark.name];
    const order = [];
    for (const provider of slots) {
      if (!provider) break;
      order.push(provider);
    }
    return order;
  }
  function passWho(order, pass) {
    return order[pass - 1] ? names[order[pass - 1]] : '?';
  }
  function passMarkLine(pass, total, who) {
    return '[Проход ' + pass + ' из ' + total + ': ' + who + ']';
  }
  function rewritePassLines(text, order) {
    const marks = passMarks(text);
    if (!marks.length) return text;
    const total = Math.max(passSpan(marks, order.length), 1);
    return String(text).split('\n').map(raw => {
      const cr = raw.endsWith('\r');
      const line = cr ? raw.slice(0, -1) : raw;
      const match = line.match(passMarkRe);
      if (!match) return raw;
      const next = passMarkLine(Number(match[1]), total, passWho(order, Number(match[1])));
      return cr ? next + '\r' : next;
    }).join('\n');
  }
  function appendPassMarks(text, order, from, to) {
    const blocks = [];
    for (let pass = from; pass <= to; pass++) blocks.push(passMarkLine(pass, Math.max(order.length, to), passWho(order, pass)));
    const skeleton = blocks.join('\n\n') + '\n';
    const base = String(text || '').replace(/[ \t]+$/g, '').replace(/\n+$/g, '');
    return base ? base + '\n\n' + skeleton : skeleton;
  }
  function passRegions(text) {
    const lines = String(text || '').split('\n');
    const marks = [];
    lines.forEach((raw, line) => {
      const match = raw.replace(/\r$/, '').match(passMarkRe);
      if (match) marks.push({pass: Number(match[1]), line});
    });
    return {lines, marks};
  }
  function regionEmpty(lines, start, end) {
    for (let i = start; i < end; i++) if (lines[i].replace(/\r$/, '').trim()) return false;
    return true;
  }
  function stripTrailingEmptyMark(text, chips) {
    let current = text;
    while (true) {
      const found = passRegions(current);
      const last = found.marks[found.marks.length - 1];
      if (!last || last.pass <= chips || !regionEmpty(found.lines, last.line + 1, found.lines.length)) break;
      current = found.lines.slice(0, last.line).join('\n');
    }
    return current;
  }
  function markBodiesEmpty(text) {
    const found = passRegions(text);
    if (!found.marks.length) return false;
    return found.marks.every((mark, index) => regionEmpty(found.lines, mark.line + 1, index + 1 < found.marks.length ? found.marks[index + 1].line : found.lines.length));
  }
  function removePassMarks(text) {
    const found = passRegions(text);
    if (!found.marks.length) return text;
    return found.lines.slice(0, found.marks[0].line).join('\n').replace(/\n+$/g, '');
  }
  function syncPassMarks(text, order, kind) {
    let body = String(text || '');
    const marks = passMarks(body);
    if (kind === 'add' && order.length >= 2 && !marks.length) body = appendPassMarks(body, order, 1, order.length);
    else if (kind === 'add' && marks.length) {
      const start = marks.reduce((max, mark) => Math.max(max, mark.pass), 0) + 1;
      if (start <= order.length) body = appendPassMarks(body, order, start, order.length);
    }
    if (!passMarks(body).length) return body;
    body = rewritePassLines(body, order);
    if (kind === 'drop' && order.length) {
      body = stripTrailingEmptyMark(body, order.length);
      if (passMarks(body).length) body = rewritePassLines(body, order);
      if (order.length < 2 && markBodiesEmpty(body)) body = removePassMarks(body);
    }
    return body;
  }
  function listRu(items) {
    if (items.length <= 1) return items[0] || '';
    if (items.length === 2) return items[0] + ' и ' + items[1];
    return items.slice(0, -1).join(', ') + ' и ' + items[items.length - 1];
  }
  function droppedSentences(dropped, kept) {
    const groups = new Map();
    for (const item of dropped) {
      if (!groups.has(item.provider)) groups.set(item.provider, []);
      groups.get(item.provider).push(item.index);
    }
    const lines = [];
    for (const [provider, indexes] of groups) {
      const one = indexes.length === 1;
      const onto = indexes.map(index => kept[index] ? names[kept[index]] : '?');
      lines.push(names[provider] + ' выключен, его ' + (one ? 'проход ' : 'проходы ')
        + listRu(indexes.map(index => String(index + 1)))
        + (one ? ' переписан на ' : ' переписаны на ') + listRu(onto) + '.');
    }
    return lines.join('\n');
  }
  function draftAddressee() {
    const named = ($('draft').value || '').trim().match(/^(?:@)?(колян|claude|жека|codex|гриха|grok)(?=[\s,:.!?]|$)/iu);
    if (!named) return '';
    return ({колян: 'claude', claude: 'claude', жека: 'codex', codex: 'codex', гриха: 'grok', grok: 'grok'})[named[1].toLowerCase()] || '';
  }
  // Пустой набор и метки с именами — плашки из меток. Обращение по имени плашки не ставит: ответит он один.
  function adoptMarksIfEmpty() {
    if (responseOrder.length || draftAddressee()) return;
    const from = providersFromMarks($('draft').value);
    if (from.length) responseOrder = from.slice(0, responderCap());
  }
  function syncMarksToOrder(kind) {
    const next = syncPassMarks($('draft').value, responseOrder, kind || 'names');
    if (next === $('draft').value) return false;
    suppressMarkSync = true;
    $('draft').value = next;
    suppressMarkSync = false;
    return true;
  }
  function passNotes(text, orderNames, where) {
    const marks = passMarks(text);
    // Текст без меток Trio не размечает: жёлтая строка только когда метки уже есть.
    if (!marks.length) return [];
    const place = where === 'цепочке' ? 'в цепочке' : 'на плашке';
    const lines = [];
    const seen = new Set();
    for (const mark of marks) {
      if (seen.has(mark.pass)) continue;
      seen.add(mark.pass);
      const chip = orderNames[mark.pass - 1];
      if (!chip) lines.push('Кто будет выполнять проход ' + mark.pass + '? Добавь исполнителя или убери пункт.');
      else if (chip !== mark.name) lines.push('Проход ' + mark.pass + ' в тексте — ' + mark.name + ', а ' + place + ' — ' + chip + '.');
    }
    for (let i = 0; i < orderNames.length; i++) {
      if (!orderNames[i] || seen.has(i + 1)) continue;
      lines.push('Для прохода ' + (i + 1) + ' (' + orderNames[i] + ') в тексте нет пункта. Он получит всё сообщение без своего задания.');
    }
    return lines;
  }
  function addressNote() {
    if (responseOrder.length) return '';
    const who = draftAddressee();
    if (!who) return '';
    const uniq = [];
    for (const mark of passMarks($('draft').value)) {
      if (mark.name === '?' || uniq.includes(mark.name)) continue;
      uniq.push(mark.name);
    }
    if (uniq.length > 1 || (uniq.length === 1 && uniq[0] !== names[who]))
      return 'Ответит только ' + names[who] + '. В тексте есть проходы других участников, а плашек нет.';
    return '';
  }
  function paintPassHint() {
    const lines = [];
    if (droppedNote) lines.push(droppedNote);
    // Без плашек и с обращением по имени отдельная строка уже говорит, кто ответит.
    if (responseOrder.length || !draftAddressee())
      lines.push(...passNotes($('draft').value || '', responseOrder.map(id => names[id]), 'плашке'));
    const addressed = addressNote();
    if (addressed) lines.push(addressed);
    const text = lines.filter(Boolean).join('\n');
    $('pass-hint').hidden = !text;
    $('pass-hint').textContent = text;
  }
  function chainNames(state, messageId) {
    const group = state.turns.filter(t => t.messageId === messageId && !t.summary);
    const withPass = group.filter(t => t.pass);
    if (!withPass.length) return group.map(t => names[t.recipient] || '?');
    const slots = [];
    for (const turn of withPass) {
      const at = turn.pass - 1;
      if (at >= 0 && slots[at] === undefined) slots[at] = names[turn.recipient] || '?';
    }
    return slots;
  }
  function renderOrder() {
    if (!snapshot) return;
    const enabled = snapshot.state.agents.filter(a => a.enabled);
    const enabledIds = new Set(enabled.map(a => a.id));
    const before = responseOrder.slice(0, responderCap());
    const kept = [];
    const dropped = [];
    before.forEach((p, index) => {
      if (enabledIds.has(p)) kept.push(p);
      else dropped.push({provider: p, index});
    });
    responseOrder = kept;
    if (dropped.length) {
      syncMarksToOrder('drop');
      droppedNote = droppedSentences(dropped, kept);
      preserveDraft();
    }
    const counts = {};
    for (const id of responseOrder) counts[id] = (counts[id] || 0) + 1;
    $('response-order').replaceChildren(...enabled.map(a => {
      const count = counts[a.id] || 0;
      const control = button(names[a.id], () => {
        if (responseOrder.length >= responderCap()) return;
        responseOrder = [...responseOrder, a.id];
        droppedNote = '';
        syncMarksToOrder('add');
        preserveDraft(); renderOrder();
      }, sendPending || attaching || resetPending, ((count > 0 ? 'selected ' : '') + plateClass(a.id)).trim());
      control.setAttribute('aria-pressed', String(count > 0));
      control.title = 'Добавить в цепочку. Повторный клик ставит агента ещё раз. Крестик в строке сверху снимает один шаг.';
      return control;
    }));
    const strip = $('order-strip');
    strip.hidden = !responseOrder.length;
    const locked = sendPending || attaching || resetPending;
    const clear = plateFace('Очистить', () => {
      responseOrder = [];
      droppedNote = '';
      syncMarksToOrder('clear');
      preserveDraft(); renderOrder();
    }, locked, 'order-step order-clear');
    clear.title = 'Снять весь набор отвечающих';
    strip.replaceChildren(...responseOrder.map((p, index) => {
      const step = element('span', ('order-step ' + plateClass(p)).trim());
      step.draggable = !locked;
      step.title = 'Перетащи на другое место, пока сообщение не отправлено. Номер пункта в тексте не меняется.';
      step.ondragstart = event => {
        if (locked) {event.preventDefault?.(); return;}
        orderDrag = index;
        step.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
        }
      };
      step.ondragend = () => {orderDrag = -1; step.classList.remove('dragging');};
      step.ondragover = event => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      };
      step.ondrop = event => {
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        const from = orderDrag;
        orderDrag = -1;
        if (locked || from < 0 || from === index) return;
        const next = responseOrder.slice();
        const [moved] = next.splice(from, 1);
        next.splice(index, 0, moved);
        responseOrder = next;
        droppedNote = '';
        syncMarksToOrder('names');
        preserveDraft();
        renderOrder();
      };
      const no = element('span', 'order-step-no', String(index + 1));
      const main = element('span', 'order-step-main', names[p]);
      const close = plateFace('×', () => {
        responseOrder = responseOrder.filter((_, at) => at !== index);
        droppedNote = '';
        syncMarksToOrder('drop');
        preserveDraft(); renderOrder();
      }, locked, 'order-step-x');
      close.title = 'Снять этот шаг: ' + names[p];
      close.setAttribute('aria-label', 'Снять ' + names[p] + ' с места ' + (index + 1));
      step.append(no, main, close);
      return step;
    }), clear);
    $('order-hint').hidden = responseOrder.length > 0;
    $('order-hint').textContent = 'Выбери отвечающих или обратись по имени.';
    $('response-order').title = responseOrder.length
      ? responseOrder.map(p => names[p]).join(' › ')
      : $('order-hint').textContent;
    const addressedId = draftAddressee();
    const pick = responseOrder.length ? responseOrder : addressedId ? [addressedId] : [];
    const heavy = (snapshot.deltas || []).filter(d => (d.chars >= 20000 || d.kind === 'full') && pick.includes(d.provider));
    $('delta-hint').hidden = !heavy.length;
    $('delta-hint').classList.toggle('warn', heavy.some(d => d.chars >= 20000));
    const parts = heavy.map(d => names[d.provider] + ': '
      + (d.kind === 'delta' ? 'дельта'
        : d.reason === 'compact' ? 'сжал историю — лента уйдёт заново'
        : 'полная лента (первый ход / после сброса)') + ' '
      + d.chars.toLocaleString('ru-RU') + ' симв. ('
      + (d.total > d.messages ? d.messages + ' из ' + d.total : d.messages) + ' сообщ.)');
    $('delta-hint').textContent = parts.join(' · ')
      + '. Это уйдёт в CLI следующим ходом и забьёт окно. Не нужно — не передавай ему слово.';
    $('delta-hint').title = 'Полная лента — нет сессии (первый ход или сброс). «Сжал историю» — движок выбросил свой контекст, курсор дельты стёрт. Дельта — только новое с его последнего ответа.';
    paintPassHint();
    fitComposer();
  }
  const askKey = item => item.id || item.prompt;
  const answerLabels = value => Array.isArray(value) ? [...new Set(value)] : value ? [value] : [];
  function joinedLabels(item) {return answerLabels(askDraft.answers[askKey(item)]);}
  function paintAsk(ask, index) {
    const items = ask.question.items || [];
    if (!items[index]) return;
    const item = items[index];
    askDraft.index = index;
    $('question-who').textContent = ask.author + ' спрашивает';
    $('question-title').textContent = (items.length > 1 ? 'Вопрос ' + (index + 1) + ' из ' + items.length : 'Вопрос')
      + (item.multi ? ' · несколько' : '');
    const body = $('question-body');
    body.replaceChildren();
    const actions = $('question-actions');
    actions.replaceChildren($('question-deny'));
    body.append(element('p', 'question-prompt', item.prompt));
    const picked = joinedLabels(item);
    const options = item.options || [];
    const extras = (askDraft.custom?.[askKey(item)] || []).filter(label => !options.some(o => o.label === label));
    [...options, ...extras.map(label => ({label, custom: true}))].forEach((opt, i) => {
      const choice = button('', () => item.multi ? toggleAsk(ask, opt.label) : pickAsk(ask, opt.label));
      choice.className = 'question-choice' + (picked.includes(opt.label) ? ' selected' : '');
      choice.disabled = !!askDraft.submitting;
      choice.setAttribute('role', item.multi ? 'checkbox' : 'radio');
      choice.setAttribute('aria-checked', String(picked.includes(opt.label)));
      const mark = element('span', 'question-mark', item.multi ? (picked.includes(opt.label) ? '☑' : '☐') : (picked.includes(opt.label) ? '●' : '○'));
      mark.setAttribute('aria-hidden', 'true');
      choice.append(mark);
      const caption = element('span', 'question-choice-label', (i + 1) + '. ' + opt.label);
      choice.append(caption);
      if (opt.description) choice.append(element('span', 'question-choice-desc', opt.description));
      if (opt.custom) {
        const row = element('div', 'question-custom-choice' + (picked.includes(opt.label) ? ' selected' : ''));
        const remove = button('×', () => {
          askDraft.custom[askKey(item)] = extras.filter(label => label !== opt.label);
          askDraft.answers[askKey(item)] = picked.filter(label => label !== opt.label);
          paintAsk(ask, index);
        }, !!askDraft.submitting, 'question-remove');
        remove.title = 'Удалить свой вариант'; remove.setAttribute('aria-label', 'Удалить: ' + opt.label);
        row.append(choice, remove); body.append(row);
      } else body.append(choice);
    });
    const custom = element('div', 'question-custom');
    const field = document.createElement('input');
    field.type = item.secret ? 'password' : 'text'; field.maxLength = 2000; field.placeholder = 'Свой ответ'; field.className = 'question-free';
    const send = button(item.multi ? 'Добавить' : 'Ответить', () => {
      const text = (field.value || '').trim().slice(0, 2000);
      if (!text) return;
      if (item.multi) {
        if (picked.length >= 32 || askDraft.submitting) return;
        askDraft.custom ||= {};
        askDraft.custom[askKey(item)] = [...new Set([...extras, text])];
        askDraft.answers[askKey(item)] = [...new Set([...picked, text])];
        paintAsk(ask, index);
        $('question-body').querySelector('.question-free')?.focus?.();
      }
      else pickAsk(ask, text);
    });
    send.className = 'question-add';
    send.disabled = !!askDraft.submitting || item.multi && picked.length >= 32;
    custom.append(field, send);
    body.append(custom);
    if (item.multi) {
      const done = button('Готово' + (picked.length ? ' (' + picked.length + ')' : ''), () => finishAsk(ask), !picked.length || !!askDraft.submitting, 'question-done primary');
      actions.append(done);
    }
  }
  function toggleAsk(ask, value) {
    const items = ask.question.items || [];
    const item = items[askDraft.index];
    if (!item || askDraft.submitting) return;
    const current = joinedLabels(item);
    if (!current.includes(value) && current.length >= 32) return;
    const next = current.includes(value) ? current.filter(x => x !== value) : [...current, value];
    if (next.length) askDraft.answers[askKey(item)] = next;
    else delete askDraft.answers[askKey(item)];
    paintAsk(ask, askDraft.index);
  }
  function finishAsk(ask) {
    if (askDraft.submitting) return;
    const items = ask.question.items || [];
    if (askDraft.index < items.length - 1) paintAsk(ask, askDraft.index + 1);
    else {
      askDraft.submitting = true; paintAsk(ask, askDraft.index);
      post('answer', {requestId: ask.question.id, answers: {...askDraft.answers}}, error => {
        if (error && askDraft.id === ask.question.id) {askDraft.submitting = false; paintAsk(ask, askDraft.index); notice(error, true);}
      });
    }
  }
  function pickAsk(ask, value) {
    const items = ask.question.items || [];
    const item = items[askDraft.index];
    if (!item || askDraft.submitting) return;
    askDraft.answers[askKey(item)] = [value];
    finishAsk(ask);
  }
  function showQuestion(container, message) {
    const q = message.question;
    const card = element('div', 'question-card' + (q.answered ? ' answered' : ''));
    card.append(element('p', 'question-card-title', 'Вопрос ' + (genitive[message.author] || message.author)));
    for (const item of q.items || []) {
      const block = element('div', 'question-item');
      block.append(element('p', '', item.prompt));
      const list = element('ol');
      const picked = answerLabels(q.answered?.[askKey(item)]);
      for (const opt of item.options || []) {
        const row = element('li', picked.includes(opt.label) ? 'picked' : '');
        row.textContent = (item.multi || picked.length > 1 ? (picked.includes(opt.label) ? '☑ ' : '☐ ') : '') + opt.label + (opt.description ? ' — ' + opt.description : '');
        list.append(row);
      }
      block.append(list);
      const extra = picked.filter(label => !(item.options || []).some(opt => opt.label === label));
      for (const label of extra) block.append(element('p', 'picked', (item.multi || picked.length > 1 ? '☑ ' : '') + 'свой ответ: ' + label));
      card.append(block);
    }
    container.replaceChildren(card);
  }
  function splitCells(line) {
    let s = (line || '').trim();
    if (s[0] !== '|') return;
    s = s[s.length - 1] === '|' ? s.slice(1, -1) : s.slice(1);
    return s.split('|').map(c => c.trim());
  }
  function isSepRow(cells) {
    return !!cells && cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c.replace(/\s+/g, '')));
  }
  function readTable(lines, start) {
    const header = splitCells(lines[start]);
    const sep = splitCells(lines[start + 1]);
    if (!header || !sep || isSepRow(header) || !isSepRow(sep) || !header.length || header.length > 20) return;
    const cols = header.length;
    const align = sep.map(c => {
      const t = c.replace(/\s+/g, '');
      const left = t.startsWith(':'), right = t.endsWith(':');
      return left && right ? 'center' : right ? 'right' : '';
    });
    const rows = [];
    let i = start + 2;
    while (i < lines.length) {
      if (/^\s*```/.test(lines[i])) break;
      if (!lines[i].trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = (lines[j] || '').trim();
        const open = rows.length && !(lines[i - 1] || '').trim().endsWith('|');
        if (next.startsWith('|') || (open && next && !next.startsWith('|'))) {i = j; continue;}
        break;
      }
      let line = lines[i++];
      while (i < lines.length && line.trim().startsWith('|') && !line.trim().endsWith('|')) {
        const next = lines[i];
        if (!next.trim()) {i++; continue;}
        if (next.trim().startsWith('|')) break;
        line += (/[.\d`]$/.test(line) && /^\S/.test(next) ? '' : ' ') + next;
        i++;
      }
      const row = splitCells(line);
      if (!row || isSepRow(row)) break;
      rows.push(header.map((_, k) => row[k] || ''));
      if (rows.length >= 80) break;
    }
    return {header, align, rows, next: i};
  }
  function paintTable(block) {
    const wrap = element('div', 'md-table-wrap');
    const table = element('table', 'md-table');
    const head = element('thead'), headRow = element('tr');
    for (let i = 0; i < block.header.length; i++)
      headRow.append(paintCell('th', block.align[i] || '', block.header[i]));
    head.append(headRow);
    const body = element('tbody');
    for (const row of block.rows) {
      const tr = element('tr');
      for (let i = 0; i < block.header.length; i++)
        tr.append(paintCell('td', block.align[i] || '', row[i] || ''));
      body.append(tr);
    }
    table.append(head, body);
    wrap.append(table);
    return wrap;
  }
  function fillRich(node, text) {
    const lines = text.split('\n');
    let buf = [], fence = false;
    // Code inside fences stays plain text. A #number there is not a message link.
    const flush = link => {
      if (!buf.length) return;
      const span = element('span', 'md-run');
      const chunk = buf.join('\n');
      if (!link || !paintLinked(span, chunk)) span.textContent = chunk;
      node.append(span);
      buf = [];
    };
    for (let i = 0; i < lines.length;) {
      if (/^\s*```/.test(lines[i])) {
        if (!fence) {flush(true); fence = true; buf.push(lines[i]);}
        else {buf.push(lines[i]); flush(false); fence = false;}
        i++; continue;
      }
      const table = !fence ? readTable(lines, i) : undefined;
      if (table) {flush(!fence); node.append(paintTable(table)); i = table.next; continue;}
      buf.push(lines[i]); i++;
    }
    flush(!fence);
  }
  function showText(container, text) {
    container.replaceChildren();
    // Display old pasted file blocks compactly without modifying stored messages.
    const legacy = text.match(/(?:^|\n\n)Файл ([^\n]{1,500}):\n/);
    if (legacy) {
      const head = element('div');
      const headText = text.slice(0, legacy.index).trimEnd();
      if (!paintLinked(head, headText)) head.textContent = headText;
      container.append(head, codeDetails(legacy[1], text.slice(legacy.index + legacy[0].length)));
      return;
    }
    // trio.collapseMessageLines, 0 switches the line rule off; the length rule stays.
    const lines = snapshot?.collapseLines;
    const limit = typeof lines === 'number' && lines >= 0 ? lines : 100;
    const long = text.length > 6000 || (limit > 0 && text.split('\n').length > limit);
    const hasTable = /(^|\n)\s*\|.+\|[\t ]*\n\s*\|?\s*:?-{1,}.*/.test(text);
    if (long) {
      const details = element('details', 'long-message');
      details.append(element('summary', '', text.slice(0, 160).replace(/\s+/g, ' ') + '… · раскрыть'));
      if (hasTable) {
        const body = element('div', 'long-message-body');
        fillRich(body, text);
        details.append(body);
      } else {
        const pre = element('pre');
        if (!paintLinked(pre, text)) pre.textContent = text;
        details.append(pre);
      }
      container.append(details);
    } else if (hasTable) fillRich(container, text);
    else if (!paintLinked(container, text)) container.textContent = text;
  }
  function showError(container, message) {
    showText(container, message.text);
    const state = snapshot?.state;
    const busy = !!snapshot?.active || resetPending || !!snapshot?.compacting;
    const failed = message.turn && state?.turns.find(t => t.id === message.turn && t.status === 'failed');
    if (failed && !busy)
      container.append(button('Повторить', () => post('retry', {turnId: failed.id})));
  }
  function showControl(container, message) {
    // Retry sits on a failed turn even when the line is a grey control note (denied permission).
    container.replaceChildren();
    // A service line has no author column to hang a stamp on, so its time rides in the line itself.
    const at = moment(message.at);
    const time = at === undefined ? undefined : element('span', 'event-time', eventStamp.format(new Date(at)));
    const actions = message.actions;
    if (actions && actions.length) {
      const outer = element('details', 'event-row');
      outer.append(element('summary', '', message.text));
      for (const a of actions) {
        const inner = element('details', 'event-item');
        inner.append(element('summary', '', a.title || 'действие'));
        if (a.detail) inner.append(element('pre', '', a.detail));
        outer.append(inner);
      }
      container.append(outer);
      if (time) container.append(time);
      return;
    }
    if (message.detail) {
      const details = element('details', 'event-row');
      details.append(element('summary', '', message.text), element('pre', '', message.detail));
      container.append(details);
    } else container.append(element('span', '', message.text));
    if (time) container.append(time);
    const state = snapshot?.state;
    const busy = !!snapshot?.active || resetPending || !!snapshot?.compacting;
    const failed = message.turn && state?.turns.find(t => t.id === message.turn && t.status === 'failed');
    if (failed && !busy) container.append(button('Повторить', () => post('retry', {turnId: failed.id})));
  }
  function answeringLine(state, active, liveTime) {
    const live = active && state.turns.find(t => t.id === active.turnId);
    const cycle = live?.cycle > 1 ? ' · цикл ' + live.cycle : '';
    return names[active.provider] + ' отвечает' + (liveTime ? ' · ' + liveTime : '') + cycle + (state.paused ? ' · затем пауза' : '');
  }
  // Keep in sync with questionNumber, replyNumber and messageMark in src/shared/model.ts.
  // One pass per paint. Recounting every card against the whole feed froze typing.
  const replyMarks = {Колян: 'К', Жека: 'Ж', Гриха: 'Г'};
  let feedLabels = new Map();
  let feedIndex = {byMessage: new Map(), byTurnId: new Map()};
  function indexFeed(state) {
    const refs = new Map();
    const labels = new Map();
    const byMessage = new Map();
    const byReply = new Map();
    const byTurnId = new Map();
    feedLabels = labels;
    if (!state) return {refs, byMessage, byReply, byTurnId};
    for (const turn of state.turns) {
      byTurnId.set(turn.id, turn);
      if (turn.messageId) {
        const list = byMessage.get(turn.messageId);
        if (list) list.push(turn); else byMessage.set(turn.messageId, [turn]);
      }
      if (turn.replyId) {
        const list = byReply.get(turn.replyId);
        if (list) list.push(turn); else byReply.set(turn.replyId, [turn]);
      }
    }
    let n = 0;
    const counts = {Колян: 0, Жека: 0, Гриха: 0};
    for (const message of state.messages) {
      const label = {};
      if (message.author === 'Антон' && byMessage.has(message.id)) {
        label.question = ++n;
        refs.set(String(n), message.id);
      }
      const mark = replyMarks[message.author];
      if (mark && byReply.has(message.id)) {
        const num = ++counts[message.author];
        label.reply = '#' + mark + num;
        refs.set(mark + num, message.id);
      }
      if (label.question || label.reply) labels.set(message.id, label);
    }
    return {refs, byMessage, byReply, byTurnId};
  }
  function questionNumber(state, messageId) {
    return feedLabels.get(messageId)?.question || 0;
  }
  function replyLabel(state, messageId) {
    return feedLabels.get(messageId)?.reply || '';
  }
  function turnsFor(index, messageId) {
    const tasks = [];
    const seen = new Set();
    for (const turn of [...(index.byMessage.get(messageId) || []), ...(index.byReply.get(messageId) || [])]) {
      if (seen.has(turn.id)) continue;
      seen.add(turn.id);
      tasks.push(turn);
    }
    return tasks;
  }
  // #25 and #К76 jump to that message. #250, #К760 and v#25 stay text: the token has to stand alone.
  function paintCell(tag, className, text) {
    const node = element(tag, className);
    if (!paintLinked(node, text)) node.textContent = text;
    return node;
  }
  function paintLinked(parent, text) {
    if (!liveRefs.size || !text || !text.includes('#')) return false;
    const re = /#(?:[КЖГкжг]\d+|\d+)/g;
    let match, start = 0, linked = false;
    const nodes = [];
    while ((match = re.exec(text))) {
      const token = match[0];
      const prev = match.index ? text[match.index - 1] : '';
      const next = text[match.index + token.length] || '';
      const letter = /^#[КЖГкжг]/.test(token);
      const stuck = letter ? /[\p{L}\p{N}_]/u : /[0-9A-Za-z_]/;
      if (stuck.test(prev) || stuck.test(next)) continue;
      const parsed = /^#([КЖГкжг])?(0|[1-9]\d*)$/.exec(token);
      if (!parsed) continue;
      const key = (parsed[1] ? parsed[1].toUpperCase() : '') + parsed[2];
      const id = liveRefs.get(key);
      if (!id) continue;
      if (match.index > start) nodes.push(element('span', '', text.slice(start, match.index)));
      const link = button('#' + key, () => revealQuestion(id), false, 'msg-ref');
      link.title = 'К сообщению #' + key;
      nodes.push(link);
      start = match.index + token.length;
      linked = true;
    }
    if (!linked) return false;
    if (start < text.length) nodes.push(element('span', '', text.slice(start)));
    parent.append(...nodes);
    return true;
  }
  function revealQuestion(messageId) {
    const row = rows.get(messageId);
    if (!row) return;
    const folded = row.querySelector('.long-message');
    if (folded) folded.open = true;
    row.scrollIntoView({block: 'center'});
  }
  // A plate face is a span. A <button> takes the webview command-button chrome and covers the chip.
  function plateFace(text, fn, disabled, className) {
    const node = element('span', className, text);
    if (!fn) return node;
    node.setAttribute('role', 'button');
    node.tabIndex = disabled ? -1 : 0;
    if (disabled) node.setAttribute('aria-disabled', 'true');
    node.onclick = () => {if (!disabled) fn();};
    node.onkeydown = event => {
      if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      fn();
    };
    return node;
  }
  // Agent colour for a plate or a chosen «Отвечают» button. «Любой» and «Все» stay neutral.
  function plateClass(p) {return ['claude', 'codex', 'grok'].includes(p) ? 'plate-' + p : '';}
  // One plate per step. Clickable only when that step may start now; × drops just this step.
  function queueStep(label, kind, title, onMain, onRemove, provider) {
    const step = element('div', ('queue-step ' + kind + ' ' + plateClass(provider)).trim());
    const main = plateFace(label, onMain, false, 'step-main');
    main.title = title; step.append(main);
    if (onRemove) {
      const x = plateFace('×', onRemove, resetPending, 'step-x');
      x.title = 'Снять этот шаг: ' + label + ' не будет отвечать на этот вопрос';
      x.setAttribute('aria-label', 'Снять шаг ' + label);
      step.append(x);
    }
    return step;
  }
  // A question nobody has started on yet: only such a card can be edited or dragged.
  function untouched(state, messageId) {
    const group = state.turns.filter(t => t.messageId === messageId);
    return group.some(t => state.queue.includes(t.id)) && !group.some(t => t.executor || t.summary);
  }
  function queueCard(state, messageId, view) {
    const source = state.messages.find(m => m.id === messageId);
    const group = state.turns.filter(t => t.messageId === messageId);
    const pending = group.filter(t => state.queue.includes(t.id));
    const summary = group.some(t => t.summary);
    const movable = untouched(state, messageId);
    const editing = queueEditing.messageId === messageId;
    const number = questionNumber(state, messageId);
    const card = element('div', 'queue-card' + (group.some(t => t.id === view.activeTurnId) ? ' current' : ''));
    card.dataset.messageId = messageId;
    const head = element('div', 'queue-head');
    const jump = button('#' + number, () => revealQuestion(messageId), false, 'queue-no');
    jump.title = 'Показать вопрос #' + number + ' в ленте';
    head.append(jump);
    const cycle = group.find(t => t.cycle > 1)?.cycle;
    if (cycle) head.append(element('span', 'cycle-badge', 'цикл ' + cycle));
    if (movable && !editing) {
      const grip = element('span', 'queue-grip', '⋮⋮');
      grip.title = 'Перетащи карточку мышкой, чтобы поменять место вопроса в очереди. Начатые вопросы стоят сверху.';
      head.append(element('span', 'spacer'), grip);
      card.draggable = true;
      card.title = 'Карточку можно перетащить мышкой на другое место в очереди';
      card.addEventListener('dragstart', event => {
        queueDrag = messageId; card.classList.add('dragging');
        if (event.dataTransfer) {event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', '#' + number);}
      });
      card.addEventListener('dragend', () => {queueDrag = ''; card.classList.remove('dragging'); clearDropMarks();});
    }
    card.append(head);
    if (editing) {
      const box = element('textarea', 'queue-edit');
      box.value = queueEditing.text; box.rows = 5;
      box.setAttribute('aria-label', 'Текст вопроса #' + number);
      box.title = 'Правка текста вопроса. «Применить» сохраняет, Esc отменяет.';
      box.oninput = () => {queueEditing.text = box.value;};
      box.addEventListener('keydown', event => {
        if (event.key === 'Escape') {event.preventDefault(); queueEditing = {messageId: '', text: ''}; queueSignature = ''; render();}
      });
      queueEditBox = box;
      card.append(box);
    } else {
      const text = summary ? 'Сводка для нового разговора' : source?.text || '';
      const body = element('div', 'queue-text', text);
      body.title = 'Текст вопроса #' + number + (movable ? '. Изменить — «Редактировать».' : '');
      card.append(body);
      if (source?.attachments?.length) card.append(element('div', 'queue-files', 'Вложения: ' + source.attachments.map(a => a.label).join(', ')));
    }
    const steps = element('div', 'queue-plates');
    steps.setAttribute('aria-label', 'Порядок ответов на вопрос #' + number);
    for (const turn of group) {
      const queued = state.queue.includes(turn.id);
      if (turn.summary && queued) {
        steps.append(queueStep('Сводка', 'waiting', names[turn.recipient] + ' подготовит сводку для нового разговора',
          null, () => post('discard', {turnId: turn.id}), turn.recipient));
      } else if (turn.status === 'completed') {
        steps.append(queueStep(names[turn.executor] + ' ✓', 'done', names[turn.executor] + ' ответил', null, null, turn.executor));
      } else if (turn.status === 'running' || turn.status === 'preparing') {
        steps.append(queueStep(names[turn.executor] + '…', 'running', names[turn.executor] + ' отвечает сейчас', null, null, turn.executor));
      } else if (queued) {
        const who = state.agents.filter(a => a.enabled && (turn.recipient === 'all' || a.id === turn.recipient));
        for (const a of who.length ? who : [{id: turn.recipient}]) {
          const name = names[a.id] || 'Любой';
          const ready = !view.busy && !view.paused && pending[0]?.id === turn.id && who.length > 0;
          const title = !who.length ? name + ' выключен. Включи его карточку или сними этот шаг.'
            : view.paused ? 'Очередь на паузе. ' + name + ' начнёт после «Продолжить».'
            : ready ? 'Разрешить один ответ ' + name + ' на вопрос #' + number
            : state.autoReply ? name + ' пойдёт сам по автоответу, когда подойдёт очередь'
            : name + ' ждёт своей очереди. Когда подойдёт, плашка замигает: клик — ответить.';
          steps.append(queueStep(name, ready ? (turn.id === view.headTurnId ? 'next' : 'ready') : 'waiting', title,
            ready ? () => post('handoff', {provider: a.id, turnId: turn.id}) : null,
            () => post('discard', {turnId: turn.id}), a.id));
        }
      } else {
        const name = names[turn.executor || turn.recipient] || 'Все';
        steps.append(queueStep(name + ' · ' + (turn.status === 'failed' ? 'ошибка' : 'снят'), 'done',
          name + (turn.status === 'failed' ? ': ход оборвался с ошибкой' : ': шаг снят'), null, null, turn.executor || turn.recipient));
      }
    }
    card.append(steps);
    if (queuePassNotes[messageId]) card.append(element('p', 'pause-hint queue-pass-hint', queuePassNotes[messageId]));
    if (pending.length) {
      const tools = element('div', 'queue-tools');
      if (movable) {
        const edit = button(editing ? 'Применить' : 'Редактировать', () => {
          if (!editing) {queueEditing = {messageId, text: source?.text || ''}; queueSignature = ''; render(); queueEditBox?.focus?.(); return;}
          const note = passNotes(queueEditing.text, chainNames(state, messageId), 'цепочке').join('\n');
          if (note) queuePassNotes[messageId] = note;
          else delete queuePassNotes[messageId];
          queueSignature = '';
          post('queue-edit', {messageId, text: queueEditing.text}, error => {
            if (error) return;
            queueEditing = {messageId: '', text: ''}; queueSignature = ''; render();
          });
          render();
        }, resetPending, editing ? 'primary' : '');
        edit.title = editing ? 'Сохранить новый текст вопроса' : 'Править текст прямо здесь. Можно, пока на вопрос никто не начал отвечать.';
        tools.append(edit);
      }
      const remove = button('Удалить', () => {
        if (editing) queueEditing = {messageId: '', text: ''};
        post('queue-remove', {messageId});
      }, resetPending, 'queue-remove');
      remove.title = movable || summary ? 'Убрать вопрос #' + number + ' из очереди. В ленте он останется зачёркнутым.'
        : 'Снять оставшиеся шаги вопроса #' + number + '. Уже данные ответы останутся.';
      tools.append(remove);
      card.append(tools);
    }
    return card;
  }
  function clearDropMarks() {
    for (const card of $('queued').children || []) card.classList.remove('drop-before', 'drop-after');
  }
  // Above the middle of a card — before it, below — before the next one, past the last — to the end.
  function dropSpot(event) {
    const card = event.target?.closest?.('.queue-card');
    if (!card) return {card: null, before: undefined, after: false};
    const rect = card.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) return {card, before: card.dataset.messageId, after: false};
    return {card, before: card.nextElementSibling?.dataset?.messageId, after: true};
  }
  function renderQueue(state, busy) {
    const active = snapshot.active;
    const activeTurn = active ? state.turns.find(t => t.id === active.turnId) : undefined;
    const queued = state.queue.map(id => state.turns.find(t => t.id === id)).filter(Boolean);
    const ids = [...new Set([...(activeTurn ? [activeTurn.messageId] : []), ...queued.map(t => t.messageId)])];
    if (queueEditing.messageId && !untouched(state, queueEditing.messageId)) {
      queueEditing = {messageId: '', text: ''};
      notice('На вопрос уже начали отвечать или его убрали. Правка не сохранена.', true);
    }
    const shown = new Set(ids);
    const key = JSON.stringify([state.queue, ids.map(id => questionNumber(state, id)),
      state.turns.filter(t => shown.has(t.messageId)).map(t => [t.id, t.status, t.executor, t.recipient, t.cycle, t.summary]),
      ids.map(id => {const m = state.messages.find(x => x.id === id); return [m?.text, (m?.attachments || []).map(a => a.label)];}),
      busy, !!state.paused, !!state.autoReply, activeTurn?.id, state.agents.map(a => [a.id, a.enabled]),
      queueEditing.messageId, queuePassNotes, resetPending]);
    if (key === queueSignature) return; queueSignature = key;
    const list = $('queue-list'), scroll = list.scrollTop;
    const old = queueEditBox, typing = !!old && document.activeElement === old;
    const caret = typing ? [old.selectionStart, old.selectionEnd] : undefined;
    queueEditBox = undefined;
    const view = {busy, paused: !!state.paused, activeTurnId: activeTurn?.id, headTurnId: queued.find(t => t.status === 'proposed')?.id};
    $('queued').hidden = !ids.length;
    $('queue-empty').hidden = !!ids.length;
    $('queued').replaceChildren(...ids.map(id => queueCard(state, id, view)));
    list.scrollTop = scroll;
    if (typing && queueEditBox) {queueEditBox.focus(); queueEditBox.setSelectionRange?.(caret[0], caret[1]);}
  }
  // Пауза → Отменить паузу, пока агент дорабатывает → Продолжить. Продолжить же и для
  // очереди, вставшей без паузы: после Стоп, обрыва хода или закрытия окна при включённом Авто.
  function paintPause(state, active, busy) {
    const head = state.queue.map(id => state.turns.find(t => t.id === id)).find(t => t && t.status === 'proposed');
    const paused = !!state.paused, number = head ? questionNumber(state, head.messageId) : 0;
    const stalled = !paused && !busy && !!state.autoReply && !!head && !head.summary;
    const pause = $('pause');
    let label = 'Пауза', title = 'Пауза: текущий агент спокойно закончит ход, следующий из очереди не начнёт. '
      + 'Пауза хранится на диске и переживёт закрытие VS Code. Во время паузы можно отправить вопрос вне очереди. '
      + 'Учти, что это может сбить с толку заготовленную очередь, которая пойдёт после незапланированного вопроса.';
    if (paused && active) {
      label = 'Отменить паузу';
      title = 'Пауза ждёт, пока ' + names[active.provider] + ' закончит ход. Нажми, чтобы отменить паузу: очередь пойдёт дальше как обычно.';
    } else if (paused) {
      label = 'Продолжить';
      title = head ? 'Очередь на паузе. Нажми, чтобы продолжить с #' + number + '.' : 'Очередь на паузе и пуста. Нажми, чтобы снять паузу.';
    } else if (stalled) {
      label = 'Продолжить';
      title = 'Очередь стоит: был «Стоп», ход оборвался или окно закрывалось. Нажми, чтобы продолжить с #' + number + '.';
    }
    pauseWants = !paused && !stalled;
    pause.textContent = label; pause.title = title;
    pause.classList.toggle('selected', paused);
    pause.setAttribute('aria-pressed', String(paused));
    pause.disabled = resetPending || (pauseWants && !head);
  }
  function summaryHold(state) {
    return (state?.turns || []).some(t => t.summary && (t.status === 'proposed' || t.status === 'preparing' || t.status === 'running'));
  }
  function paintFeedMeter() {
    const count = snapshot?.state?.messages?.length || 0;
    const raw = snapshot?.feedMax;
    const limit = Number.isInteger(raw) && raw >= 1 ? raw : 1000;
    const percent = count / limit * 100;
    const box = $('feed-meter');
    box.classList.toggle('high', percent >= 50 && percent < 80);
    box.classList.toggle('hot', percent >= 80);
    $('feed-meter-fill').style.width = Math.min(100, Math.max(0, percent)) + '%';
    $('feed-meter-text').textContent = 'Сообщений: ' + count.toLocaleString('ru-RU');
    box.setAttribute('aria-valuemin', '0');
    box.setAttribute('aria-valuemax', '100');
    box.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, Math.round(percent)))));
    box.title = 'Сообщений в ленте: ' + count.toLocaleString('ru-RU') + ' из ' + limit.toLocaleString('ru-RU')
      + '. Полоска заранее показывает, что отрисовка может начать тормозить. '
      + 'На одном компьютере с вложениями (скрины и прочее) это было около 1050 сообщений, без вложений лента шла и после 1200. '
      + 'Это ориентир для удобства, запись не блокируется. '
      + 'Свой максимум меняется в настройках Trio: максимальное количество сообщений в ленте.';
  }
  function render() {
    if (!snapshot) return;
    paintFeedMeter();
    const {state, active, progress, permissions, compacting} = snapshot, busy = !!active || resetPending || !!compacting;
    const indexed = indexFeed(state);
    feedIndex = indexed;
    liveRefs = indexed.refs;
    const refKey = [...liveRefs.entries()].map(([key, id]) => key + '=' + id).join('\n');
    const feed = $('feed'), nearEnd = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
    const query = $('search-box').hidden ? '' : $('search').value;
    const currentIds = new Set(state.messages.map(m => m.id));
    const pendingQuestionTurns = new Set(state.messages.filter(m => m.question && !m.question.answered).map(m => m.turn));
    for (const [id, row] of rows) if (!currentIds.has(id)) {row.remove(); rows.delete(id);}
    if (!state.messages.length) {
      if (!feed.querySelector('.empty')) feed.append(element('p', 'empty', 'Нет сообщений.'));
    } else feed.querySelector('.empty')?.remove();
    // Saved order wins. A reply stored beside its question must not stay at the
    // end just because that card was created after later questions were painted.
    let previous = null;
    for (const message of state.messages) {
      let row = rows.get(message.id);
      if (!row) {
        row = element('article', 'message'); row.dataset.messageId = message.id;
        const head = element('div', 'message-head');
        head.append(element('strong', '', message.author), element('span', 'message-status'), element('span', 'message-stamp'));
        const content = element('div', 'message-content');
        content.append(element('ol', 'message-trace'), element('div', 'message-body'), element('div', 'message-attachments'), element('div', 'message-tools'));
        row.append(head, content); rows.set(message.id, row);
      }
      const next = previous ? previous.nextElementSibling : feed.firstElementChild;
      if (row !== next) feed.insertBefore(row, next);
      previous = row;
      const running = active?.turnId === message.turn && message.author !== 'Антон';
      const group = indexed.byMessage.get(message.id) || [];
      const cancelled = !!message.cancelled || (message.author === 'Антон' && group.length > 0
        && !group.some(t => t.executor) && group.every(t => t.status === 'interrupted'));
      // The summary task is stored as Anton's so it keeps a question number, but Trio wrote it.
      const byButton = message.author === 'Антон' && group.some(t => t.summary);
      const who = byButton ? summaryAuthor : message.author;
      const name = row.querySelector('.message-head strong');
      if (name.textContent !== who) name.textContent = who;
      row.className = 'message ' + (authors[byButton ? 'Trio' : message.author] || '') + (running ? ' active' : '')
        + (message.error ? ' error' : '') + (message.control ? ' event' : '') + (cancelled ? ' cancelled' : '');
      const body = row.querySelector('.message-body');
      const bodyKey = message.text + '\0' + (message.detail || '') + '\0' + JSON.stringify(message.actions || [])
        + '\0' + (message.control ? '1' : '0') + '\0' + JSON.stringify(message.question || null)
        + '\0' + (message.turn || '') + '\0' + (busy ? '1' : '0')
        // A changed folding threshold has to repaint bodies that are already on screen.
        + '\0' + (snapshot?.collapseLines ?? '')
        // A reply that names #25 stays plain until that message exists, then grows a link.
        + (/#/.test(message.text || '') ? '\0' + refKey : '');
      if (body.dataset.text !== bodyKey) {
        body.dataset.text = bodyKey;
        if (message.question) showQuestion(body, message);
        else if (message.control) showControl(body, message);
        else if (message.error) showError(body, message);
        else showText(body, message.text);
      }
      const files = row.querySelector('.message-attachments');
      const attachmentKey = JSON.stringify(message.attachments || []);
      if (files.dataset.key !== attachmentKey) {
        files.dataset.key = attachmentKey; files.replaceChildren(...(message.attachments || []).map(a => attachmentView(a)));
      }
      const status = row.querySelector('.message-status');
      const turn = message.turn ? indexed.byTurnId.get(message.turn) : undefined;
      status.textContent = statusLine(message, running, turn, cancelled);
      paintStamp(row.querySelector('.message-stamp'), message, turn);
      const traceBox = row.querySelector('.message-trace');
      const steps = !message.control && !message.question && message.author !== 'Антон'
        && (!turn?.replyId || turn.replyId === message.id) ? (turn?.trace || []) : [];
      const traceKey = JSON.stringify(steps);
      if (traceBox.dataset.key !== traceKey) {
        traceBox.dataset.key = traceKey;
        if (!steps.length) {traceBox.replaceChildren(); traceBox.hidden = true;}
        else {
          traceBox.hidden = false;
          traceBox.replaceChildren(...steps.map(s => {
            const item = element('li', 'trace-item' + (s.status === 'running' ? ' busy' : ' done'));
            item.append(element('span', 'trace-dot'), element('span', 'trace-title', s.title));
            return item;
          }));
        }
      }
      const tools = row.querySelector('.message-tools');
      const tasks = turnsFor(indexed, message.id);
      const ownNo = message.author === 'Антон' && tasks.length ? '#' + questionNumber(state, message.id) : '';
      const replyNo = replyLabel(state, message.id);
      const answered = replyNo ? tasks.find(t => t.replyId === message.id) : undefined;
      const questionNo = answered ? questionNumber(state, answered.messageId) : 0;
      const toolsKey = ownNo + '\0' + replyNo + '\0' + questionNo + '\0' + JSON.stringify(tasks);
      if (tools.dataset.key !== toolsKey) {
        tools.dataset.key = toolsKey; tools.replaceChildren();
        if (ownNo) {
          const pending = tasks.filter(t => state.queue.includes(t.id)).length;
          tools.append(element('span', 'question-no', ownNo + (pending ? ' · ожидает ответа: ' + pending : '')));
        }
        if (replyNo) {
          tools.append(element('span', 'question-no', replyNo));
          if (questionNo) {
            const back = button('На вопрос #' + questionNo, () => revealQuestion(answered.messageId), false, 'answer-ref');
            back.title = 'К вопросу #' + questionNo;
            tools.append(back);
          }
        }
        for (const task of tasks.filter(t => t.snapshot && (t.replyId === message.id || !t.replyId))) {
          if (task.status === 'running' || task.status === 'preparing')
            tools.append(element('span', '', 'Правки разрешены'));
          else {
            const diff = button('Изменения файлов', () => post('changes', {taskId: task.id}));
            diff.title = 'Сравнить файлы с снимком на начало этого хода';
            tools.append(diff);
          }
        }
        for (const task of tasks) {
          if (!task.instruction) continue;
          if (task.replyId ? task.replyId !== message.id : message.author === 'Антон' || message.turn !== task.id) continue;
          const note = element('details', 'instruction-used');
          const head = element('summary', '', 'Инструкции включены');
          head.title = task.instruction;
          note.append(head, element('pre', '', task.instruction));
          tools.append(note);
        }
      }
      row.hidden = !message.question && message.author !== 'Антон' && !message.text.trim()
        && !message.attachments?.length && !steps.length && pendingQuestionTurns.has(message.turn);
    }
    clearTimeout(searchTimer);
    if (query) searchTimer = setTimeout(() => updateSearch(false), 100);
    else updateSearch(false);
    if (nearEnd && !query) feed.scrollTop = feed.scrollHeight;
    const waiting = (permissions || []).length;
    const asks = (state.messages || []).filter(m => m.question && !m.question.answered);
    if (waiting) {
      const p = permissions[0];
      const flat = (p.caption || p.title || '').replace(/\s+/g, ' ').trim();
      $('floor-title').textContent = waiting > 1 ? 'Ждёт разрешения: ' + waiting : 'Ждёт разрешения';
      $('floor-dot').classList.toggle('busy', false);
      $('floor-dot').classList.toggle('wait', true);
      $('floor-detail').textContent = names[p.provider] + (flat ? ': ' + (flat.length > 80 ? flat.slice(0, 79).trimEnd() + '…' : flat) : '');
      $('floor-detail').title = flat;
    } else if (asks.length) {
      const q = asks[0];
      const flat = (q.text || '').replace(/\s+/g, ' ').trim();
      $('floor-title').textContent = asks.length > 1 ? 'Ждёт ответа: ' + asks.length : 'Ждёт ответа';
      $('floor-dot').classList.toggle('busy', false);
      $('floor-dot').classList.toggle('wait', true);
      $('floor-detail').textContent = q.author + (flat ? ': ' + (flat.length > 80 ? flat.slice(0, 79).trimEnd() + '…' : flat) : '');
      $('floor-detail').title = flat;
    } else if (compacting) {
      $('floor-title').textContent = compacting === 'all' ? 'Сжатие контекста' : names[compacting] + ': сжатие';
      $('floor-dot').classList.toggle('busy', true);
      $('floor-dot').classList.toggle('wait', false);
      $('floor-detail').textContent = progress || 'Движок сжимает свою историю. Лента Trio не меняется.';
      $('floor-detail').title = $('floor-detail').textContent;
    } else {
      const live = active && state.turns.find(t => t.id === active.turnId);
      const liveTime = turnElapsed(live, true);
      const resting = !active && !!state.paused;
      $('floor-title').textContent = active ? answeringLine(state, active, liveTime) : resting ? 'Пауза' : 'Готово';
      $('floor-dot').classList.toggle('busy', !!active);
      $('floor-dot').classList.toggle('wait', resting);
      const detail = active ? progress || '' : resting ? 'Очередь стоит до «Продолжить».' : '';
      $('floor-detail').textContent = detail;
      $('floor-detail').title = detail;
    }
    $('stop-all').disabled = !active && !compacting;
    paintPause(state, active, busy);
    const autoOn = !!state.autoReply, editsOn = !!state.autoEdits, cmdsOn = !!state.autoCommands;
    $('auto-reply').classList.toggle('selected', autoOn);
    $('auto-reply').setAttribute('aria-pressed', String(autoOn));
    $('auto-reply-work').classList.toggle('selected', autoOn);
    $('auto-reply-work').setAttribute('aria-pressed', String(autoOn));
    $('auto-edits').classList.toggle('selected', editsOn);
    $('auto-edits').setAttribute('aria-pressed', String(editsOn));
    $('auto-commands').classList.toggle('selected', cmdsOn);
    $('auto-commands').setAttribute('aria-pressed', String(cmdsOn));
    const privilegeOn = !!state.privilegeOn;
    $('auto-privileges').classList.toggle('selected', privilegeOn);
    $('auto-privileges').setAttribute('aria-pressed', String(privilegeOn));
    if ($('privilege-dialog').open) paintPrivilegeReading();
    const hold = summaryHold(state);
    $('send').disabled = sendPending || attaching || resetPending || hold;
    $('attach').disabled = sendPending || attaching || resetPending || hold;
    const clearable = !busy && !sendPending && !attaching && !hold;
    $('reset-context').disabled = !clearable;
    $('new-conversation').disabled = resetPending || sendPending || attaching || hold || !!compacting;
    $('compact-all').disabled = !clearable || !state.agents.some(a => a.enabled);
    if ($('fresh-dialog').open) {
      paintFreshRemember();
      $('fresh-go').disabled = !!compacting || hold || resetPending || !state.agents.some(a => a.enabled && a.id === freshProvider);
    }
    $('draft').disabled = resetPending;
    $('send').textContent = state.paused ? 'Отправить вне очереди' : active ? 'В очередь' : 'Отправить';
    $('send').title = state.paused ? 'Снимет паузу. Уже начатый вопрос не разрывает: сначала его оставшиеся шаги, потом этот. Ответы на него увидят следующие агенты сценария.' : '';
    $('pause-hint').hidden = !state.paused;
    $('popout').hidden = !!snapshot.detached;
    $('detached-label').hidden = !snapshot.detached;
    const root = snapshot.root || '';
    $('project').hidden = !root;
    if (root) {
      $('project').textContent = 'Проект: ' + root;
      $('project').title = 'Открыть папку проекта';
    }
    const signature = JSON.stringify([state.agents, active?.provider, resetPending, compacting, snapshot.catalogs, [...loadingCatalog], [...loadingUsage], state.usage]);
    if (signature !== agentSignature) {
      agentSignature = signature;
      $('agents').replaceChildren(...state.agents.map(a => {
        const running = active?.provider === a.id;
        const row = element('section', 'agent' + (!a.enabled ? ' disabled' : ''));
        const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = a.enabled;
        toggle.disabled = running || resetPending;
        toggle.setAttribute('aria-label', 'Включить ' + names[a.id]);
        toggle.onchange = () => post('agent', {agent: {...a, enabled: toggle.checked}}, error => {if (error) {agentSignature = ''; render();}});
        const identity = element('div', 'agent-heading');
        const enabledLabel = element('label', 'agent-toggle'); enabledLabel.append(toggle, element('span', '', 'Участвует'));
        identity.append(element('strong', '', names[a.id]),
          element('span', 'provider-label', a.id === 'claude' ? 'Claude Code' : a.id === 'codex' ? 'Codex' : 'Grok'),
          element('span', 'spacer'), enabledLabel);
        const models = (snapshot.catalogs || {})[a.id] || [];
        const loading = loadingCatalog.has(a.id);
        const locked = running || resetPending || loading;
        const modelOptions = [{value: '', label: 'Из настроек CLI'},
          ...models.map(m => ({value: m.value, label: m.label, description: m.description}))];
        if (a.model && !models.some(m => m.value === a.model)) modelOptions.push({value: a.model, label: a.model});
        const chosen = models.find(m => m.value === a.model);
        const efforts = rankedEfforts(chosen ? chosen.efforts : models.flatMap(m => m.efforts));
        const effortOptions = [{value: '', label: effortLabels['']},
          ...efforts.map(e => ({value: e, label: effortLabels[e] || e}))];
        // Without a catalog nothing is known about this engine, so a saved value is not "outside the list".
        if (a.effort && !efforts.includes(a.effort))
          effortOptions.push({value: a.effort, label: (effortLabels[a.effort] || a.effort) + (models.length ? ' — вне списка' : '')});
        const save = next => post('agent', {agent: {...a, ...next}}, error => {if (error) {notice(error, true);} agentSignature = ''; render();});
        const modelSelect = dropdown(modelOptions, a.model, locked, value => {
          // Efforts belong to the model, so an unsupported one is dropped with it.
          const next = models.find(m => m.value === value);
          save({model: value, effort: !next || !a.effort || next.efforts.includes(a.effort) ? a.effort : ''});
        });
        modelSelect.setAttribute('aria-label', 'Модель ' + names[a.id]);
        const reload = button(loading ? '…' : '↻', () => {
          loadingCatalog.add(a.id); agentSignature = ''; render();
          post('catalog', {provider: a.id}, error => {
            loadingCatalog.delete(a.id); if (error) notice(error, true);
            agentSignature = ''; render();
          });
        }, locked, 'reload-models');
        reload.title = 'Загрузить список моделей из CLI. Запускает движок, но не обращается к модели.';
        const effortSelect = dropdown(effortOptions, a.effort, locked, value => save({effort: value}));
        effortSelect.setAttribute('aria-label', 'Усилие рассуждения ' + names[a.id]);
        const note = (a.instruction || '').trim();
        const instruct = button('✎', () => openInstruction(a.id), locked, 'agent-instruction' + (note ? ' set' : ''));
        instruct.title = note || ('Инструкция ' + dative[a.id]);
        instruct.setAttribute('aria-label', 'Инструкция ' + dative[a.id]);
        instruct.setAttribute('aria-pressed', String(!!note));
        const mode = element('div', 'agent-mode');
        mode.setAttribute('role', 'group');
        mode.setAttribute('aria-label', 'Режим ' + names[a.id]);
        for (const [value, label, hint] of [['discuss', 'Чтение', 'Читает код и обсуждает, файлы не меняет'],
          ['execute', 'Правки', 'Может менять файлы и запускать команды с твоего разрешения']]) {
          const control = button(label, () => post('agent', {agent: {...a, mode: value}}, error => {if (error) {agentSignature = ''; render();}}),
            running || resetPending, a.mode === value ? 'selected' : '');
          control.setAttribute('aria-pressed', String(a.mode === value));
          control.title = hint;
          mode.append(control);
        }
        const actions = element('div', 'agent-actions');
        const shrinking = compacting === a.id || compacting === 'all';
        const compact = button(shrinking ? '…' : 'Сжать', () => post('compact', {provider: a.id}, error => {
          notice(error || names[a.id] + ': контекст сжат.', !!error);
        }), running || resetPending || shrinking || !a.enabled);
        compact.title = 'Сжать контекст ' + names[a.id] + ': движок сожмёт свою историю сам. Лента Trio не меняется. Это обращение к модели.';
        const stop = button('■ Стоп', () => post('stop', {provider: a.id}), !running, 'stop-one');
        stop.title = 'Остановить работу ' + names[a.id];
        const resetOne = button('Сброс', () => post('reset', {mode: 'context', provider: a.id}, error => {
          notice(error || names[a.id] + ': контекст сброшен.', !!error);
        }), running || resetPending || !a.enabled, 'reset-one');
        resetOne.title = 'Сбросить контекст ' + names[a.id] + ': сессия CLI начнётся заново, лента на экране останется. Файлы проекта не трогаем.';
        const fetching = loadingUsage.has(a.id);
        const occupancy = (state.usage || {})[a.id];
        const quota = liveQuota(occupancy && occupancy.quota);
        const percent = quota ? Math.round(quota.percent) : undefined;
        const usage = element('button', 'usage-one' + (percent >= 90 ? ' over' : percent >= 50 ? ' high' : ''));
        usage.type = 'button'; usage.disabled = locked || fetching || !a.enabled;
        usage.dataset.provider = a.id;
        const fill = element('span', 'usage-fill');
        fill.style.width = Math.min(100, percent > 0 ? percent : 0) + '%';
        const label = element('span', 'usage-text');
        if (fetching) label.textContent = '…';
        else if (percent === undefined || percent === 0) label.textContent = 'Usage';
        else {
          label.append(element('span', '', percent + '%'), element('span', 'usage-word', 'usage'));
        }
        usage.append(fill, label);
        usage.title = percent === undefined
          ? 'Показать расход и лимиты подписки. Запускает CLI, к модели не обращается.'
          : percent + '% · ' + quotaTitle(quota)
            + (quotaHint(quota) ? ' · ' + quotaHint(quota) : '') + '. Клик откроет подробности.';
        usage.onclick = () => {
          if (usage.disabled) return;
          loadingUsage.add(a.id); agentSignature = ''; render();
          post('usage', {provider: a.id}, (error, data) => {
            loadingUsage.delete(a.id); agentSignature = ''; render();
            if (error) {notice(error, true); return;}
            showUsage(data, names[a.id]);
          });
        };
        const side = element('div', 'agent-side');
        side.append(resetOne, usage);
        row.append(identity, field('Модель', modelSelect, reload),
          field('Усилие', effortSelect, instruct),
          field('Режим', mode, actions),
          field('Контекст', meter(occupancy), side));
        actions.append(compact, stop);
        return row;
      }));
    }
    renderOrder(); renderAttachments(); renderQueue(state, busy);
    const list = permissions || [];
    const dialog = $('permission-dialog');
    const hot = list[0];
    if (!hot) {
      if (dialog.open) dialog.close();
      dialog.dataset.key = '';
    } else if (dialog.dataset.key !== hot.id) {
      dialog.dataset.key = hot.id;
      $('permission-title').textContent = (hot.caption || hot.title || 'Разрешение').replace(/\s+/g, ' ').trim();
      $('permission-who').textContent = names[hot.provider] + ' просит доступ';
      const flat = (hot.caption || hot.title || '').replace(/\s+/g, ' ').trim();
      $('permission-what').textContent = flat;
      $('permission-detail').textContent = hot.detail || '';
      $('permission-more').hidden = !hot.detail;
      $('permission-more').open = false;
      $('permission-standing').hidden = !hot.standing;
      if (!dialog.open) {dialog.showModal(); $('permission-once').focus?.();}
    }
    const askDialog = $('question-dialog');
    const ask = !hot && asks[0];
    if (!ask) {
      if (askDialog.open) askDialog.close();
      askDialog.dataset.key = '';
    } else if (askDialog.dataset.key !== ask.question.id) {
      askDialog.dataset.key = ask.question.id;
      askDraft = {id: ask.question.id, index: 0, answers: {}};
      paintAsk(ask, 0);
      if (!askDialog.open) {askDialog.showModal(); $('question-body').querySelector('button')?.focus?.();}
    }
    clearInterval(tickTimer);
    const quotaTick = Object.values(state.usage || {}).some(u => typeof u?.quota?.resetsAt === 'number' && u.quota.resetsAt > Date.now());
    tickTimer = (active && !waiting && !asks.length && !compacting) || quotaTick ? setInterval(paintTimes, 1000) : 0;
  }
  $('discuss').onclick = () => {
    const on = $('discuss').classList.toggle('selected');
    $('discuss').setAttribute('aria-pressed', String(on));
  };
  function composerFlags() {
    return TrioComposer.captureFlags({
      autoEdits: $('auto-edits').classList.contains('selected'),
      autoCommands: $('auto-commands').classList.contains('selected'),
      discuss: $('discuss').classList.contains('selected'),
      responseOrder
    });
  }
  function persistSnippets() {post('snippets', {items: snippets});}
  function rememberDraftCaret() {
    const ta = $('draft');
    const n = (ta.value || '').length;
    const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : n;
    const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start;
    draftCaret = {start, end};
  }
  function insertDraftText(text) {
    const ta = $('draft');
    const before = ta.value || '';
    const n = before.length;
    const start = Math.max(0, Math.min(draftCaret.start, n));
    const end = Math.max(start, Math.min(draftCaret.end, n));
    ta.focus();
    if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(start, end);
    else {ta.selectionStart = start; ta.selectionEnd = end;}
    // insertText в webview часто не пишет в native undo и склеивает шаги.
    let inserted = false;
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text) && ta.value !== before)
      inserted = true;
    if (!inserted) {
      const next = TrioComposer.insertAtCursor(before, start, end, text);
      ta.value = next.value;
      ta.selectionStart = ta.selectionEnd = next.caret;
    }
    rememberDraftCaret();
    snippetUndo = TrioComposer.snippetUndoPush(snippetUndo, before, ta.value, start);
  }
  function undoSnippetInsert() {
    const ta = $('draft');
    const result = TrioComposer.snippetUndoApply(snippetUndo, ta.value || '');
    if (!result.applied) return false;
    snippetUndo = result.stack;
    ta.focus();
    ta.value = result.value;
    const caret = Math.max(0, Math.min(result.caret, result.value.length));
    if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(caret, caret);
    else {ta.selectionStart = ta.selectionEnd = caret;}
    rememberDraftCaret();
    preserveDraft();
    return true;
  }
  function closeSnippets() {
    $('snippets-panel').hidden = true;
    $('snippets-toggle').setAttribute('aria-expanded', 'false');
  }
  function placeSnippetsPanel() {
    const box = $('composer'), panel = $('snippets-panel'), tools = $('composer-tools');
    if (typeof box.getBoundingClientRect !== 'function') return;
    const r = box.getBoundingClientRect();
    const toolsTop = tools && typeof tools.getBoundingClientRect === 'function' ? tools.getBoundingClientRect().top : r.bottom;
    const vh = window.innerHeight || 0;
    if (!r.width || !vh) return;
    panel.style.left = r.left + 'px';
    panel.style.width = r.width + 'px';
    panel.style.bottom = (vh - toolsTop) + 'px';
    panel.style.maxHeight = Math.max(120, Math.min(Math.round(vh * 0.5), toolsTop - 8)) + 'px';
  }
  function renderSnippetsList() {
    const empty = !snippets.length;
    $('snippets-filter').hidden = empty;
    $('snippets-empty-hint').hidden = !empty;
    const shown = TrioComposer.filterSnippets(snippets, $('snippets-filter').value);
    if (!shown.length) {
      if (empty) $('snippets-list').replaceChildren();
      else $('snippets-list').replaceChildren(element('p', 'snippet-empty', 'Нет совпадений.'));
      return;
    }
    $('snippets-list').replaceChildren(...shown.map(snippet => {
      const row = element('div', 'snippet-row');
      row.setAttribute('role', 'option');
      row.draggable = true;
      row.title = snippet.text;
      if (snippet.flags) {
        const mark = element('span', 'snippet-flag', '●');
        mark.title = TrioComposer.flagsHint(snippet.flags);
        row.append(mark);
      }
      const name = button(snippet.name, () => applySnippet(snippet), false, 'snippet-name');
      name.title = snippet.text;
      name.onmousedown = event => {if (event && event.preventDefault) event.preventDefault();};
      const edit = button('✎', event => {event && event.stopPropagation && event.stopPropagation(); openSnippetEditor(snippet.id);}, false, 'snippet-edit');
      edit.title = 'Править';
      row.append(name, edit);
      row.ondragstart = event => {
        event.dataTransfer?.setData('text/plain', snippet.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      };
      row.ondragover = event => {event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';};
      row.ondrop = event => {
        event.preventDefault();
        const from = event.dataTransfer?.getData('text/plain');
        if (!from) return;
        snippets = TrioComposer.moveSnippet(snippets, from, snippet.id);
        persistSnippets(); renderSnippetsList();
      };
      return row;
    }));
  }
  function openSnippets(focusFilter) {
    rememberDraftCaret();
    $('snippets-panel').hidden = false;
    $('snippets-toggle').setAttribute('aria-expanded', 'true');
    $('more-actions').hidden = true;
    $('more-toggle').setAttribute('aria-expanded', 'false');
    renderSnippetsList();
    placeSnippetsPanel();
    if (focusFilter && snippets.length) $('snippets-filter').focus();
    else $('snippets-from-field').focus();
  }
  function applySnippetFlags(flags) {
    if (!flags) return;
    const edits = !!flags.autoEdits, cmds = !!flags.autoCommands;
    const editsOn = $('auto-edits').classList.contains('selected');
    const cmdsOn = $('auto-commands').classList.contains('selected');
    if (edits !== editsOn || cmds !== cmdsOn) {
      if (edits || cmds) warnExecute();
      post('flags', {autoEdits: edits, autoCommands: cmds});
    }
    $('discuss').classList.toggle('selected', !!flags.discuss);
    $('discuss').setAttribute('aria-pressed', String(!!flags.discuss));
    responseOrder = Array.isArray(flags.responseOrder) ? flags.responseOrder.filter(p => names[p]).slice(0, responderCap()) : [];
    renderOrder();
  }
  function applySnippet(snippet) {
    droppedNote = '';
    const emptyBefore = responseOrder.length === 0;
    insertDraftText(snippet.text);
    applySnippetFlags(snippet.flags);
    if (!snippet.flags) {
      if (emptyBefore) adoptMarksIfEmpty();
      renderOrder();
    } else if (!responseOrder.length) {
      adoptMarksIfEmpty();
      if (responseOrder.length) renderOrder();
    }
    preserveDraft();
    closeSnippets();
    $('draft').focus();
  }
  function refreshSnippetHint() {
    $('snippet-flags-hint').textContent = $('snippet-keep-flags').checked
      ? TrioComposer.flagsHint(composerFlags()) || 'флаги: выключены'
      : 'Флаги не запоминаются — вставка не тронет +правки, +команды, Обсуждаем и порядок.';
  }
  function openSnippetEditor(id, create) {
    editingSnippet = id || '';
    const existing = id && snippets.find(s => s.id === id);
    const creating = !existing;
    $('snippet-dialog-title').textContent = creating ? 'Новая заготовка' : 'Заготовка';
    $('snippet-name').value = existing ? existing.name : (create && create.name || '');
    $('snippet-text').value = existing ? existing.text : (create && create.text != null ? create.text : $('draft').value);
    $('snippet-keep-flags').checked = existing ? !!existing.flags : TrioComposer.flagsActive(composerFlags());
    $('snippet-delete').hidden = creating;
    $('snippet-duplicate').hidden = creating;
    refreshSnippetHint();
    if (!$('snippet-dialog').open) $('snippet-dialog').showModal();
    $('snippet-name').focus();
  }
  function paintInstructionCount() {
    const limit = Number($('instruction-text').maxLength) || 1000;
    const n = ($('instruction-text').value || '').length;
    $('instruction-count').textContent = n + ' / ' + limit;
    $('instruction-clear').disabled = !($('instruction-text').value || '').trim();
  }
  function openInstruction(id) {
    instructionAgent = id;
    const agent = snapshot?.state.agents.find(a => a.id === id);
    $('instruction-dialog-title').textContent = 'Инструкция ' + dative[id];
    $('instruction-text').value = agent && agent.instruction || '';
    paintInstructionCount();
    if (!$('instruction-dialog').open) $('instruction-dialog').showModal();
    $('instruction-text').focus();
  }
  function saveInstruction(text) {
    const agent = snapshot?.state.agents.find(a => a.id === instructionAgent);
    if (!agent) return;
    $('instruction-dialog').close();
    post('agent', {agent: {...agent, instruction: text}}, error => {
      if (error) notice(error, true);
      agentSignature = ''; render();
    });
  }
  $('instruction-text').oninput = paintInstructionCount;
  $('instruction-cancel').onclick = () => $('instruction-dialog').close();
  $('instruction-save').onclick = () => saveInstruction($('instruction-text').value);
  $('instruction-clear').onclick = () => saveInstruction('');
  $('instruction-dialog').addEventListener?.('cancel', () => {instructionAgent = '';});
  $('snippets-toggle').onclick = () => {
    if ($('snippets-panel').hidden) openSnippets(true);
    else closeSnippets();
  };
  $('snippets-filter').oninput = () => renderSnippetsList();
  $('snippets-from-field').onclick = () => {
    const source = TrioComposer.snippetCreateSource($('draft').value, $('snippets-filter').value);
    if (!source.text.trim()) {notice('Сначала набери текст.'); return;}
    if (snippets.length >= TrioComposer.snippetLimits.count) {notice('Не больше ' + TrioComposer.snippetLimits.count + ' заготовок.'); return;}
    notice('');
    openSnippetEditor('', source);
  };
  $('snippet-keep-flags').onchange = () => refreshSnippetHint();
  $('snippet-cancel').onclick = () => $('snippet-dialog').close();
  $('snippet-save').onclick = () => {
    const name = TrioComposer.trimName($('snippet-name').value);
    const text = ($('snippet-text').value || '').replace(/\r\n/g, '\n');
    if (!name) {notice('Назови заготовку.'); return;}
    if (!text.trim()) {notice('Текст пустой.'); return;}
    const item = {
      id: editingSnippet || TrioComposer.snippetId(),
      name, text,
      flags: $('snippet-keep-flags').checked ? composerFlags() : undefined
    };
    const next = TrioComposer.upsertSnippet(snippets, item);
    if (next === snippets && !snippets.some(s => s.id === item.id)) {
      notice('Не больше ' + TrioComposer.snippetLimits.count + ' заготовок.'); return;
    }
    snippets = next;
    persistSnippets();
    if (!editingSnippet) $('snippets-filter').value = '';
    $('snippet-dialog').close();
    renderSnippetsList();
    notice('');
  };
  $('snippet-delete').onclick = () => {
    if (!editingSnippet) return;
    snippets = TrioComposer.removeSnippet(snippets, editingSnippet);
    persistSnippets();
    $('snippet-dialog').close();
    renderSnippetsList();
  };
  $('snippet-duplicate').onclick = () => {
    if (!editingSnippet) return;
    const next = TrioComposer.duplicateSnippet(snippets, editingSnippet);
    if (next === snippets) {notice('Не больше ' + TrioComposer.snippetLimits.count + ' заготовок.'); return;}
    snippets = next;
    persistSnippets();
    $('snippet-dialog').close();
    renderSnippetsList();
  };
  $('snippet-name').onkeydown = event => {
    if (event.key === 'Enter') {event.preventDefault(); $('snippet-save').click();}
  };
  $('snippets-panel').hidden = true;
  const decide = (allow, whole, standing) => {
    const id = $('permission-dialog').dataset.key;
    if (id) post('permission', {requestId: id, allow, whole, standing});
  };
  $('permission-once').onclick = () => decide(true);
  $('permission-whole').onclick = () => decide(true, true);
  $('permission-standing').onclick = () => decide(true, false, true);
  $('permission-deny').onclick = () => decide(false);
  $('usage-close').onclick = () => $('usage-dialog').close();
  $('permission-dialog').addEventListener?.('cancel', event => {
    event.preventDefault();
    decide(false);
  });
  const denyQuestion = () => {
    const id = $('question-dialog').dataset.key;
    if (id) post('answer', {requestId: id, answers: {}});
  };
  $('question-deny').onclick = () => denyQuestion();
  $('question-dialog').addEventListener?.('cancel', event => {
    event.preventDefault();
    denyQuestion();
  });
  $('question-dialog').addEventListener?.('keydown', event => {
    if (event.target && event.target.tagName === 'INPUT') {
      if (event.key === 'Enter' && !event.isComposing) {event.preventDefault(); event.target.parentNode?.querySelector('button')?.click();}
      return;
    }
    if (event.key === 'z' || event.key === 'Z') {
      event.preventDefault();
      $('question-body').querySelector('input')?.focus?.();
      return;
    }
    const n = event.key >= '1' && event.key <= '9' ? Number(event.key) - 1 : -1;
    const choices = [...($('question-body').querySelectorAll?.('.question-choice') || [])];
    if (n >= 0 && n < choices.length) {event.preventDefault(); choices[n].click();}
  });
  $('compact-all').onclick = () => post('compact', {}, error => {notice(error || 'Контекст сжат всем включённым участникам.', !!error);});
  $('composer').onsubmit = event => {
    event.preventDefault();
    if (!initialized || sendPending || attaching || resetPending || summaryHold(snapshot?.state) || !$('draft').value.trim() && !attachments.length) return;
    clearTimeout(draftTimer);
    droppedNote = '';
    const text = $('draft').value, order = [...responseOrder], sentAttachments = [...attachments];
    sendPending = true; render();
    const discuss = /\bselected\b/.test($('discuss').className || '');
    post('send', {text, recipient: 'all', responseOrder: order, attachments: sentAttachments, discuss}, error => {
      sendPending = false;
      if (!error) {
        if (JSON.stringify(responseOrder) === JSON.stringify(order)) responseOrder = [];
        attachments = attachments.filter(a => !sentAttachments.some(sent => sent.id === a.id));
        if ($('draft').value === text) $('draft').value = '';
        snippetUndo = [];
        preserveDraft();
      }
      render();
    });
  };
  $('draft').oninput = () => {
    rememberDraftCaret();
    if (!suppressMarkSync) {droppedNote = ''; adoptMarksIfEmpty();}
    api.setState(draftValue());
    clearTimeout(draftTimer);
    draftTimer = setTimeout(preserveDraft, 250);
    renderOrder();
  };
  $('draft').addEventListener('blur', rememberDraftCaret);
  $('draft').addEventListener('select', rememberDraftCaret);
  function addAttachment(attachment) {
    try {
      const result = TrioComposer.addAttachment(attachments, attachment);
      attachments = result.attachments; preserveDraft();
      notice(result.added ? '' : attachment.label + ' уже прикреплён.');
    } catch (e) {notice(e.message, true);}
  }
  $('draft').onpaste = event => {
    const item = [...(event.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item || !initialized || attaching || sendPending || resetPending) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    attaching = true; render();
    const reader = new FileReader();
    reader.onerror = () => {attaching = false; notice('Не удалось прочитать изображение из буфера.', true); render();};
    reader.onload = () => {
      const data = String(reader.result).split(',')[1] || '';
      post('image', {data, mime: file.type, name: file.name || undefined}, (error, payload) => {
        if (!error && payload?.attachment) addAttachment(payload.attachment);
        else if (error) notice(error, true);
        attaching = false; render();
      });
    };
    reader.readAsDataURL(file);
  };
  $('draft').onkeydown = event => {
    rememberDraftCaret();
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key && event.key.toLowerCase() === 'z') {
      if (undoSnippetInsert()) {event.preventDefault(); return;}
    }
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !($('draft').value || '').length) {
      event.preventDefault(); openSnippets(true); return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {event.preventDefault(); $('composer').requestSubmit();}
  };
  $('project').onclick = () => post('project');
  for (const type of ['popout', 'export', 'import', 'plugin-settings', 'settings', 'diagnostics', 'reconnect']) $(type).onclick = () => {
    $('more-actions').hidden = true; $('more-toggle').setAttribute('aria-expanded', 'false');
    // The host cannot see what the webview's engine decided about the environment.
    post(type, type === 'diagnostics' ? {reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches} : {});
  };
  $('attach').onclick = () => {
    if (!initialized || attaching || sendPending || resetPending) return;
    attaching = true; render();
    post('attach', {}, (error, data) => {
      try {
        if (error || data?.cancelled) return;
        const attachment = data?.attachment;
        if (!attachment || typeof attachment.id !== 'string' || typeof attachment.label !== 'string' || typeof attachment.text !== 'string') {
          notice('Не удалось получить вложение.', true); return;
        }
        addAttachment(attachment);
        $('draft').focus();
      } catch (e) {notice(e.message, true);}
      finally {attaching = false; render();}
    });
  };
  $('archives').onclick = () => post('archives');
  let freshProvider = '';
  function paintFreshRemember() {
    const count = snapshot?.state?.messages?.length || 0;
    $('fresh-count-value').textContent = count.toLocaleString('ru-RU');
    $('fresh-remember').disabled = count < 1;
    paintFreshQueue();
  }
  // The third warning is only for a waiting question. A queued summary is not one.
  function paintFreshQueue() {
    const state = snapshot?.state;
    const waiting = !!state && (state.queue || []).some(id => {
      const turn = state.turns.find(t => t.id === id);
      return turn && turn.status === 'proposed' && !turn.summary;
    });
    $('fresh-queue').hidden = !waiting;
  }
  function openFresh() {
    if (!initialized || resetPending || sendPending || attaching || snapshot?.compacting || summaryHold(snapshot?.state)) return;
    const state = snapshot?.state;
    if (!state) return;
    const enabled = state.agents.filter(a => a.enabled);
    if (!enabled.some(a => a.id === freshProvider)) freshProvider = enabled[0]?.id || '';
    const box = $('fresh-agents');
    box.replaceChildren(...enabled.map(a => {
      const picked = a.id === freshProvider;
      const b = button(names[a.id], () => {
        freshProvider = a.id;
        for (const child of box.children) {
          const on = child.dataset.provider === a.id;
          child.classList.toggle('selected', on);
          child.setAttribute('aria-pressed', String(on));
        }
      });
      b.dataset.provider = a.id;
      b.setAttribute('aria-pressed', String(picked));
      if (picked) b.classList.add('selected');
      return b;
    }));
    box.style.gridTemplateColumns = 'repeat(' + Math.max(enabled.length, 1) + ', minmax(0, 1fr))';
    if (!enabled.length) box.append(element('span', 'fresh-note', 'Включите участника.'));
    paintFreshRemember();
    $('fresh-go').disabled = !freshProvider;
    if (!$('fresh-dialog').open) $('fresh-dialog').showModal();
  }
  function reset(mode) {
    if (!initialized || resetPending || sendPending || attaching || snapshot?.active || summaryHold(snapshot?.state)) return;
    preserveDraft(); resetPending = true; render();
    post('reset', {mode}, error => {
      resetPending = false;
      if (!error) notice('Контекст сброшен.');
      render();
    });
  }
  $('reset-context').onclick = () => reset('context');
  $('new-conversation').onclick = openFresh;
  $('fresh-cancel').onclick = () => $('fresh-dialog').close();
  $('fresh-dialog').addEventListener?.('cancel', () => $('fresh-dialog').close());
  $('fresh-remember').onclick = () => {
    const count = snapshot?.state?.messages?.length || 0;
    if (count < 1) return;
    post('feed-max', {count});
    $('fresh-dialog').close();
  };
  $('fresh-go').onclick = () => {
    if (!freshProvider || $('fresh-go').disabled || snapshot?.compacting || summaryHold(snapshot?.state)) return;
    post('fresh-summary', {provider: freshProvider});
    $('fresh-dialog').close();
  };
  $('stop-all').onclick = () => post('stop');
  $('pause').onclick = () => post('pause', {on: pauseWants});
  const toggleAgents = () => {layout.agentsFolded = !layout.agentsFolded; applyLayout(); saveLayout();};
  $('agents-fold').onclick = toggleAgents;
  $('queue-fold').onclick = toggleAgents;

  $('queue-list').addEventListener('dragover', event => {
    if (!queueDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    // Near an edge the list scrolls by itself, so a card can travel past what is on screen.
    const list = $('queue-list'), box = list.getBoundingClientRect();
    if (event.clientY < box.top + 28) list.scrollTop -= 12;
    else if (event.clientY > box.bottom - 28) list.scrollTop += 12;
    clearDropMarks();
    const spot = dropSpot(event);
    if (spot.card && spot.card.dataset.messageId !== queueDrag) spot.card.classList.add(spot.after ? 'drop-after' : 'drop-before');
  });
  $('queue-list').addEventListener('dragleave', event => {
    if (!event.relatedTarget || !$('queue-list').contains?.(event.relatedTarget)) clearDropMarks();
  });
  $('queue-list').addEventListener('drop', event => {
    if (!queueDrag) return;
    event.preventDefault();
    const spot = dropSpot(event), messageId = queueDrag;
    queueDrag = ''; clearDropMarks();
    if (spot.before === messageId) return;
    post('queue-move', {messageId, ...(spot.before ? {before: spot.before} : {})});
  });
  $('auto-reply').onclick = () => post('flags', {autoReply: !$('auto-reply').classList.contains('selected')});
  $('auto-reply-work').onclick = () => post('flags', {autoReply: !$('auto-reply-work').classList.contains('selected')});
  function warnExecute() {
    if (snapshot?.state.agents.filter(a => a.enabled).every(a => a.mode === 'discuss'))
      notice('Нужен режим Правок хотя бы у одного участника.');
  }
  $('auto-edits').onclick = () => {
    const on = !$('auto-edits').classList.contains('selected');
    if (on) warnExecute();
    post('flags', {autoEdits: on});
  };
  $('auto-commands').onclick = () => {
    const on = !$('auto-commands').classList.contains('selected');
    if (on) warnExecute();
    post('flags', {autoCommands: on});
  };
  const privilegeIds = ['delete', 'network', 'git', 'shell', 'unparsed', 'other'];
  const privilegeGenitive = {claude: 'Коляна', codex: 'Жеки', grok: 'Грихи'};
  function privilegeNames(ids) {
    const list = ids.map(id => privilegeGenitive[id]).filter(Boolean);
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' и ' + list[list.length - 1];
  }
  function privilegeSentence(ids, queue) {
    const who = privilegeNames(ids);
    if (!who) return '';
    const many = ids.length > 1;
    if (queue) return 'В очереди у ' + who + ' режим Чтение — ' + (many ? 'они не смогут вносить правки в этих заданиях.' : 'он не сможет вносить правки в этом задании.');
    return 'У ' + who + ' включено Чтение — ' + (many ? 'они не смогут вносить правки.' : 'он не сможет вносить правки.');
  }
  function paintPrivilegeReading() {
    const state = snapshot?.state;
    const line = $('privilege-reading');
    if (!state) {line.hidden = true; line.textContent = ''; return;}
    const enabled = state.agents.filter(a => a.enabled);
    const card = enabled.filter(a => a.mode !== 'execute').map(a => a.id);
    const queued = [];
    for (const turnId of state.queue || []) {
      const turn = state.turns.find(t => t.id === turnId && t.status === 'proposed' && t.mode === 'discuss');
      if (!turn) continue;
      const who = turn.recipient === 'all' ? enabled.map(a => a.id) : [turn.recipient];
      for (const id of who) {
        const agent = enabled.find(a => a.id === id);
        if (agent && agent.mode === 'execute' && !queued.includes(id)) queued.push(id);
      }
    }
    const text = [privilegeSentence(card, false), privilegeSentence(queued, true)].filter(Boolean).join(' ');
    line.textContent = text;
    line.hidden = !text;
  }
  $('auto-privileges').onclick = () => {
    if ($('auto-privileges').classList.contains('selected')) {
      post('flags', {privilegeOn: false});
      return;
    }
    const picked = new Set(snapshot?.state?.privileges || []);
    for (const id of privilegeIds) $('privilege-' + id).checked = picked.has(id);
    paintPrivilegeReading();
    if (!$('privilege-dialog').open) $('privilege-dialog').showModal();
  };
  $('privilege-all').onclick = () => {
    for (const id of privilegeIds) $('privilege-' + id).checked = true;
  };
  $('privilege-ok').onclick = () => {
    const privileges = privilegeIds.filter(id => $('privilege-' + id).checked);
    $('privilege-dialog').close();
    if (!privileges.length) return;
    post('flags', {privilegeOn: true, privileges});
  };
  $('privilege-cancel').onclick = () => $('privilege-dialog').close();
  let queueCopyTimer;
  $('queue-copy').onclick = () => {
    const text = [...$('queue-template').querySelectorAll('p')].map(p => p.textContent.trim()).join('\n\n');
    post('copy', {text}, error => {
      if (error) return;
      $('queue-copy').textContent = 'Скопировано';
      clearTimeout(queueCopyTimer);
      queueCopyTimer = setTimeout(() => {$('queue-copy').textContent = 'Скопировать в буфер';}, 1500);
    });
  };
  $('privilege-dialog').addEventListener?.('cancel', () => $('privilege-dialog').close());
  $('image-close').onclick = () => $('image-dialog').close?.();
  $('image-save').onclick = () => {const id = $('image-full').dataset.id; if (id) post('save-image', {id});};
  $('image-dialog').addEventListener?.('click', event => {if (event.target === $('image-dialog')) $('image-dialog').close?.();});
  function clearHighlights() {
    for (const mark of searchMatches) {
      const parent = mark.parentNode;
      if (parent) {mark.replaceWith(document.createTextNode(mark.textContent)); parent.normalize();}
    }
    searchMatches = [];
  }
  function selectMatch(scroll) {
    searchMatches.forEach((m, index) => m.classList.toggle('current-match', index === searchIndex));
    $('search-count').textContent = searchMatches.length ? (searchIndex + 1) + ' / ' + searchMatches.length : '0 / 0';
    $('search-prev').disabled = !searchMatches.length; $('search-next').disabled = !searchMatches.length;
    if (scroll && searchIndex >= 0) {
      const target = searchMatches[searchIndex];
      for (let parent = target.parentElement; parent && parent !== $('feed'); parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      const number = target.parentElement && target.parentElement.closest('.question-no');
      const host = number ? target.parentElement.closest('.message') : target;
      (host || target).scrollIntoView({block: 'center'});
    }
  }
  // #138 and #К76 are message numbers. #1380 and #К760 are different ones, so the digits have to end.
  function numberQuery(term) {return /^#[кжг]?\d+$/u.test(term);}
  function hideFromSearch(node) {
    const parent = node.parentElement;
    if (!parent || !parent.closest) return false;
    // The summary repeats the opening of a folded message; the body is the copy that counts.
    if (parent.tagName === 'SUMMARY' && parent.closest('.long-message')) return true;
    // Buttons and notes under the message are chrome. The #number is how that message is found.
    if (parent.closest('.message-tools') && !parent.closest('.question-no')) return true;
    return false;
  }
  function updateSearch(scroll) {
    clearTimeout(searchTimer);
    const typed = $('search-box').hidden ? '' : $('search').value.toLowerCase();
    const trimmed = typed.trim();
    const numbered = /^#\s*([кжг])?(\d+)$/u.exec(trimmed);
    const term = numbered ? '#' + (numbered[1] || '') + numbered[2] : typed;
    const changed = term !== searchTerm;
    clearHighlights(); searchTerm = term;
    if (!term) {searchIndex = -1; selectMatch(false); return;}
    const walker = document.createTreeWalker($('feed'), NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (hideFromSearch(node)) continue;
      if (node.textContent.toLowerCase().includes(term)) nodes.push(node);
    }
    for (const node of nodes) {
      const text = node.textContent, lower = text.toLowerCase(), fragment = document.createDocumentFragment();
      let start = 0, from = 0, at, matched = false;
      while ((at = lower.indexOf(term, from)) >= 0) {
        // Rejecting #2 inside #20 must keep those characters: only the search cursor moves.
        if (numberQuery(term) && /[0-9]/.test(lower.charAt(at + term.length))) {from = at + 1; continue;}
        fragment.append(document.createTextNode(text.slice(start, at)));
        const mark = element('mark', 'search-match', text.slice(at, at + term.length));
        fragment.append(mark); searchMatches.push(mark); start = from = at + term.length; matched = true;
      }
      if (!matched) continue;
      fragment.append(document.createTextNode(text.slice(start))); node.replaceWith(fragment);
    }
    if (!searchMatches.length) searchIndex = -1;
    else if (changed || searchIndex < 0) {
      const chip = numberQuery(term) ? searchMatches.findIndex(m => m.parentElement && m.parentElement.closest('.question-no')) : -1;
      searchIndex = chip >= 0 ? chip : 0;
    } else searchIndex = Math.min(searchIndex, searchMatches.length - 1);
    selectMatch(scroll);
  }
  function openSearch() {
    $('search-box').hidden = false; $('search-toggle').setAttribute('aria-expanded', 'true');
    $('search').focus(); $('search').select(); updateSearch(true); applyLayout();
  }
  function closeSearch() {
    $('search-box').hidden = true; $('search-toggle').setAttribute('aria-expanded', 'false');
    updateSearch(false); $('feed').focus(); applyLayout();
  }
  function moveMatch(direction) {
    updateSearch(false);
    if (searchMatches.length) {searchIndex = (searchIndex + direction + searchMatches.length) % searchMatches.length; selectMatch(true);}
  }
  $('search-toggle').onclick = () => $('search-box').hidden ? openSearch() : closeSearch();
  $('search').oninput = () => updateSearch(true);
  $('search').onkeydown = event => {
    if (event.key === 'Enter') {event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1);}
    if (event.key === 'Escape') {event.preventDefault(); closeSearch();}
  };
  $('search-prev').onclick = () => moveMatch(-1);
  $('search-next').onclick = () => moveMatch(1);
  $('search-close').onclick = closeSearch;
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {event.preventDefault(); openSearch();}
    if (event.key === 'Escape') {
      $('more-actions').hidden = true; $('more-toggle').setAttribute('aria-expanded', 'false');
      closeSnippets();
    }
  });
  $('more-toggle').onclick = () => {
    $('more-actions').hidden = !$('more-actions').hidden;
    $('more-toggle').setAttribute('aria-expanded', String(!$('more-actions').hidden));
  };
  $('creator').onclick = () => {
    $('more-actions').hidden = true;
    $('more-toggle').setAttribute('aria-expanded', 'false');
    if (!$('creator-dialog').open) $('creator-dialog').showModal();
  };
  $('creator-close').onclick = () => $('creator-dialog').close();
  document.addEventListener('click', event => {
    if (!event.target.closest('.more-menu')) {$('more-actions').hidden = true; $('more-toggle').setAttribute('aria-expanded', 'false');}
    if (!event.target.closest('.snippets-wrap') && !event.target.closest('#snippet-dialog')) closeSnippets();
  });
  const draftMin = 64, draftDefault = 88, draftCeiling = 4000, feedReserve = 72;
  function takeDraftHeight(source) {
    const n = source && source.draftHeight;
    if (typeof n !== 'number' || !Number.isFinite(n)) return;
    return Math.max(draftMin, Math.min(draftCeiling, Math.round(n)));
  }
  function boxHeight(id) {
    const node = $(id);
    if (!node || node.hidden) return 0;
    const box = node.getBoundingClientRect();
    return box && box.height > 0 ? box.height : 0;
  }
  // A pane that has not been measured yet reports height 0. Keep the absolute ceiling so a key still changes the saved height.
  // scrollHeight is the block's full content, so a max-height clamp does not make the buttons look shorter than they are.
  function draftSpace() {
    const pane = boxHeight('chat-pane');
    if (!pane) return {pane: 0, cap: draftCeiling, room: 0};
    const field = boxHeight('draft');
    const content = $('composer').scrollHeight || 0;
    const chrome = content > field ? content - field : 0;
    const bar = boxHeight('composer-divider') || 8;
    const room = Math.max(0, Math.floor(pane - boxHeight('search-box') - bar - feedReserve));
    return {pane, cap: Math.max(draftMin, room - chrome), room};
  }
  function shownDraftHeight() {
    const saved = layout.draftHeight === undefined ? draftDefault : layout.draftHeight;
    return Math.max(draftMin, Math.min(draftSpace().cap, saved));
  }
  function applyDraftHeight(space) {
    const box = space || draftSpace();
    const saved = layout.draftHeight === undefined ? draftDefault : layout.draftHeight;
    const shown = Math.max(draftMin, Math.min(box.cap, saved));
    $('draft').style.height = shown + 'px';
    const grip = $('composer-divider');
    grip.setAttribute('aria-valuenow', String(shown));
    grip.setAttribute('aria-valuemin', String(draftMin));
    grip.setAttribute('aria-valuemax', String(box.cap));
    if (box.pane) $('chat-pane').style.setProperty('--composer-cap', box.room + 'px');
  }
  // Typing calls renderOrder on every letter. Measure only when the block under the field changes height.
  let composerChrome = '';
  function composerChromeKey() {
    const lines = id => {
      const node = $(id);
      if (!node || node.hidden) return 0;
      const text = node.textContent || '';
      return text ? text.split('\n').length : 1;
    };
    const strip = $('order-strip');
    const files = $('attachments');
    return [
      lines('pass-hint'), lines('delta-hint'), lines('pause-hint'),
      strip && !strip.hidden ? strip.children.length : 0,
      files ? files.children.length : 0
    ].join(':');
  }
  function fitComposer() {
    const key = composerChromeKey();
    if (key === composerChrome) return;
    composerChrome = key;
    applyDraftHeight();
  }
  function applyLayout() {
    layout.width = Math.max(380, Math.min(600, layout.width));
    $('layout').classList.toggle('controls-left', layout.side === 'left');
    $('layout').style.setProperty('--controls-width', layout.width + 'px');
    $('panel-divider').setAttribute('aria-valuenow', String(layout.width));
    $('swap-panels').title = layout.side === 'right' ? 'Управление слева, переписка справа' : 'Переписка слева, управление справа';
    const agentsOpen = !layout.agentsFolded;
    $('agents-block').classList.toggle('folded', !agentsOpen);
    $('agents').hidden = !agentsOpen;
    $('agents-fold').setAttribute('aria-expanded', String(agentsOpen));
    $('queue-fold').setAttribute('aria-expanded', String(agentsOpen));
    $('agents-fold').title = agentsOpen ? 'Свернуть карточки агентов. Очередь займёт освободившуюся высоту.' : 'Развернуть карточки агентов';
    $('queue-fold').title = agentsOpen
      ? 'Свернуть агентов. Очередь займёт освободившуюся высоту.'
      : 'Развернуть агентов. Очередь снова уступит им высоту.';
    applyDraftHeight();
  }
  function saveLayout() {api.setState(draftValue()); post('layout', layout);}
  $('swap-panels').onclick = () => {layout.side = layout.side === 'left' ? 'right' : 'left'; applyLayout(); saveLayout();};
  const divider = $('panel-divider');
  divider.onpointerdown = event => {
    if (event.button !== 0 || draftDragging) return;
    event.preventDefault(); dragging = true; divider.setPointerCapture(event.pointerId);
    $('layout').classList.add('resizing');
  };
  divider.onpointermove = event => {
    if (!dragging) return;
    const rect = $('layout').getBoundingClientRect();
    const size = layout.side === 'right' ? rect.right - event.clientX : event.clientX - rect.left;
    layout.width = Math.round(Math.max(380, Math.min(600, rect.width - 330, size))); applyLayout();
  };
  function endResize() {if (!dragging) return; dragging = false; $('layout').classList.remove('resizing'); saveLayout();}
  divider.onpointerup = endResize; divider.onpointercancel = endResize; divider.onlostpointercapture = endResize;
  divider.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (layout.side === 'left' ? 1 : -1) * 20;
    layout.width = Math.max(380, Math.min(600, layout.width + delta)); applyLayout(); saveLayout();
  };
  const draftGrip = $('composer-divider');
  let draftStartY = 0, draftStartH = 0;
  draftGrip.onpointerdown = event => {
    if (event.button !== 0 || dragging || draftDragging) return;
    event.preventDefault();
    draftDragging = true;
    draftStartY = event.clientY;
    draftStartH = shownDraftHeight();
    draftGrip.setPointerCapture(event.pointerId);
    $('layout').classList.add('composer-resizing');
  };
  draftGrip.onpointermove = event => {
    if (!draftDragging) return;
    const next = Math.round(draftStartH + (draftStartY - event.clientY));
    if (!Number.isFinite(next)) return;
    const space = draftSpace();
    layout.draftHeight = Math.max(draftMin, Math.min(space.cap, next));
    applyDraftHeight(space);
  };
  function endDraftResize() {
    if (!draftDragging) return;
    draftDragging = false;
    $('layout').classList.remove('composer-resizing');
    saveLayout();
  }
  draftGrip.onpointerup = endDraftResize;
  draftGrip.onpointercancel = endDraftResize;
  draftGrip.onlostpointercapture = endDraftResize;
  draftGrip.ondblclick = () => {
    layout.draftHeight = draftDefault;
    applyLayout();
    saveLayout();
  };
  draftGrip.onkeydown = event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const space = draftSpace();
    const saved = layout.draftHeight === undefined ? draftDefault : layout.draftHeight;
    if (event.key === 'ArrowUp') {
      if (saved >= space.cap) return;
      layout.draftHeight = Math.min(space.cap, saved + 20);
    } else layout.draftHeight = Math.max(draftMin, Math.min(saved, space.cap) - 20);
    applyDraftHeight(space);
    saveLayout();
  };
  $('latest').onclick = () => {$('feed').scrollTop = $('feed').scrollHeight;};
  $('feed').onscroll = () => {$('latest').hidden = $('feed').scrollHeight - $('feed').scrollTop - $('feed').clientHeight < 90;};
  window.addEventListener('message', event => {
    const m = event.data;
    if (m.type === 'ping') {post('pong'); if (!initialized) post('ready'); return;}
    if (m.type === 'state') {
      const changed = snapshot && snapshot.state.conversationId !== m.state.conversationId;
      snapshot = m;
      if (m.layout && !dragging && !draftDragging) {
        layout = {...m.layout};
        const height = takeDraftHeight(layout);
        if (height === undefined) delete layout.draftHeight; else layout.draftHeight = height;
        applyLayout();
      }
      if (Object.prototype.hasOwnProperty.call(m, 'snippets')) {
        snippets = TrioComposer.normalizeSnippets(m.snippets);
        if (!$('snippets-panel').hidden) renderSnippetsList();
      }
      if (!initialized || changed) {
        const cached = api.getState();
        const draft = !changed && cached?.conversationId === m.state.conversationId ? cached : undefined;
        initialized = true; clearTimeout(draftTimer); snippetUndo = [];
        $('connection').hidden = true;
        $('draft').value = draft?.text ?? m.state.draft;
        responseOrder = draft?.responseOrder || m.state.responseOrder || [];
        if (!responseOrder.length) {const recipient = draft?.recipient || m.state.recipient; if (recipient && recipient !== 'all') responseOrder = [recipient];}
        if (!responseOrder.length) adoptMarksIfEmpty();
        if (changed) {droppedNote = ''; queuePassNotes = {};}
        attachments = draft?.attachments || m.state.draftAttachments || [];
        agentSignature = ''; queueSignature = '';
        render();
        api.setState(draftValue());
        if (changed) {$('search').value = ''; $('feed').scrollTop = 0;}
      }
      render();
    }
    if (m.type === 'ack' || m.type === 'error') {
      if (m.clientId && m.clientId !== clientId) return;
      if (m.type === 'error') {
        notice(m.text, true);
        if (!initialized) {$('connection').textContent = 'Не удалось восстановить разговор. Нажми ↻ для повтора.'; $('connection').className = 'connection error';}
      }
      const callback = requests.get(m.requestId); requests.delete(m.requestId);
      callback?.(m.type === 'error' ? m.text : undefined, m.data);
    }
  });
  window.addEventListener('error', event => {
    $('connection').hidden = false; $('connection').className = 'connection error';
    $('connection').textContent = 'Ошибка интерфейса: ' + event.message + '. Нажми ↻ для восстановления.';
  });
  const cachedLayout = api.getState()?.layout;
  if (cachedLayout && ['left', 'right'].includes(cachedLayout.side) && Number.isFinite(cachedLayout.width)) {
    layout = {side: cachedLayout.side, width: Math.max(260, Math.min(600, cachedLayout.width)),
      agentsFolded: cachedLayout.agentsFolded === true};
    const cachedHeight = takeDraftHeight(cachedLayout);
    if (cachedHeight !== undefined) layout.draftHeight = cachedHeight;
  }
  applyLayout();
  window.addEventListener('resize', () => {if (!$('snippets-panel').hidden) placeSnippetsPanel(); applyLayout();});
  api.setState(api.getState() || {});
  post('ready');
})();
