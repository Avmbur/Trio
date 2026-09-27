import {State, Provider, Recipient, Turn, Agent, Message, id, names, context, contextFit, afterMessage, addressed, assignedMode, stopTarget, fresh, Attachment, validAttachments, messageText, permissionClass, permissionSignature, permissionCaption, brief, questionNumber, normalizeInstruction, agentPromptPrefix} from '../shared/model';
import {Store} from '../storage/store';
import {ProjectLock} from '../processes/lock';
import {runProvider, RunOptions, RunResult, UsageReport, extractQuota} from '../providers/adapter';
import {QuestionItem, QuestionAnswers, answerLabels, questionKey} from '../shared/model';

export interface Host {
  root: string; lockBase: string; jobRunner: string;
  cli(p: Provider): Promise<string>; limit(): number; timeout(execute: boolean): number;
  ceiling(): number;
  notify?(kind: 'done' | 'permission', text: string): void;
  finished?(turn: Turn): Promise<void>;
  changed(): void; prepare(turn: Turn, signal: AbortSignal): Promise<string | undefined>; trusted(): boolean;
  compact(o: {provider: Provider; session: string; signal: AbortSignal}): Promise<void>;
  refreshQuota?(provider: Provider): Promise<void>;
  sessionIdle?(): number;
  sessionMaxTokens?(provider: Provider): number;
}
export interface Permission {id: string; provider: Provider; title: string; detail: string; standing: boolean; caption?: string}
export {brief};
type Runner = (o: RunOptions) => Promise<RunResult>;
function formatWindowTokens(n: number): string {
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}
function freshSessionDetail(stale: boolean, idle: number, tokens: number | undefined, maxTok: number): string {
  if (stale) {
    const minutes = Math.round(idle / 60000);
    return minutes >= 60 ? 'простой ' + Math.round(minutes / 60) + ' ч' : 'простой ' + minutes + ' мин';
  }
  return 'окно ' + formatWindowTokens(tokens || 0) + ' > ' + formatWindowTokens(maxTok);
}
export class Controller {
  active?: {provider: Provider; turnId: string};
  progress = '';
  permissions: Permission[] = [];
  private replies = new Map<string, (allow: boolean) => void>();
  private questions = new Map<string, (answers?: QuestionAnswers) => void>();
  private abort?: AbortController;
  private work?: Promise<void>;
  resetting = false;
  compacting?: Provider | 'all';
  private available() {if (this.resetting) throw new Error('Дождитесь завершения очистки разговора.');}
  private currentMessages() {
    const start = this.state.contextStart ? this.state.messages.findIndex(m => m.id === this.state.contextStart) + 1 : 0;
    return this.state.messages.slice(start).filter(m => !m.control);
  }
  private streamingSave?: ReturnType<typeof setTimeout>;
  get busy() {return !!this.active || !!this.compacting;}
  constructor(readonly state: State, readonly store: Store, readonly host: Host, private readonly runner: Runner = runProvider) {}
  async save() {await this.store.save(this.state); this.host.changed();}
  note(text: string, error = false, control = false, detail?: string, actions?: {title: string; detail?: string}[], turnId?: string) {
    this.state.messages.push({id: id(), author: 'Trio', text, at: Date.now(), error, control,
      ...(detail ? {detail} : {}), ...(actions && actions.length ? {actions} : {}), ...(turnId ? {turn: turnId} : {})});
  }
  deltaHints(): {provider: Provider; chars: number; messages: number; total: number; kind: 'delta' | 'full'; reason?: 'fresh' | 'compact'}[] {
    const current = messageText({text: this.state.draft, attachments: this.state.draftAttachments});
    const who = this.state.agents.filter(a => a.enabled).map(a => a.id);
    const usable = this.currentMessages().filter(m => !this.omitQuestion(m));
    const out: {provider: Provider; chars: number; messages: number; total: number; kind: 'delta' | 'full'; reason?: 'fresh' | 'compact'}[] = [];
    for (const id of who) {
      const agent = this.state.agents.find(a => a.id === id);
      if (!agent?.enabled) continue;
      const saved = this.state.sessions[id + ':' + agent.mode];
      const resume = saved?.project === this.host.root ? saved : undefined;
      const history = resume?.through ? afterMessage(usable, resume.through) : usable;
      let chars = current.length, shown = history.length;
      try {
        const fit = contextFit(history, current, this.host.limit(),
          {messages: this.state.messages, turns: this.state.turns});
        chars = fit.text.length; shown = fit.shown;
      } catch {chars = current.length;}
      const kind = resume?.through ? 'delta' : 'full';
      out.push({provider: id, chars, messages: shown, total: history.length, kind,
        reason: kind === 'delta' ? undefined : resume ? 'compact' : 'fresh'});
    }
    return out;
  }
  private omitQuestion(m: Message) {
    if (m.author !== 'Антон') return false;
    if (m.cancelled) return false;
    const group = this.state.turns.filter(t => t.messageId === m.id);
    return group.length > 0 && !group.some(t => t.executor);
  }
  // Keep later answers on the same question next to it, even if a new question
  // was typed into the feed while the first respondent was still working.
  private insertReply(source: Message, reply: Message) {
    const turnIds = new Set(this.state.turns.filter(t => t.messageId === source.id).map(t => t.id));
    let at = this.state.messages.findIndex(m => m.id === source.id);
    if (at < 0) {this.state.messages.push(reply); return;}
    at += 1;
    while (at < this.state.messages.length) {
      const m = this.state.messages[at];
      if ((m.turn && turnIds.has(m.turn)) || m.control) at++;
      else break;
    }
    this.state.messages.splice(at, 0, reply);
  }
  // Cleared at the end of every turn: a blanket approval never outlives the answer it was given for.
  private blanket = new Set<Provider>();
  // In-memory until Reload, context reset or a new conversation.
  private standing = new Map<Provider, Set<string>>();
  async recover() {
    let interrupted = false;
    for (const t of [...this.state.turns, ...this.state.tasks]) if (t.status === 'running' || t.status === 'preparing') {t.status = 'interrupted'; interrupted = true;}
    this.state.queue = this.state.queue.filter(x => this.state.turns.some(t => t.id === x && t.status === 'proposed'));
    let dropped = 0;
    for (const m of this.state.messages) if (m.question && !m.question.answered) {delete m.question; dropped++;}
    if (interrupted) this.note('Предыдущий запуск прерван закрытием VS Code. Ответы и изменения сохранены; повторного запуска нет.');
    if (dropped) this.note('Вопрос агента снят: окно закрыто.');
    await this.save();
  }
  async configure(agent: Agent) {
    this.available();
    const current = this.state.agents.find(a => a.id === agent.id)!;
    if (this.active?.provider === agent.id) throw new Error('Остановите участника перед изменением его настроек.');
    if (!agent.enabled && !this.state.agents.some(a => a.id !== agent.id && a.enabled)) throw new Error('Оставьте хотя бы одного участника.');
    Object.assign(current, {enabled: agent.enabled, mode: agent.mode, model: agent.model.trim(), effort: agent.effort});
    if ('instruction' in agent) {
      const instruction = normalizeInstruction(agent.instruction);
      if (instruction) current.instruction = instruction;
      else delete current.instruction;
    }
    await this.save();
  }
  async send(text: string, recipient: Recipient, responseOrder: Provider[] = [], attachments: Attachment[] = [], discuss = false) {
    this.available();
    if (!validAttachments(attachments)) throw new Error('Недопустимые вложения.');
    if (!text.trim() && !attachments.length) return;
    const promptText = messageText({text, attachments});
    if (promptText.length > this.host.limit()) throw new Error('Текст и вложения превышают лимит контекста Trio. Уменьшите вложения или увеличьте trio.contextChars.');
    const stop = attachments.length ? undefined : stopTarget(text);
    if (stop) {
      this.state.messages.push({id: id(), author: 'Антон', text, at: Date.now()});
      await this.stop(stop === 'all' ? undefined : stop); await this.save(); return;
    }
    if (!attachments.length && /^прочитал[.!]?$/iu.test(text.trim())) {
      this.state.messages.push({id: id(), author: 'Антон', text, at: Date.now()}); this.state.draft = ''; await this.save(); return;
    }
    const enabled = this.state.agents.filter(a => a.enabled);
    if (responseOrder.length > 3 || new Set(responseOrder).size !== responseOrder.length || responseOrder.some(p => !enabled.some(a => a.id === p))) throw new Error('Выберите включённых участников без повторов.');
    // Explicit numbered selection takes priority; without it normal chat addressing applies.
    recipient = responseOrder.length ? 'all' : addressed(text) || recipient;
    if (recipient !== 'all' && !enabled.some(a => a.id === recipient)) throw new Error(names[recipient] + ' выключен. Включите его карточку.');
    if (discuss && text.trim() && !/обсуждаем|код не трогать/iu.test(text)) {
      text = text.replace(/\s+$/u, '') + '\n\nобсуждаем, код не трогать';
    }
    const messageId = id();
    const recipients: Recipient[] = responseOrder.length ? responseOrder : [recipient];
    const inflight = [
      ...this.state.queue.map(qid => this.state.turns.find(t => t.id === qid)).filter((t): t is Turn => !!t),
      ...this.state.turns.filter(t => t.status === 'preparing' || t.status === 'running')
    ];
    const cycle = (!this.busy && this.state.queue.length === 0) ? 1
      : Math.max(0, ...inflight.map(t => t.cycle || 1)) + 1;
    const turns: Turn[] = recipients.map(p => ({id: id(), messageId, recipient: p, status: 'proposed' as const,
      cycle, ...(discuss ? {mode: 'discuss' as const} : {})}));
    this.state.messages.push({id: messageId, author: 'Антон', text, at: Date.now(),
      attachments: structuredClone(attachments), turn: turns[0].id});
    this.state.turns.push(...turns); this.state.queue.push(...turns.map(t => t.id));
    this.state.draft = ''; this.state.responseOrder = []; this.state.draftAttachments = [];
    const first = turns[0];
    const provider = first.recipient === 'all'
      ? (enabled.length === 1 || this.state.autoReply) ? enabled[0]?.id : undefined
      : first.recipient;
    if (!this.busy && provider) this.start(first, provider);
    await this.save();
  }
  async handoff(provider: Provider, turnId?: string) {
    this.available();
    if (this.busy) throw new Error('Сначала дождитесь ответа или нажмите «Стоп».');
    if (!this.state.agents.find(a => a.id === provider)?.enabled) throw new Error('Участник выключен.');
    let turn = turnId ? this.state.turns.find(t => t.id === turnId && t.status === 'proposed' && this.state.queue.includes(t.id)) : undefined;
    if (turnId && !turn) throw new Error('Это поручение уже запущено или снято с очереди.');
    if (turn && turn.recipient !== 'all' && turn.recipient !== provider) throw new Error('У поручения другой адресат.');
    if (turn) {
      const first = this.state.queue.map(x => this.state.turns.find(t => t.id === x)!).find(t => t.messageId === turn!.messageId);
      if (first?.id !== turn.id) throw new Error('Сначала дайте слово предыдущему участнику этого вопроса.');
    } else {
      // A click authorizes a run; it is not a fabricated human utterance.
      const source = this.currentMessages().filter(m => m.author === 'Антон' && this.state.turns.some(t => t.messageId === m.id)).at(-1);
      if (!source) throw new Error('Сначала напишите вопрос в текущем разговоре.');
      const pending = this.state.queue.map(x => this.state.turns.find(t => t.id === x)!).find(t => t.messageId === source.id);
      if (pending) {
        if (pending.recipient !== 'all' && pending.recipient !== provider) throw new Error('Следующий участник уже выбран в очереди.');
        turn = pending;
      } else {
        turn = {id: id(), messageId: source.id, recipient: provider, status: 'proposed', mode: 'discuss',
          cycle: this.state.turns.find(t => t.messageId === source.id)?.cycle};
        this.state.turns.push(turn);
      }
    }
    this.start(turn, provider); await this.save();
  }
  async retry(turnId: string) {
    this.available();
    if (this.busy) throw new Error('Сначала остановите агента или дождитесь его ответа.');
    const failed = this.state.turns.find(t => t.id === turnId);
    if (!failed || failed.status !== 'failed') throw new Error('Повторить можно только оборванный ход.');
    const provider = failed.executor || (failed.recipient !== 'all' ? failed.recipient : undefined);
    if (!provider || !this.state.agents.find(a => a.id === provider)?.enabled)
      throw new Error((provider ? names[provider] : 'Участник') + ' выключен.');
    if (!this.state.messages.some(m => m.id === failed.messageId)) throw new Error('Поручение не найдено.');
    const turn: Turn = {id: id(), messageId: failed.messageId, recipient: failed.recipient, status: 'proposed',
      mode: failed.mode, cycle: failed.cycle};
    this.state.turns.push(turn);
    this.start(turn, provider); await this.save();
  }
  async reset(mode: 'context' | 'conversation', provider?: Provider) {
    this.available();
    if (this.busy) throw new Error('Сначала остановите агента или дождитесь его ответа.');
    if (mode === 'context' && provider) {
      for (const key of Object.keys(this.state.sessions)) if (key.startsWith(provider + ':')) delete this.state.sessions[key];
      delete this.state.usage[provider];
      this.standing.delete(provider);
      this.note('Контекст сброшен для ' + names[provider] + '. Предыдущая переписка остаётся только в ленте.', false, true);
      await this.save();
      return;
    }
    this.resetting = true;
    const before = structuredClone(this.state);
    try {
      const archive = await this.store.archive(this.state);
      this.standing.clear();
      if (mode === 'conversation') {
        Object.assign(this.state, fresh(), {agents: before.agents, diagnostics: before.diagnostics});
        delete this.state.contextStart;
      } else {
        // New sessions start empty, so the reported occupancy no longer describes anything.
        this.state.sessions = {}; this.state.usage = {}; this.state.conversationId = id(); this.state.responseOrder = [];
        for (const turn of this.state.turns) if (turn.status === 'proposed') turn.status = 'interrupted';
        this.state.queue = [];
        const marker = {id: id(), author: 'Trio' as const, at: Date.now(), text: 'Контекст сброшен для всех участников. Предыдущая переписка остаётся только в ленте.', control: true};
        this.state.messages.push(marker); this.state.contextStart = marker.id;
      }
      await this.save(); return archive;
    } catch (error) {
      Object.assign(this.state, before);
      if (before.contextStart === undefined) delete this.state.contextStart;
      this.host.changed(); throw error;
    } finally {this.resetting = false;}
  }
  async compact(provider?: Provider) {
    this.available();
    if (this.busy) throw new Error('Сначала дождитесь ответа или нажмите «Стоп».');
    const targets = this.state.agents.filter(a => a.enabled && (!provider || a.id === provider));
    if (!targets.length) throw new Error('Включите участника, чтобы сжать его контекст.');
    const jobs = targets.flatMap(agent => Object.entries(this.state.sessions)
      .filter(([key, s]) => key.startsWith(agent.id + ':') && s.project === this.host.root)
      .map(([key, s]) => ({agent, key, session: s.id})));
    if (!jobs.length) throw new Error('Сжимать нечего: у выбранных участников ещё нет сессии в этом проекте.');
    this.compacting = provider || 'all';
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const failures: string[] = [];
    try {
      for (const job of jobs) {
        if (signal.aborted) break;
        this.progress = names[job.agent.id] + ': сжатие контекста';
        this.host.changed();
        try {
          await this.host.compact({provider: job.agent.id, session: job.session, signal});
          // The engine dropped part of its own history, so the delta cursor no longer
          // describes what it remembers: the next turn has to carry the whole feed again.
          delete this.state.sessions[job.key]?.through;
          const prev = this.state.usage[job.agent.id];
          if (prev) this.state.usage[job.agent.id] = {window: prev.window, source: 'compact', at: Date.now(), quota: prev.quota};
          this.note(names[job.agent.id] + ': контекст сжат движком. Лента Trio не изменилась.');
          this.host.changed();
        } catch (e) {
          if (signal.aborted) break;
          failures.push(names[job.agent.id] + ': ' + String(e));
        }
      }
    } finally {
      this.compacting = undefined; this.abort = undefined; this.progress = '';
      for (const failure of failures) this.note(failure, true);
      if (signal.aborted) this.note('Сжатие остановлено.');
      await this.save();
    }
    if (failures.length === jobs.length) throw new Error(failures[0]);
  }
  async discard(turnId: string) {
    this.available();
    const turn = this.state.turns.find(t => t.id === turnId && t.status === 'proposed');
    if (!turn) return;
    turn.status = 'interrupted'; this.state.queue = this.state.queue.filter(x => x !== turnId);
    const group = this.state.turns.filter(t => t.messageId === turn.messageId);
    if (!group.some(t => t.executor || t.status === 'proposed')) {
      const message = this.state.messages.find(m => m.id === turn.messageId);
      if (message) message.cancelled = true;
    }
    await this.save();
  }
  private start(turn: Turn, provider: Provider) {
    if (this.busy || turn.status !== 'proposed') return;
    const agent = {...this.state.agents.find(a => a.id === provider)!};
    const source = this.state.messages.find(m => m.id === turn.messageId)!;
    turn.executor = provider; turn.mode ??= assignedMode(source.text, agent.mode); turn.status = 'preparing';
    turn.startedAt = Date.now(); delete turn.endedAt;
    const instruction = normalizeInstruction(agent.instruction);
    if (instruction) turn.instruction = instruction;
    else delete turn.instruction;
    this.state.queue = this.state.queue.filter(x => x !== turn.id);
    this.active = {provider, turnId: turn.id}; this.abort = new AbortController();
    this.progress = names[provider] + ': подготовка';
    this.work = this.run(turn, agent, this.abort.signal).catch(e => {
      turn.status = this.abort?.signal.aborted ? 'interrupted' : 'failed';
      if (turn.status === 'failed') this.note(String(e), true, false, undefined, undefined, turn.id);
    }).finally(async () => {
      if (this.streamingSave) clearTimeout(this.streamingSave); this.streamingSave = undefined;
      if (!turn.endedAt) turn.endedAt = Date.now();
      if (turn.status === 'interrupted') this.note(names[provider] + ': остановлен' + (turn.replyId ? '. Частичный ответ сохранён.' : ' до получения ответа.'));
      if (turn.status === 'completed') this.host.notify?.('done', names[provider] + ' ответил');
      else if (turn.status === 'failed') this.host.notify?.('done', names[provider] + ': ошибка');
      for (const answer of this.replies.values()) answer(false);
      this.replies.clear(); this.permissions = []; this.blanket.clear();
      this.active = undefined; this.abort = undefined; this.progress = '';
      for (const ask of this.questions.values()) ask();
      this.questions.clear();
      try {
        await this.continueAuto(turn);
        await this.save();
      } catch (e) {this.state.diagnostics.push(String(e)); this.host.changed();}
    });
    this.host.changed();
  }
  async setFlags(flags: {autoReply?: boolean; autoEdits?: boolean; autoCommands?: boolean; autoActions?: boolean}) {
    if (flags.autoReply !== undefined) this.state.autoReply = flags.autoReply;
    if (flags.autoEdits !== undefined) this.state.autoEdits = flags.autoEdits;
    else if (flags.autoActions !== undefined) this.state.autoEdits = flags.autoActions;
    if (flags.autoCommands !== undefined) this.state.autoCommands = flags.autoCommands;
    await this.save();
  }
  private async continueAuto(done: Turn) {
    if (!this.state.autoReply || this.busy || this.resetting) return;
    if (done.status !== 'completed') return;
    const next = this.state.queue.map(id => this.state.turns.find(t => t.id === id))
      .find((t): t is Turn => !!t && t.status === 'proposed');
    if (!next) return;
    const provider = next.recipient === 'all'
      ? this.state.agents.find(a => a.enabled)?.id
      : next.recipient;
    if (!provider || !this.state.agents.find(a => a.id === provider)?.enabled) return;
    if ((next.cycle || 1) > 1 && next.cycle !== done.cycle) {
      const n = questionNumber(this.state.messages, this.state.turns, next.messageId);
      this.note('Автоответ: цикл ' + next.cycle + ' — вопрос #' + n + '. Отвечает ' + names[provider], false, true);
    }
    this.start(next, provider);
    await this.work;
  }
  private async run(turn: Turn, agent: Agent, signal: AbortSignal) {
    if (!this.host.trusted()) throw new Error('Запуск агентов доступен только в доверенном workspace.');
    const lock = await ProjectLock.for(this.host.root, this.host.lockBase);
    await lock.acquire();
    const key = agent.id + ':' + turn.mode;
    let compactedHere = false;
    try {
      if (signal.aborted) {turn.status = 'interrupted'; return;}
      const cli = await this.host.cli(agent.id);
      if (signal.aborted) {turn.status = 'interrupted'; return;}
      if (turn.mode === 'execute') {
        let cancel!: () => void;
        const cancelled = new Promise<undefined>(resolve => {cancel = () => resolve(undefined);});
        signal.addEventListener('abort', cancel, {once: true});
        try {turn.snapshot = await Promise.race([this.host.prepare(turn, signal), cancelled]);}
        finally {signal.removeEventListener('abort', cancel);}
        if (!turn.snapshot || signal.aborted) {turn.status = 'interrupted'; return;}
      }
      if (signal.aborted) {turn.status = 'interrupted'; return;}
      const source = this.state.messages.find(m => m.id === turn.messageId)!;
      const saved = this.state.sessions[key];
      let resume = saved?.project === this.host.root ? saved : undefined;
      const last = [...this.state.turns].reverse().find(t => t.executor === agent.id && t.endedAt);
      const idleMs = this.host.sessionIdle?.() || 0;
      const maxTok = this.host.sessionMaxTokens?.(agent.id) || 0;
      const idle = last?.endedAt ? Date.now() - last.endedAt : 0;
      const occupancy = this.state.usage[agent.id]?.tokens || 0;
      const fat = maxTok > 0 && occupancy > maxTok;
      const stale = idleMs > 0 && !!last?.endedAt && idle > idleMs;
      if (resume && (fat || stale)) {
        this.state.diagnostics.push(agent.id + ' fresh session: '
          + (stale ? 'idle ' + Math.round(idle / 60000) + ' min' : 'window ' + occupancy));
        this.note(names[agent.id] + ': новая сессия CLI (' + freshSessionDetail(stale, idle, occupancy, maxTok) + ')', false, true);
        delete this.state.sessions[key];
        const prev = this.state.usage[agent.id];
        // Keep the last occupancy on the bar. A dash is only for a real compact:
        // otherwise idle, a Trio reset and auto-compact all look the same.
        if (prev) this.state.usage[agent.id] = {tokens: prev.tokens, window: prev.window,
          source: 'fresh-session', at: Date.now(), quota: prev.quota};
        resume = undefined;
      }
      const usable = this.currentMessages().filter(m => m.id !== source.id && !this.omitQuestion(m));
      // A live session already holds earlier turns. Sending the whole Trio feed again
      // stacked the same text until the engine hit its compact threshold.
      const history = resume?.through ? afterMessage(usable, resume.through) : usable;
      const prompt = agentPromptPrefix(agent, turn.mode === 'execute' ? 'execute' : 'discuss') + '\n'
        + context(history, messageText(source), this.host.limit(),
          {messages: this.state.messages, turns: this.state.turns});
      this.state.diagnostics.push(agent.id + ' prompt: ' + prompt.length + ' символов, '
        + (resume?.through ? 'дельта' : 'полная лента')
        + (resume?.through ? ', through=' + resume.through : '')
        + ', история=' + history.length + ' сообщ.');
      this.state.diagnostics = this.state.diagnostics.slice(-100);
      const reply = {id: id(), author: names[agent.id], text: '', at: Date.now(), turn: turn.id, partial: true};
      this.insertReply(source, reply); turn.replyId = reply.id; turn.status = 'running'; await this.save();
      const result = await this.runner({provider: agent.id, cli, root: this.host.root, execute: turn.mode === 'execute', prompt,
        model: agent.model, effort: agent.effort, session: resume?.id,
        timeout: this.host.timeout(turn.mode === 'execute'), ceiling: this.host.ceiling(), signal, jobRunner: this.host.jobRunner,
        onPid: pid => lock.child(pid), onSession: async session => {
          const prev = this.state.sessions[key];
          this.state.sessions[key] = {id: session, project: this.host.root, profile: turn.mode!,
            ...(prev?.through ? {through: prev.through} : {})};
          await this.save();
        },
        text: text => {
          reply.text = text; this.host.changed();
          if (!this.streamingSave) this.streamingSave = setTimeout(() => {
            this.streamingSave = undefined; void this.save().catch(e => {this.state.diagnostics.push(String(e));});
          }, 400);
        },
        progress: text => {this.progress = text; this.host.changed();},
        trace: steps => {turn.trace = steps; this.host.changed();},
        usage: (report, source) => {
          if (report.spent !== undefined) turn.spent = report.spent;
          if (report.spentHint) turn.spentHint = report.spentHint;
          this.recordUsage(agent.id, report, source);
        },
        permission: (title, detail) => this.ask(agent.id, title, detail, signal),
        question: (items, questionSignal) => this.askUser(agent.id, items,
          questionSignal ? AbortSignal.any([signal, questionSignal]) : signal),
        notice: (title, detail) => this.note(names[agent.id] + ': метод не поддержан — ' + title, false, true, detail),
        compacted: () => {
          this.note(names[agent.id] + ': автосжатие контекста', false, true);
          // What the engine threw away it will never ask for again. The flag outlives this
          // callback because the cursor is written at the end of the turn: without it the
          // turn would put the cursor right back and the next prompt would stay a delta.
          compactedHere = true;
          delete this.state.sessions[key]?.through;
          const prev = this.state.usage[agent.id];
          if (prev) this.state.usage[agent.id] = {window: prev.window, source: 'auto-compact', at: Date.now(), quota: prev.quota};
          this.state.diagnostics.push(agent.id + ': auto-compact');
          this.host.changed();
        }
      });
      reply.text = result.text || reply.text; reply.partial = !!result.error || !!result.denied || result.interrupted || signal.aborted;
      if (result.denied) {
        turn.status = 'failed';
        this.note(names[agent.id] + ' остановился: не разрешили ' + result.denied, false, true, undefined, undefined, turn.id);
      } else {
        turn.status = result.interrupted || signal.aborted ? 'interrupted' : result.error ? 'failed' : 'completed';
        if (result.error) this.note(result.error, true, false, undefined, undefined, turn.id);
      }
      if (result.stderr) this.state.diagnostics.push(agent.id + ': ' + result.stderr);
      this.state.diagnostics = this.state.diagnostics.slice(-100);
    } finally {
      turn.endedAt = Date.now();
      // A failed startup did not produce an assistant message.
      const reply = this.state.messages.find(m => m.id === turn.replyId);
      if (reply && !reply.text.trim()) {
        this.state.messages = this.state.messages.filter(m => m.id !== reply.id);
        turn.replyId = undefined;
      }
      const live = this.state.sessions[key];
      // Only a surviving answer proves the engine received the prompt. A turn that died
      // on a limit left nothing, and moving the cursor would drop Anton's question.
      if (live && compactedHere) delete live.through;
      else if (live && turn.replyId) live.through = turn.replyId;
      await this.save();
      await lock.release();
      await this.host.finished?.(turn);
    }
    if (!signal.aborted && agent.id === 'claude')
      await this.host.refreshQuota?.('claude').catch(e => {
        this.state.diagnostics.push('claude quota: ' + String(e));
      });
  }
  // Only what the engine reported about its own window. Trio never estimates tokens,
  // and this is not the trio.contextChars limit on the shared feed.
  private recordUsage(provider: Provider, report: UsageReport, source: string) {
    let text: string;
    try {text = JSON.stringify(report.raw) ?? String(report.raw);} catch {text = String(report.raw);}
    let usage = '';
    try {
      const mu = report.raw && typeof report.raw === 'object'
        ? (report.raw as {modelUsage?: unknown; model_usage?: unknown}).modelUsage
          ?? (report.raw as {model_usage?: unknown}).model_usage : undefined;
      if (mu) usage = ' modelUsage=' + JSON.stringify(mu);
    } catch {usage = '';}
    const head = [
      report.tokens !== undefined ? 'tokens=' + report.tokens : '',
      report.window !== undefined ? 'window=' + report.window : '',
      report.spent !== undefined ? 'spent=' + report.spent : '',
      usage
    ].filter(Boolean).join(' ');
    this.state.diagnostics.push(provider + ' ' + source + ': ' + (head ? head + ' ' : '') + text.slice(0, 4000));
    this.state.diagnostics = this.state.diagnostics.slice(-100);
    const previous = this.state.usage[provider];
    const quota = extractQuota(report.raw, source, provider === 'codex' ? 'codex' : undefined) || previous?.quota;
    let tokens = report.tokens;
    const window = report.window;
    // Last-turn Grok/Claude figures bounce. Keep the peak until compact or a fresh
    // session so the bar fills toward auto-compact instead of jumping 61% → 49%.
    const holdPeak = provider !== 'codex' && previous?.source !== 'fresh-session' && previous?.source !== 'auto-compact';
    if (holdPeak && tokens !== undefined && previous?.tokens !== undefined && tokens < previous.tokens) tokens = previous.tokens;
    if (tokens === undefined && window === undefined && !quota) return;
    let occupancySource = previous?.source || source;
    if (tokens !== undefined) occupancySource = source;
    else if (window !== undefined && previous?.tokens === undefined) occupancySource = source;
    this.state.usage[provider] = {tokens: tokens ?? previous?.tokens, window: window ?? previous?.window,
      source: occupancySource, at: Date.now(), quota};
    this.host.changed();
  }
  rememberQuota(provider: Provider, account: unknown) {
    const quota = extractQuota(account, 'usage', provider === 'codex' ? 'codex' : undefined);
    if (!quota) return;
    const previous = this.state.usage[provider];
    this.state.usage[provider] = {tokens: previous?.tokens, window: previous?.window,
      source: previous?.source || 'usage', at: Date.now(), quota};
    this.host.changed();
  }
  private executeMode(provider: Provider): boolean {
    const turn = this.state.turns.find(t => t.id === this.active?.turnId);
    return (turn?.mode || this.state.agents.find(a => a.id === provider)?.mode) === 'execute';
  }
  private autoAllow(title: string, detail: string, provider: Provider): boolean {
    const cls = permissionClass(title, detail);
    if (cls === 'read') return !!(this.state.autoEdits || this.state.autoCommands);
    if (cls === 'edit') return !!this.state.autoEdits && this.executeMode(provider);
    if (cls === 'command') return !!this.state.autoCommands && this.executeMode(provider);
    return false;
  }
  private ask(provider: Provider, title: string, detail: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.autoAllow(title, detail, provider)) {
      this.appendAuto(provider, title, detail);
      return Promise.resolve(true);
    }
    if (this.blanket.has(provider)) {
      this.appendAction(provider, title, detail);
      return Promise.resolve(true);
    }
    const signature = permissionSignature(title, detail);
    const cls = permissionClass(title, detail);
    if (cls !== 'danger' && signature && this.standing.get(provider)?.has(signature)) {
      this.appendStanding(provider, title, detail);
      return Promise.resolve(true);
    }
    const requestId = id();
    return new Promise(resolve => {
      const finish = (allow: boolean) => {
        signal.removeEventListener('abort', cancel); this.replies.delete(requestId);
        this.permissions = this.permissions.filter(p => p.id !== requestId); this.host.changed(); resolve(allow);
      };
      const cancel = () => finish(false);
      this.replies.set(requestId, finish);
      if (!this.permissions.length) this.host.notify?.('permission', names[provider] + ' ждёт разрешения');
      this.permissions.push({id: requestId, provider, title, detail, caption: permissionCaption(title, detail),
        standing: cls !== 'danger' && !!signature});
      signal.addEventListener('abort', cancel, {once: true}); this.host.changed();
    });
  }
  permission(requestId: string, allow: boolean, whole = false, standing = false) {
    const answer = this.replies.get(requestId); if (!answer) return;
    const p = this.permissions.find(p => p.id === requestId)!;
    const signature = permissionSignature(p.title, p.detail);
    const cls = permissionClass(p.title, p.detail);
    // A click is Anton's decision, not his utterance. Whole-turn keeps one row and lists every later tool in it.
    if (allow && standing && cls !== 'danger' && signature) {
      const set = this.standing.get(p.provider) || new Set<string>();
      set.add(signature); this.standing.set(p.provider, set);
      this.appendStanding(p.provider, p.title, p.detail);
    } else if (allow && whole) {
      this.note('Разрешено до конца хода: ' + names[p.provider], false, true, undefined,
        [{title: brief(p.title), detail: p.detail}]);
      this.blanket.add(p.provider);
    } else {
      this.note((allow ? 'Разрешено один раз' : 'Отказано') + ': ' + names[p.provider] + ' · ' + brief(p.title), false, true, p.detail);
    }
    answer(allow); void this.save().catch(e => {this.state.diagnostics.push(String(e));});
  }
  private appendStanding(provider: Provider, title: string, detail: string) {
    const item = {title: brief(title), detail};
    const label = 'Разрешено до конца разговора: ' + names[provider];
    const last = [...this.state.messages].reverse().find(m => m.control && m.text === label);
    if (last) last.actions = [...(last.actions || []), item];
    else this.note(label, false, true, undefined, [item]);
    this.host.changed(); void this.save().catch(e => {this.state.diagnostics.push(String(e));});
  }
  private appendAuto(provider: Provider, title: string, detail: string) {
    const item = {title: brief(title), detail};
    const label = (permissionClass(title, detail) === 'command' ? 'Автокоманды: ' : 'Автоправки: ') + names[provider];
    const last = [...this.state.messages].reverse().find(m => m.control && m.text === label);
    if (last) last.actions = [...(last.actions || []), item];
    else this.note(label, false, true, undefined, [item]);
    this.host.changed(); void this.save().catch(e => {this.state.diagnostics.push(String(e));});
  }
  private async askUser(provider: Provider, items: QuestionItem[],
    signal: AbortSignal): Promise<QuestionAnswers | undefined> {
    if (signal.aborted) return undefined;
    if (!items.length) {
      this.note(names[provider] + ' задал пустой вопрос', false, true);
      await this.save().catch(e => {this.state.diagnostics.push(String(e));});
      return undefined;
    }
    const requestId = id();
    const text = items.map(q => q.prompt).join('\n');
    const card = {id: id(), author: names[provider], text, at: Date.now(), turn: this.active?.turnId,
      question: {id: requestId, items}};
    const source = this.state.messages.find(m => m.id === this.state.turns.find(t => t.id === this.active?.turnId)?.messageId);
    if (source) this.insertReply(source, card); else this.state.messages.push(card);
    return new Promise(resolve => {
      const finish = (answers?: QuestionAnswers) => {
        if (!answers) {delete (card as Message).question; this.host.changed();}
        signal.removeEventListener('abort', cancel); this.questions.delete(requestId); resolve(answers);
      };
      const cancel = () => finish(undefined);
      this.questions.set(requestId, finish);
      signal.addEventListener('abort', cancel, {once: true});
      this.host.notify?.('permission', names[provider] + ' ждёт ответа на вопрос');
      this.host.changed();
      void this.save().catch(e => {this.state.diagnostics.push(String(e));});
    });
  }
  answer(requestId: string, answers: QuestionAnswers) {
    const ask = this.questions.get(requestId); if (!ask) return;
    const card = this.state.messages.find(m => m.question?.id === requestId);
    answers = Object.fromEntries((card?.question?.items || []).map(item => [questionKey(item), answerLabels(answers[questionKey(item)])])
      .filter(([, value]) => (value as string[]).length));
    if (!Object.keys(answers).length) {
      if (card) delete card.question;
      ask(undefined); void this.save().catch(e => {this.state.diagnostics.push(String(e));}); return;
    }
    // No second post from Anton: the card keeps the answer, and messageText puts it
    // into the prompt and the export, so nothing is said twice in the feed.
    if (card?.question) card.question = {...card.question, answered: Object.fromEntries(Object.entries(answers)
      .map(([key, value]) => [key, card.question?.items.find(q => questionKey(q) === key)?.secret ? ['[скрыто]'] : value]))};
    ask(answers); void this.save().catch(e => {this.state.diagnostics.push(String(e));});
  }
  private appendAction(provider: Provider, title: string, detail: string) {
    const item = {title: brief(title), detail};
    const last = [...this.state.messages].reverse().find(m => m.control && m.text === 'Разрешено до конца хода: ' + names[provider]);
    if (last) last.actions = [...(last.actions || []), item];
    else this.note('Разрешено до конца хода: ' + names[provider], false, true, undefined, [item]);
    this.host.changed(); void this.save().catch(e => {this.state.diagnostics.push(String(e));});
  }
  async stop(provider?: Provider) {
    if (this.compacting) {this.abort?.abort(); return;}
    if (provider && this.active?.provider !== provider) return;
    if (!provider) this.state.autoReply = false;
    this.abort?.abort(); await this.work;
    if (!provider) await this.save();
  }
  async idle() {await this.work;}
}
