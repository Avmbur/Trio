const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../webview/preview-model.js');

test('everyone requires choosing a speaker; finishing never starts the next agent', () => {
  const s = M.fresh();
  M.send(s, 'Как лучше сделать?', 'all');
  assert.equal(s.active, null);
  assert.ok(s.pending);
  M.handoff(s, 'claude');
  assert.equal(s.active.agentId, 'claude');
  const reply = s.active.replyId;
  M.chunk(s, reply, 'Ответ');
  M.finish(s, reply);
  assert.equal(s.active, null);
  assert.equal(s.pending, null);
  assert.equal(s.messages.at(-1).text, 'Ответ');
  M.send(s, 'прочитал', 'codex');
  assert.equal(s.active, null);
  M.handoff(s, 'codex');
  assert.equal(s.active.agentId, 'codex');
  assert.equal(s.messages.at(-2).author, 'human');
});

test('one, two and three participants; disabled agents never start', () => {
  const s = M.fresh();
  assert.equal(M.enabled(s).length, 2);
  M.toggle(s, 'grok', true);
  assert.equal(M.enabled(s).length, 3);
  M.toggle(s, 'claude', false); M.toggle(s, 'codex', false);
  assert.equal(M.enabled(s).length, 1);
  M.toggle(s, 'grok', false);
  assert.equal(M.enabled(s).length, 1);
  M.send(s, 'Колян, ответь', 'all');
  assert.equal(s.active, null);
  M.send(s, 'Обсудим задачу', 'all');
  assert.equal(s.active.agentId, 'grok');
});

test('individual stop affects only the addressed participant; cancelled stream cannot resume', () => {
  const s = M.fresh();
  M.send(s, 'Жека, посмотри', 'claude');
  assert.equal(s.active.agentId, 'codex');
  const reply = s.active.replyId;
  M.chunk(s, reply, 'Начало');
  M.stop(s, 'claude');
  assert.equal(s.active.replyId, reply);
  M.send(s, 'Жека, стоп', 'all');
  assert.equal(s.active, null);
  M.chunk(s, reply, 'Не должно добавиться');
  M.finish(s, reply);
  const partial = s.messages.find(m => m.id === reply);
  assert.equal(partial.text, 'Начало');
  assert.equal(partial.partial, true);
});

test('messages received while busy stay queued after the reply; a new human handoff is required', () => {
  const s = M.fresh();
  M.send(s, 'Колян, ответь', 'claude');
  const first = s.active.replyId;
  M.send(s, 'Жека, проверь', 'codex');
  const queued = s.messages.at(-1);
  assert.equal(queued.queued, true);
  assert.equal(s.active.replyId, first);
  M.finish(s, first);
  assert.equal(s.active, null);
  assert.equal(queued.queued, true);
  M.handoff(s, 'codex', queued.id);
  assert.equal(s.active.agentId, 'codex');
  assert.equal(queued.queued, false);
  assert.equal(s.messages.at(-2).author, 'human');
});

test('stop everyone cancels pending permission, preserves history and does not start an agent', () => {
  const s = M.fresh();
  M.send(s, 'Общий вопрос', 'all');
  const pending = s.pending;
  M.send(s, 'оба стоп', 'all');
  assert.equal(s.pending, null);
  assert.equal(s.active, null);
  assert.ok(s.messages.find(m => m.id === pending));
});

test('blank messages do nothing; quotes are not execution or stop commands', () => {
  const s = M.fresh();
  const count = s.messages.length;
  M.send(s, '  \n  ', 'claude');
  assert.equal(s.messages.length, count);
  M.send(s, 'Колян, объясни', 'all');
  const reply = s.active.replyId;
  M.send(s, 'Он написал «Колян, стоп».', 'all');
  assert.equal(s.active.replyId, reply);
});
