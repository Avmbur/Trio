/* Shared composer helpers for the webview and tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrioComposer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const snippetLimits = {count: 40, name: 80, text: 20000, id: 64};
  const snippetWho = {claude: 'Колян', codex: 'Жека', grok: 'Гриха'};
  const providers = ['claude', 'codex', 'grok'];
  function addAttachment(existing, attachment) {
    const normalize = value => value.replace(/\r\n/g, '\n');
    if (existing.some(a => a.id === attachment.id || a.label === attachment.label && normalize(a.text) === normalize(attachment.text)))
      return {attachments: existing, added: false};
    if (existing.length >= 8 || existing.reduce((n, a) => n + a.text.length, attachment.text.length) > 200000)
      throw new Error('Не больше 8 вложений и 200 000 символов. Уменьши фрагмент.');
    return {attachments: [...existing, attachment], added: true};
  }
  function snippetId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function trimName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().slice(0, snippetLimits.name);
  }
  function orderOf(value) {
    if (!Array.isArray(value)) return [];
    const order = [];
    for (const item of value)
      if (providers.includes(item)) order.push(item);
    return order.slice(0, 10);
  }
  function normalizeFlags(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const flags = {};
    let any = false;
    if (typeof raw.autoEdits === 'boolean') {flags.autoEdits = raw.autoEdits; any = true;}
    if (typeof raw.autoCommands === 'boolean') {flags.autoCommands = raw.autoCommands; any = true;}
    if (typeof raw.discuss === 'boolean') {flags.discuss = raw.discuss; any = true;}
    if (Array.isArray(raw.responseOrder)) {flags.responseOrder = orderOf(raw.responseOrder); any = true;}
    return any ? flags : undefined;
  }
  function normalizeSnippet(raw) {
    if (!raw || typeof raw !== 'object') return;
    const id = typeof raw.id === 'string' && new RegExp('^[A-Za-z0-9_-]{1,' + snippetLimits.id + '}$').test(raw.id) ? raw.id : '';
    const name = trimName(raw.name);
    const text = typeof raw.text === 'string' ? raw.text.replace(/\r\n/g, '\n') : '';
    if (!id || !name || !text.trim() || text.length > snippetLimits.text) return;
    const snippet = {id, name, text};
    const flags = normalizeFlags(raw.flags);
    if (flags) snippet.flags = flags;
    return snippet;
  }
  function normalizeSnippets(value) {
    if (!Array.isArray(value)) return [];
    const out = [], seen = new Set();
    for (const raw of value) {
      if (out.length >= snippetLimits.count) break;
      const snippet = normalizeSnippet(raw);
      if (!snippet || seen.has(snippet.id)) continue;
      seen.add(snippet.id);
      out.push(snippet);
    }
    return out;
  }
  function insertAtCursor(value, start, end, insertion) {
    const text = String(value || '');
    const insert = String(insertion || '');
    const from = Math.max(0, Math.min(Number.isFinite(start) ? start : text.length, text.length));
    const to = Math.max(from, Math.min(Number.isFinite(end) ? end : from, text.length));
    return {value: text.slice(0, from) + insert + text.slice(to), caret: from + insert.length};
  }
  function filterSnippets(list, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(s => s.name.toLowerCase().includes(q) || s.text.toLowerCase().includes(q));
  }
  function snippetCreateSource(draft, filter) {
    const fromDraft = String(draft || '');
    if (fromDraft.trim()) return {text: fromDraft, name: ''};
    const fromFilter = String(filter || '');
    if (fromFilter.trim()) return {text: fromFilter, name: trimName(fromFilter)};
    return {text: '', name: ''};
  }
  function snippetUndoPush(stack, before, after, caret) {
    if (before === after) return stack;
    const point = Math.max(0, Math.min(Number.isFinite(caret) ? caret : 0, String(before).length));
    const next = (Array.isArray(stack) ? stack : []).concat([{before: String(before), after: String(after), caret: point}]);
    return next.length > 40 ? next.slice(-40) : next;
  }
  function snippetUndoApply(stack, current) {
    if (!Array.isArray(stack) || !stack.length) return {stack: stack || [], value: current, caret: 0, applied: false};
    const last = stack[stack.length - 1];
    if (!last || current !== last.after) return {stack, value: current, caret: last ? last.caret : 0, applied: false};
    return {stack: stack.slice(0, -1), value: last.before, caret: last.caret, applied: true};
  }
  function captureFlags(state) {
    return {
      autoEdits: !!state.autoEdits,
      autoCommands: !!state.autoCommands,
      discuss: !!state.discuss,
      responseOrder: orderOf(state.responseOrder)
    };
  }
  function flagsActive(flags) {
    return !!(flags && (flags.autoEdits || flags.autoCommands || flags.discuss || flags.responseOrder && flags.responseOrder.length));
  }
  function flagsHint(flags) {
    if (!flags) return '';
    const parts = [];
    if (flags.autoEdits) parts.push('+правки');
    if (flags.autoCommands) parts.push('+команды');
    if (flags.discuss) parts.push('Обсуждаем');
    if (flags.responseOrder && flags.responseOrder.length)
      parts.push(flags.responseOrder.map(p => snippetWho[p]).filter(Boolean).join(' → '));
    return 'флаги: ' + (parts.join(', ') || 'выключены');
  }
  function upsertSnippet(list, snippet) {
    const nextItem = normalizeSnippet(snippet);
    if (!nextItem) return list;
    const index = list.findIndex(s => s.id === nextItem.id);
    if (index < 0) return list.length >= snippetLimits.count ? list : list.concat(nextItem);
    const next = list.slice();
    next[index] = nextItem;
    return next;
  }
  function removeSnippet(list, id) {
    return list.filter(s => s.id !== id);
  }
  function duplicateSnippet(list, id) {
    if (list.length >= snippetLimits.count) return list;
    const index = list.findIndex(s => s.id === id);
    if (index < 0) return list;
    const copy = normalizeSnippet({...list[index], id: snippetId(), name: trimName(list[index].name + ' копия')});
    if (!copy) return list;
    const next = list.slice();
    next.splice(index + 1, 0, copy);
    return next;
  }
  function moveSnippet(list, fromId, toId) {
    if (fromId === toId) return list;
    const from = list.findIndex(s => s.id === fromId);
    const to = list.findIndex(s => s.id === toId);
    if (from < 0 || to < 0) return list;
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }
  return {
    addAttachment, snippetLimits, snippetId, trimName, normalizeSnippet, normalizeSnippets,
    insertAtCursor, filterSnippets, snippetCreateSource, snippetUndoPush, snippetUndoApply,
    captureFlags, flagsActive, flagsHint,
    upsertSnippet, removeSnippet, duplicateSnippet, moveSnippet
  };
});
