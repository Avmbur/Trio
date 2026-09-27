(function (root) {
  'use strict';
  let counter = 0;
  const id = () => Date.now().toString(36) + '-' + (++counter);
  const people = [
    { id: 'claude', name: 'Колян', provider: 'Claude Code', enabled: true },
    { id: 'codex', name: 'Жека', provider: 'Codex', enabled: true },
    { id: 'grok', name: 'Гриха', provider: 'Grok', enabled: false }
  ];
  function fresh() {
    return {
      version: 1,
      agents: people.map(p => ({ ...p, model: 'По умолчанию', effort: 'По умолчанию', mode: 'Обсуждение' })),
      recipient: 'all', draft: '', active: null, pending: null, notice: '',
      messages: [
        { id: 'example-1', author: 'human', text: 'Колян, как организуем общий разговор?', sample: true },
        { id: 'example-2', author: 'claude', text: 'Одна переписка для всех. Каждый видит обсуждение и получает слово от тебя. Исполнителя назначаешь прямо в сообщении.', sample: true },
        { id: 'example-3', author: 'human', text: 'Прочитал. Жека, что важно предусмотреть?', sample: true },
        { id: 'example-4', author: 'codex', text: 'Отдельную остановку каждого участника и общую кнопку «Стоп всем». После моего ответа следующий участник ждёт тебя.\n\nПопробуй написать сообщение, передать слово или подключить Гриху.', sample: true }
      ]
    };
  }
  function enabled(s) { return s.agents.filter(a => a.enabled); }
  function person(s, key) { return s.agents.find(a => a.id === key); }
  function say(s, text) {
    const message = { id: id(), author: 'human', text };
    s.messages.push(message);
    return message;
  }
  function start(s, key, source) {
    const a = person(s, key);
    if (s.active || !a || !a.enabled) return false;
    const message = { id: id(), author: key, text: '', sample: true };
    source.queued = false;
    s.messages.push(message);
    s.active = { agentId: key, replyId: message.id, sourceId: source.id };
    s.pending = null;
    s.notice = '';
    return true;
  }
  function stop(s, key = 'all') {
    if (s.active && (key === 'all' || s.active.agentId === key)) {
      const reply = s.messages.find(m => m.id === s.active.replyId);
      reply.partial = true;
      if (!reply.text) reply.text = 'Демонстрационный ответ остановлен до появления текста.';
      s.active = null;
      s.notice = 'Остановлено. Слово у тебя; продолжение только по твоей команде.';
    }
    if (key === 'all') {
      s.pending = null;
      s.notice = 'Все остановлены. Сообщения сохранены, автоматического продолжения нет.';
    }
  }
  function send(s, raw, target = s.recipient) {
    const text = raw.trim();
    if (!text) return;
    s.draft = '';
    const source = say(s, text);
    const mentioned = s.agents.find(a => new RegExp('^@?' + a.name + '(?:\\s|[,!:])', 'iu').test(text));
    if (/^(?:(?:все|всем|оба|обоим)\s+стоп|стоп\s+(?:все|всем|оба|обоим)|стоп)[.!]?$/iu.test(text)) {
      stop(s); return;
    }
    if (mentioned && new RegExp('^@?' + mentioned.name + '[,!:]?\\s+стоп[.!]?$', 'iu').test(text)) {
      stop(s, mentioned.id); return;
    }
    if (/^прочитал[.!]?$/iu.test(text)) {
      s.notice = 'Прочтение отмечено. Выбери, кому передать слово.';
      return;
    }
    if (mentioned) target = mentioned.id;
    if (s.active) {
      source.queued = true;
      source.target = target;
      s.notice = 'Сообщение сохранено. После ответа ты решишь, передавать ли его агенту.';
      return;
    }
    const a = person(s, target);
    if (a && !a.enabled) {
      source.queued = true; source.target = target;
      s.notice = a.name + ' отключён. Подключи участника или выбери другого.';
      return;
    }
    if (target === 'all') {
      if (enabled(s).length === 1) start(s, enabled(s)[0].id, source);
      else {
        source.queued = true;
        s.pending = source.id;
        s.notice = 'Сообщение адресовано всем. Выбери, кто ответит первым.';
      }
    } else if (a) start(s, target, source);
  }
  function handoff(s, key, sourceId) {
    if (s.active || !person(s, key)?.enabled) return;
    const pending = s.messages.find(m => m.id === (sourceId || s.pending));
    if (pending) {
      say(s, person(s, key).name + ', ответь на сообщение выше.');
      start(s, key, pending);
    } else {
      const text = s.draft.trim();
      send(s, text || ('Прочитал. ' + person(s, key).name + ', продолжай.'), key);
    }
  }
  function toggle(s, key, value) {
    const a = person(s, key);
    if (!a) return;
    if (!value && a.enabled && enabled(s).length === 1) {
      s.notice = 'В разговоре нужен хотя бы один участник.'; return;
    }
    if (!value) stop(s, key);
    a.enabled = value;
    if (!value && s.recipient === key) s.recipient = 'all';
    s.notice = a.name + (value ? ' подключён к макету. Ждёт твоего обращения.' : ' отключён от разговора.');
  }
  function chunk(s, replyId, text) {
    if (s.active?.replyId !== replyId) return;
    const message = s.messages.find(m => m.id === replyId);
    if (message) message.text += text;
  }
  function finish(s, replyId) {
    if (s.active?.replyId !== replyId) return;
    s.active = null;
    s.notice = 'Ответ закончен. Слово у тебя.';
  }
  const api = { fresh, enabled, person, send, handoff, stop, toggle, chunk, finish };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrioPreview = api;
})(globalThis);
