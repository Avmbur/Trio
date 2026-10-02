import {randomUUID} from 'node:crypto';

export const providers = ['claude', 'codex', 'grok'] as const;
export type Provider = typeof providers[number];
export type Recipient = Provider | 'all';
export type Mode = 'discuss' | 'execute';
export type Status = 'proposed' | 'preparing' | 'running' | 'completed' | 'failed' | 'interrupted';
export const names = {claude: 'Колян', codex: 'Жека', grok: 'Гриха'} as const;
export const id = () => randomUUID();
export const instructionLimit = 1000;
export interface Agent {id: Provider; enabled: boolean; mode: Mode; model: string; effort: string; instruction?: string}
export function normalizeInstruction(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim().slice(0, instructionLimit);
}
export function agentPromptPrefix(agent: Agent, mode: Mode): string {
  const lines = [
    'Ты ' + names[agent.id] + ', участник общего чата Trio. Отвечай по-русски. Переписка общая. Выполни только текущее поручение; другим участникам слово передаёт Антон. Не запускай других агентов и не делай автоматических коммитов или откатов.',
    mode === 'execute'
      ? 'Разрешена работа с кодом в рамках поручения. В конце сообщи результат и проверки.'
      : 'Сейчас обсуждение и чтение кода. Не изменяй файлы и не запускай команды с побочными эффектами.'
  ];
  const instruction = normalizeInstruction(agent.instruction);
  if (instruction) lines.push(instruction);
  return lines.join('\n');
}
// "Твой проход — 1 из 3. Выполни задание этого прохода, учитывая общие указания сообщения."
// The place is frozen at send. The total is the greater of the chips and the marks in
// the text, so a spare [Проход 3 из 3: ?] is not told as «из 2». Square brackets are
// not used here. They belong only to draft marks, see passMarks.
export function passLine(turn: Turn, turns: Turn[], text = ''): string {
  if (!turn.pass) return '';
  const siblings = turns.filter(t => t.messageId === turn.messageId && t.pass);
  const marked = passMarks(text);
  const total = Math.max(passSpan(marked, siblings.length), siblings.reduce((max, item) => Math.max(max, item.pass || 0), 0));
  if (total < 2) return '';
  return 'Твой проход — ' + turn.pass + ' из ' + total
    + '. Выполни задание этого прохода, учитывая общие указания сообщения.';
}
// A pass mark is a whole line: [Проход N из M: Имя], N and M from 1 to 10,
// names Колян, Жека, Гриха. Trio itself writes ? when a mark has no assignee.
export interface PassMark {pass: number; total: number; name: string; line: number}
const passMarkRe = /^\[Проход ([1-9]|10) из ([1-9]|10): (Колян|Жека|Гриха|\?)\]$/;
const markProvider: Record<string, Provider> = {Колян: 'claude', Жека: 'codex', Гриха: 'grok'};
export function passMarks(text: string): PassMark[] {
  const marks: PassMark[] = [];
  String(text ?? '').split('\n').forEach((raw, line) => {
    const match = raw.replace(/\r$/, '').match(passMarkRe);
    if (match) marks.push({pass: Number(match[1]), total: Number(match[2]), name: match[3], line});
  });
  return marks;
}
// M is the greater of how many marks there are, how many chips there are, and the
// highest pass number written in a mark.
export function passSpan(marks: readonly PassMark[], chips: number): number {
  const highest = marks.reduce((max, mark) => Math.max(max, mark.pass), 0);
  return Math.max(marks.length, chips, highest);
}
// Chip N is pass N. A ? or a missing number does not pull the next name forward:
// only the uninterrupted run from pass 1 becomes chips.
export function providersFromMarks(text: string): Provider[] {
  const slots: (Provider | undefined)[] = [];
  for (const mark of passMarks(text)) {
    const provider = markProvider[mark.name];
    if (provider) slots[mark.pass - 1] = provider;
  }
  const order: Provider[] = [];
  for (const provider of slots) {
    if (!provider) break;
    order.push(provider);
  }
  return order;
}
function passWho(order: readonly Provider[], pass: number): string {
  const provider = order[pass - 1];
  return provider ? names[provider] : '?';
}
function passMarkLine(pass: number, total: number, who: string): string {
  return '[Проход ' + pass + ' из ' + total + ': ' + who + ']';
}
function rewritePassLines(text: string, order: readonly Provider[]): string {
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
function appendPassMarks(text: string, order: readonly Provider[], from: number, to: number): string {
  const blocks = [];
  for (let pass = from; pass <= to; pass++) blocks.push(passMarkLine(pass, Math.max(order.length, to), passWho(order, pass)));
  const skeleton = blocks.join('\n\n') + '\n';
  const base = String(text ?? '').replace(/[ \t]+$/g, '').replace(/\n+$/g, '');
  return base ? base + '\n\n' + skeleton : skeleton;
}
function passRegions(text: string): {lines: string[]; marks: {pass: number; line: number}[]} {
  const lines = String(text ?? '').split('\n');
  const marks: {pass: number; line: number}[] = [];
  lines.forEach((raw, line) => {
    const match = raw.replace(/\r$/, '').match(passMarkRe);
    if (match) marks.push({pass: Number(match[1]), line});
  });
  return {lines, marks};
}
function regionEmpty(lines: string[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (lines[i].replace(/\r$/, '').trim()) return false;
  return true;
}
function stripTrailingEmptyMark(text: string, chips: number): string {
  let current = text;
  while (true) {
    const {lines, marks} = passRegions(current);
    const last = marks[marks.length - 1];
    if (!last || last.pass <= chips || !regionEmpty(lines, last.line + 1, lines.length)) break;
    current = lines.slice(0, last.line).join('\n');
  }
  return current;
}
function markBodiesEmpty(text: string): boolean {
  const {lines, marks} = passRegions(text);
  if (!marks.length) return false;
  return marks.every((mark, index) => regionEmpty(lines, mark.line + 1, index + 1 < marks.length ? marks[index + 1].line : lines.length));
}
function removePassMarks(text: string): string {
  const {lines, marks} = passRegions(text);
  if (!marks.length) return text;
  return lines.slice(0, marks[0].line).join('\n').replace(/\n+$/g, '');
}
// Chip actions write marks. 'add' appends from the highest pass number through the
// chip count. A missing number in the middle stays missing and does not add a mark
// past the chips. 'drop' removes an empty tail that no longer has a chip, and a lone
// chip with only empty marks goes back to plain text. 'names' and 'clear' rewrite
// names and «из M» and leave the lines.
export function syncPassMarks(text: string, order: readonly Provider[], kind: 'add' | 'names' | 'drop' | 'clear' = 'names'): string {
  let body = String(text ?? '');
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
// The name comes from chip N, N being the number written in the mark, not the mark's
// place in the text. The number and every other line stay. No chip N means ?.
export function rewritePassNames(text: string, order: readonly Provider[]): string {
  return syncPassMarks(text, order, 'names');
}
const discussNote = 'обсуждаем, код не трогать';
// With pass marks the note belongs to the shared part, above the first mark.
// Only that shared part can suppress it. The same words inside one pass do not.
// Without marks the note stays at the end of the message.
export function placeDiscussLine(text: string): string {
  const body = String(text ?? '');
  if (!body.trim()) return body;
  const marks = passMarks(body);
  const lines = body.split('\n');
  const head = (marks.length ? lines.slice(0, marks[0].line).join('\n') : body).replace(/\s+$/u, '');
  if (/обсуждаем|код не трогать/iu.test(head)) return body;
  if (!marks.length) return head + '\n\n' + discussNote;
  const tail = lines.slice(marks[0].line).join('\n').replace(/^\n+/u, '');
  return (head ? head + '\n\n' : '') + discussNote + '\n\n' + tail;
}
// Filled from each engine's own handshake, never hard-coded.
export interface ModelChoice {value: string; label: string; description?: string; efforts: string[]}
export type Catalogs = Partial<Record<Provider, ModelChoice[]>>;
export interface Attachment {id: string; label: string; text: string; preview?: string}
export const snippetLimits = {count: 40, name: 80, text: 20000, id: 64} as const;
export interface SnippetFlags {
  autoEdits?: boolean; autoCommands?: boolean; discuss?: boolean; responseOrder?: Provider[];
}
export interface Snippet {id: string; name: string; text: string; flags?: SnippetFlags}
function snippetName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, snippetLimits.name) : '';
}
function snippetOrder(value: unknown): Provider[] {
  if (!Array.isArray(value)) return [];
  const order: Provider[] = [];
  for (const item of value) if (isProvider(item)) order.push(item);
  return order.slice(0, 10);
}
function snippetFlags(raw: unknown): SnippetFlags | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const v = raw as Record<string, unknown>;
  const flags: SnippetFlags = {};
  let any = false;
  if (typeof v.autoEdits === 'boolean') {flags.autoEdits = v.autoEdits; any = true;}
  if (typeof v.autoCommands === 'boolean') {flags.autoCommands = v.autoCommands; any = true;}
  if (typeof v.discuss === 'boolean') {flags.discuss = v.discuss; any = true;}
  if (Array.isArray(v.responseOrder)) {flags.responseOrder = snippetOrder(v.responseOrder); any = true;}
  return any ? flags : undefined;
}
export function parseSnippet(raw: unknown): Snippet | undefined {
  if (!raw || typeof raw !== 'object') return;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === 'string' && new RegExp('^[A-Za-z0-9_-]{1,' + snippetLimits.id + '}$').test(v.id) ? v.id : '';
  const name = snippetName(v.name);
  const text = typeof v.text === 'string' ? v.text.replace(/\r\n/g, '\n') : '';
  if (!id || !name || !text.trim() || text.length > snippetLimits.text) return;
  const snippet: Snippet = {id, name, text};
  const flags = snippetFlags(v.flags);
  if (flags) snippet.flags = flags;
  return snippet;
}
export function parseSnippets(value: unknown): Snippet[] {
  if (!Array.isArray(value)) return [];
  const out: Snippet[] = [], seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= snippetLimits.count) break;
    const snippet = parseSnippet(raw);
    if (!snippet || seen.has(snippet.id)) continue;
    seen.add(snippet.id);
    out.push(snippet);
  }
  return out;
}
// Reported by the engine itself after its own turn. Trio never estimates tokens
// and never mixes this with its own trio.contextChars limit on the feed.
export interface Quota {percent: number; label?: string; limitId?: string; limitName?: string; resets?: string; resetsAt?: number; source: string; at: number}
export interface DeltaHint {provider: Provider; chars: number; messages: number; total: number; kind: 'delta' | 'full'; reason?: 'fresh' | 'compact'}
export interface Usage {tokens?: number; window?: number; source: string; at: number; quota?: Quota}
export interface QuestionItem {
  id?: string; prompt: string; options: {label: string; description?: string}[]; multi?: boolean;
  secret?: boolean;
}
// Strings remain readable for old stored cards; new selections travel as arrays.
export type QuestionAnswers = Record<string, string | string[]>;
export function answerLabels(value: string | string[] | undefined): string[] {
  return [...new Set((Array.isArray(value) ? value : value ? [value] : []).filter(v => typeof v === 'string' && v.trim()))];
}
export function questionKey(item: QuestionItem): string {return item.id || item.prompt;}
export interface UserQuestion {
  id: string; items: QuestionItem[];
  answered?: QuestionAnswers;
}
export interface Message {
  id: string; author: 'Антон' | 'Колян' | 'Жека' | 'Гриха' | 'Trio'; text: string;
  // When the post appeared, in epoch ms. The panel prints it in Anton's own zone;
  // older messages without it fall back to the times of their turn.
  at?: number;
  turn?: string; error?: boolean; partial?: boolean; control?: boolean; cancelled?: boolean;
  detail?: string; actions?: {title: string; detail?: string}[]; attachments?: Attachment[];
  question?: UserQuestion;
  // Обсуждаем on this post. False is a later send without the button.
  // Missing means a post from before the flag, and the click still guesses.
  discuss?: boolean;
}
export interface TraceStep {id: string; kind: 'tool' | 'thought'; title: string; status: 'running' | 'done'}
export interface Turn {
  id: string; messageId: string; recipient: Recipient; status: Status;
  executor?: Provider; mode?: Mode; replyId?: string; snapshot?: string;
  startedAt?: number; endedAt?: number;
  spent?: number; spentHint?: string;
  trace?: TraceStep[];
  cycle?: number;
  // Place in the message's chain, from 1. A retry keeps the place of the turn it repeats.
  pass?: number;
  instruction?: string;
  // A feed handoff: one discuss turn whose finished text replaces the conversation.
  summary?: boolean;
}
// Retained for snapshots and tasks from the first scaffold.
export interface Task {id: string; description: string; expected: string; executor?: Provider; source: string; status: Status; snapshot?: string; result?: string}
export interface State {
  conversationId: string; contextStart?: string; responseOrder: Provider[];
  version: 2 | 3; messages: Message[]; turns: Turn[]; tasks: Task[]; queue: string[];
  agents: Agent[]; draftAttachments: Attachment[]; draft: string; recipient: Recipient;
  sessions: Record<string, {id: string; project: string; profile: string; through?: string}>;
  usage: Partial<Record<Provider, Usage>>;
  imports: string[]; diagnostics: string[];
  autoReply?: boolean; autoEdits?: boolean; autoCommands?: boolean; autoActions?: boolean;
  privilegeOn?: boolean; privileges?: Privilege[];
  // Пауза очереди: текущий ход доходит до конца, следующий не начинается. Живёт на диске.
  paused?: boolean;
}
// In the project root for the summary turn only; .gitignore lists it.
export const summaryFile = '.trio-summary.md';
// Catch-all privilege hits, one JSON object per line. .gitignore lists it.
export const privilegeJournalFile = '.trio-privileges.jsonl';
// reason is a fixed label and never contains the command or its arguments.
export interface PrivilegeJournalRow {
  at: string; agent: string; word: string; privilege: 'unparsed' | 'other';
  reason: string; outcome: 'само' | 'разрешено' | 'отказ';
}
export const summaryComfort = 'Можно комфортно продолжать работу дальше';
export const summaryPrompt = [
  'Trio по кнопке «Новый»: сводка для нового разговора.',
  '',
  'Подготовь сводку для продолжения работы. После неё Trio очистит ленту, сбросит сессии всех участников и вставит этот текст первым сообщением. Он станет единственной памятью о прошлом.',
  '',
  'Пиши так, чтобы работа продолжилась без разрыва. Порядок:',
  '1) где остановились: последнее поручение, что сделано, что осталось, какие решения ждут Антона;',
  '2) незакрытые вопросы и обещания;',
  '3) действующие правила и решения, которые не пересматриваем;',
  '4) состояние кода и публикации: версия, незакоммиченное, ветки;',
  '5) коротко крупные этапы.',
  '',
  'Код сверяй с файлами проекта, состояние git — по разделу «Git» в файле ленты. Согласованное отделяй от предложения. Неизвестное не выдавай за проверенное. Номера старой ленты пиши одним словом: #арх464, #архК183, #архЖ78, #архГ245.',
  '',
  'Выдай только текст сводки. Архив, очистку и вставку сделает Trio.'
].join('\n');
export const fresh = (): State => ({
  conversationId: id(), responseOrder: [], version: 3, messages: [], turns: [], tasks: [], queue: [], draftAttachments: [], draft: '', recipient: 'all',
  agents: providers.map(p => ({id: p, enabled: p !== 'grok', mode: 'discuss', model: '', effort: ''})),
  sessions: {}, usage: {}, imports: [], diagnostics: [], autoReply: false, autoEdits: false, autoCommands: false,
  privilegeOn: false, privileges: [], paused: false
});
export const imageExtensions: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp'
};
export function isProvider(v: unknown): v is Provider {return providers.includes(v as Provider);}
export function addressed(text: string): Provider | undefined {
  const m = text.trim().match(/^(?:@)?(колян|claude|жека|codex|гриха|grok)(?=[\s,:.!?]|$)/iu);
  if (!m) return;
  return ({колян: 'claude', claude: 'claude', жека: 'codex', codex: 'codex', гриха: 'grok', grok: 'grok'} as Record<string, Provider>)[m[1].toLowerCase()];
}
export function stopTarget(text: string): Recipient | undefined {
  const s = text.trim().toLowerCase().replace(/[.!]+$/u, '');
  if (/^(стоп|стоп всем|всем стоп|остановить всех|стоп обоим)$/u.test(s)) return 'all';
  const p = addressed(s);
  if (p && /^(?:@)?\S+[, :]\s*(стоп|остановись)$/u.test(s)) return p;
}
function metaTool(obj: any): any {
  return obj?._meta?.['x.ai/tool'] || obj?._meta?.['x.ai']?.tool || obj?.toolCall || {};
}
function toolName(title: string, obj: any): string {
  const raw = String(metaTool(obj).name || obj?.name || title.split(/[\s`]/)[0] || '');
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
const serviceTools = new Set([
  'todowrite', 'todoread', 'todo', 'skill', 'exitplanmode', 'enterplanmode',
  'askuserquestion', 'toolsearch', 'listagents'
]);
export const privilegeIds = ['delete', 'network', 'git', 'shell', 'unparsed', 'other'] as const;
export type Privilege = typeof privilegeIds[number];
const networkBins = new Set(['curl', 'wget', 'invokewebrequest']);
const shellBins = new Set(['rm', 'rd', 'del', 'rmdir', 'removeitem']);
const dangerGit = new Set(['commit', 'push', 'reset', 'rebase', 'amend']);
const wrapperBins = new Set(['powershell', 'pwsh', 'bash', 'sh', 'zsh', 'cmd']);
function stripHeredoc(text: string): string {
  return text.replace(/<<[-]?['"]?(\w+)['"]?[\s\S]*?(?:\r?\n\1\b|$)/g, ' ');
}
function stripQuoted(text: string, shell: string): {text: string; ok: boolean} {
  let out = '', i = 0;
  const powershell = shell === 'powershell';
  while (i < text.length) {
    const c = text[i];
    if (powershell && c === '`') {
      if (i + 1 >= text.length) return {text: out, ok: false};
      out += text[i + 1]; i += 2; continue;
    }
    if (c === "'" || c === '"' || (!powershell && c === '`')) {
      let closed = false;
      for (i++; i < text.length; i++) {
        if ((powershell ? c === '"' && text[i] === '`' : c !== "'" && text[i] === '\\')) {i++; continue;}
        if (text[i] !== c) continue;
        if (powershell && text[i + 1] === c) {i++; continue;}
        i++; closed = true; break;
      }
      if (!closed) return {text: out, ok: false};
      // Keep an argument slot so git -C "a b" push still exposes push.
      out += '\0';
      continue;
    }
    out += c; i++;
  }
  return {text: out, ok: true};
}
// Single-quoted here-strings are literal payloads, including `$()` and quotes.
// Only PowerShell has them. Interpolated or unfinished here-strings stay unparsed.
function openCommand(raw: string, shell: string): {text: string; powershell: boolean} | {reason: 'here-string'} {
  let text = raw;
  const powershell = shell === 'powershell';
  if (powershell) {
    const next = text.replace(/@'\r?\n[\s\S]*?\r?\n'@(?=\s|[;|)]|$)/g, ' ');
    if (/@['"]\r?\n/.test(next)) return {reason: 'here-string'};
    text = next;
  }
  return {text, powershell};
}
// With no shell field, `@'` may be a PowerShell here-string or a bash quote that
// closes at the first `'` and leaves the rest of the line running. Read it both ways.
function bothShells(raw: string, shell: string): boolean {
  return shell === '' && /@['"]\r?\n/.test(raw);
}
// What bash makes of a here-string read as quotes: a command named by a literal.
// It runs nothing, so it does not need a checkbox.
function inertLiteral(cleaned: string): boolean {
  return /^@\0@(?:\s|$)/.test(cleaned);
}
function takeQuote(text: string, i: number, powershell: boolean): {next: number; subst?: '$()' | '${}'} | undefined {
  const quote = text[i];
  let subst: '$()' | '${}' | undefined;
  for (let j = i + 1; j < text.length; j++) {
    const double = quote === '"';
    if (powershell ? double && text[j] === '`' : quote !== "'" && text[j] === '\\') {j++; continue;}
    if (double && text[j] === '$' && (text[j + 1] === '(' || text[j + 1] === '{')) subst = text[j + 1] === '(' ? '$()' : '${}';
    if (text[j] !== quote) continue;
    if (powershell && text[j + 1] === quote) {j++; continue;}
    return {next: j + 1, subst};
  }
}
function takeHeredoc(text: string, i: number): {next: number; subst?: '$()' | '${}'} | undefined {
  let j = i + 2;
  if (text[j] === '-') j++;
  const quote = text[j] === "'" || text[j] === '"' ? text[j] : '';
  if (quote) j++;
  const start = j;
  while (j < text.length && /\w/.test(text[j])) j++;
  const delim = text.slice(start, j);
  if (!delim) return;
  if (quote) {
    if (text[j] !== quote) return;
    j++;
  }
  const matched = new RegExp('^[\\s\\S]*?(?:\\r?\\n' + delim + '\\b|$)').exec(text.slice(j));
  if (!matched) return;
  let subst: '$()' | '${}' | undefined;
  if (!quote && matched[0].includes('$(')) subst = '$()';
  else if (!quote && matched[0].includes('${')) subst = '${}';
  return {next: j + matched[0].length, subst};
}
function skipSubst(text: string, i: number): number {
  const open = text[i + 1], close = open === '(' ? ')' : '}';
  let depth = 1, quote = '';
  for (let j = i + 2; j < text.length; j++) {
    const c = text[j];
    if (quote) {
      if (c === '\\' && quote !== "'") {j++; continue;}
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') {quote = c; continue;}
    if (c === open || (c === '$' && (text[j + 1] === '(' || text[j + 1] === '{'))) {
      if (c === '$') j++;
      depth++;
      continue;
    }
    if (c === close && --depth === 0) return j + 1;
  }
  return -1;
}
function splitCommand(text: string, powershell: boolean): {raw: string; subst?: '$()' | '${}'}[] | undefined {
  const parts: {raw: string; subst?: '$()' | '${}'}[] = [];
  let cur = '', subst: '$()' | '${}' | undefined;
  const push = () => {
    if (cur.trim()) parts.push(subst ? {raw: cur.trim(), subst} : {raw: cur.trim()});
    cur = ''; subst = undefined;
  };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (powershell && c === '`') {
      if (i + 1 >= text.length) return;
      cur += c + text[i + 1]; i += 2; continue;
    }
    if (c === '<' && text[i + 1] === '<') {
      const taken = takeHeredoc(text, i);
      if (!taken) return;
      if (taken.subst && !subst) subst = taken.subst;
      cur += ' '; i = taken.next; continue;
    }
    if (c === "'" || c === '"' || (!powershell && c === '`')) {
      const taken = takeQuote(text, i, powershell);
      if (!taken) return;
      if (taken.subst && !subst) subst = taken.subst;
      cur += text.slice(i, taken.next); i = taken.next; continue;
    }
    if (c === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) {
      const end = skipSubst(text, i);
      if (end < 0) return;
      if (!subst) subst = text[i + 1] === '(' ? '$()' : '${}';
      cur += ' '; i = end; continue;
    }
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && text[i + 1] === c) {push(); i += 2; continue;}
      if (c === '\r' && text[i + 1] === '\n') {push(); i += 2; continue;}
      if (c === '&' && !cur.trim()) {cur += '&'; i++; continue;}
      push(); i++; continue;
    }
    cur += c; i++;
  }
  push();
  return parts;
}
// A leading `&` is PowerShell's call operator. A quoted path is the program.
// A script block or a variable call still has no visible command.
function visiblePart(raw: string): {text: string; blocked?: '&'} {
  const match = raw.match(/^\s*&\s*([\s\S]*)$/);
  if (!match) return {text: raw};
  const rest = match[1];
  if (!rest.trim() || rest[0] === '{' || (rest[0] === '$' && rest[1] !== '(' && rest[1] !== '{')) return {text: rest, blocked: '&'};
  const quoted = rest.match(/^(?:"([^"\r\n]*)"|'([^'\r\n]*)')([\s\S]*)$/);
  if (!quoted) return {text: rest};
  const bin = (quoted[1] ?? quoted[2]).replace(/^.*[/\\]/, '').replace(/\.exe$/i, '');
  if (!bin || /\s/.test(bin)) return {text: rest, blocked: '&'};
  return {text: bin + quoted[3]};
}
function oneScript(body: string): string | undefined {
  if (body[0] !== '"' && body[0] !== "'") return body;
  const quote = body[0];
  let out = '';
  for (let i = 1; i < body.length; i++) {
    if (body[i] === quote) return body.slice(i + 1).trim() ? undefined : out;
    out += body[i];
  }
}
function wrapperBody(raw: string, bin: string): {body: string; shell: string} | 'opaque' | undefined {
  if (!wrapperBins.has(bin)) return;
  const rest = raw.replace(/^\s*(?:"[^"]*"|'[^']*'|\S+)\s*/, '');
  if (!rest.trim()) return 'opaque';
  if ((bin === 'powershell' || bin === 'pwsh' || bin === 'cmd') && /-(?:EncodedCommand|File)\b/i.test(rest)) return 'opaque';
  const shell = bin === 'pwsh' ? 'powershell' : bin;
  const body = bin === 'cmd' ? /^(?:\/[ds]\s+)*\/c\s+([\s\S]+)$/i.exec(rest)?.[1]
    : bin === 'powershell' || bin === 'pwsh'
      ? /^(?:(?:-NoProfile|-NonInteractive|-NoLogo|-ExecutionPolicy\s+\S+)\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(rest)?.[1]
      : /^(?:(?:--noprofile|--norc|-l)\s+)*-(?:lc|c)\s+([\s\S]+)$/i.exec(rest)?.[1];
  const script = body ? oneScript(body.trim()) : undefined;
  // `-Command -` reads the script from stdin, `$x` takes it from a variable: neither is visible.
  if (!script || !script.trim() || /^\s*(?:-|\$)/.test(script)) return 'opaque';
  // CMD expands these before execution; the resulting command is not visible.
  if (bin === 'cmd' && /%[^%\r\n]+%|%[0-9*]|![^!\r\n]+!/.test(script)) return 'opaque';
  // Backtick substitution in a POSIX shell is executable, not a quoted literal.
  if (shell !== 'powershell' && script.includes('\x60')) return 'opaque';
  return {body: script, shell};
}
function plainPrivilege(head: {bin: string; arg: string}): Privilege | undefined {
  const key = head.bin.replace(/[^a-z0-9]+/g, '');
  if (networkBins.has(key)) return 'network';
  if (shellBins.has(key)) return 'shell';
  if (head.bin === 'git' && dangerGit.has(head.arg.toLowerCase())) return 'git';
}
function commandParts(raw: string, shell = ''): string[] | undefined {
  if (bothShells(raw, shell)) {
    const ps = commandParts(raw, 'powershell'), sh = commandParts(raw, 'bash');
    return ps && sh && ps.join('\n') === sh.join('\n') ? ps : undefined;
  }
  const opened = openCommand(raw, shell);
  if ('reason' in opened) return;
  const pieces = splitCommand(opened.text, opened.powershell);
  if (!pieces || pieces.some(piece => piece.subst)) return;
  const quoteShell = opened.powershell ? 'powershell' : shell;
  const out: string[] = [];
  for (const piece of pieces) {
    const vis = visiblePart(piece.raw);
    if (vis.blocked) return;
    const unquoted = stripQuoted(vis.text, quoteShell);
    if (!unquoted.ok) return;
    const cleaned = unquoted.text.replace(/\s-m\s+\S+/gi, ' ').replace(/\s-F\s+\S+/gi, ' ').trim();
    if (cleaned && !inertLiteral(cleaned)) out.push(cleaned);
  }
  return out;
}
function commandHead(part: string): {bin: string; arg: string} | undefined {
  const tokens = part.replace(/^\s*(?:[A-Za-z_][\w]*=\S+\s+)*/, '').split(/\s+/).filter(Boolean);
  let i = 0;
  let bin = (tokens[0] || '').replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (bin === 'sudo' || bin === 'command') {i = 1; bin = (tokens[1] || '').replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase();}
  if (!bin || bin.includes('\0')) return;
  let j = i + 1;
  if (bin === 'git') {
    while (j < tokens.length && tokens[j].startsWith('-')) {
      const flag = tokens[j++];
      if (/^(?:-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env)$/.test(flag)) {
        if (j >= tokens.length) return;
        j++;
      } else if (/^(?:-[Cc].+|--(?:git-dir|work-tree|namespace|super-prefix|config-env)=.*)$/.test(flag)) {
        continue;
      } else if (!/^(?:-p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-lazy-fetch|--no-advice)$/.test(flag)) {
        return;
      }
    }
    if (tokens[j]?.includes('\0')) return;
  }
  if (bin === 'ssh') {
    while (j < tokens.length && tokens[j].startsWith('-')) {
      const flag = tokens[j++];
      if (/^-[oilpEcw]$/.test(flag) && tokens[j] && !tokens[j].startsWith('-')) j++;
    }
  }
  return {bin, arg: tokens[j] || ''};
}
// A visible head keeps its checkbox. What still hides the command stays
// unparsed, and a chain needs every checkbox it touched.
function readCommand(raw: string, shell = '', depth = 0): {
  needs: Set<Privilege>; safeCommand: boolean; unsplit: boolean; reason?: string; word?: string;
} {
  if (bothShells(raw, shell)) {
    const ps = readCommand(raw, 'powershell', depth), sh = readCommand(raw, 'bash', depth);
    const first = ps.reason ? ps : sh;
    return {
      needs: new Set([...ps.needs, ...sh.needs]), safeCommand: ps.safeCommand || sh.safeCommand,
      unsplit: ps.unsplit || sh.unsplit, reason: first.reason, word: first.word
    };
  }
  const needs = new Set<Privilege>();
  let safeCommand = false, reason: string | undefined, word: string | undefined;
  const note = (next: string, token?: string) => {
    if (reason) return;
    reason = next;
    if (token) word = token;
  };
  const opened = openCommand(raw, shell);
  if ('reason' in opened) {
    needs.add('unparsed');
    return {needs, safeCommand, unsplit: true, reason: opened.reason};
  }
  const pieces = splitCommand(opened.text, opened.powershell);
  if (!pieces || !pieces.length) {
    needs.add('unparsed');
    return {needs, safeCommand, unsplit: true, reason: 'нет головы'};
  }
  const quoteShell = opened.powershell ? 'powershell' : shell;
  for (const piece of pieces) {
    const vis = visiblePart(piece.raw);
    if (vis.blocked) {needs.add('unparsed'); note(piece.subst || '&'); continue;}
    const unquoted = stripQuoted(vis.text, quoteShell);
    if (!unquoted.ok) {needs.add('unparsed'); note('нет головы'); continue;}
    const cleaned = unquoted.text.replace(/\s-m\s+\S+/gi, ' ').replace(/\s-F\s+\S+/gi, ' ').trim();
    if (!piece.subst && inertLiteral(cleaned)) continue;
    // This scanner handles command chains, not control flow or grouped scripts.
    // Keep the unknown part while continuing to collect other visible commands.
    if (/^(?:[({]|(?:if|then|else|elif|elseif|fi|for|foreach|while|until|do|done|switch|case|esac|function|filter|try|catch|finally|trap|begin|process|end)(?=[\s({]|$))/i.test(cleaned)) {
      needs.add('unparsed'); note(depth ? 'обёртка' : 'нет головы'); continue;
    }
    const head = cleaned ? commandHead(cleaned) : undefined;
    if (!head || head.bin[0] === '{') {needs.add('unparsed'); note(piece.subst || 'нет головы'); continue;}
    if (piece.subst) {
      needs.add('unparsed');
      const priv = plainPrivilege(head);
      if (priv) needs.add(priv);
      note(piece.subst, head.bin);
      continue;
    }
    const wrapped = wrapperBody(vis.text, head.bin);
    if (wrapped) {
      if (wrapped === 'opaque' || depth >= 3) {needs.add('unparsed'); note('обёртка', head.bin); continue;}
      const inner = readCommand(wrapped.body, wrapped.shell, depth + 1);
      for (const item of inner.needs) needs.add(item);
      if (inner.unsplit) needs.add('unparsed');
      if (inner.safeCommand) safeCommand = true;
      if (inner.reason) note(inner.reason, inner.word);
      else if (inner.unsplit) note('обёртка', head.bin);
      continue;
    }
    const priv = plainPrivilege(head);
    if (priv) needs.add(priv);
    else if (wrapperBins.has(head.bin)) {needs.add('unparsed'); note('обёртка', head.bin);}
    else safeCommand = true;
  }
  return {needs, safeCommand, unsplit: false, reason, word};
}
function commandPrivileges(raw: string, shell = ''): {needs: Set<Privilege>; safeCommand: boolean} {
  const read = readCommand(raw, shell);
  // A failed interpretation must not discard categories found by the other shell.
  if (read.unsplit) read.needs.add('unparsed');
  return {needs: read.needs, safeCommand: read.safeCommand};
}
function classifyCommand(raw: string, shell = ''): 'command' | 'danger' {
  const found = commandPrivileges(raw, shell);
  return found.needs.size ? 'danger' : 'command';
}
export function permissionClass(title: string, detail = ''): 'read' | 'edit' | 'command' | 'danger' {
  let obj: any, kind = '', command = '';
  try {obj = JSON.parse(detail);} catch {obj = undefined;}
  if (obj && typeof obj === 'object') {
    kind = String(obj.kind || obj.toolCall?.kind || obj._meta?.kind || metaTool(obj).kind || '').toLowerCase();
    command = String(obj.rawInput?.command || obj.command || obj.title || '');
  }
  const extra = detail.trim().startsWith('{') ? '' : detail;
  const name = toolName(title, obj);
  if (kind === 'danger' || kind === 'delete' || kind === 'fetch' || kind === 'web_fetch' || kind === 'web_search') return 'danger';
  if (/\b(webfetch|websearch|web_fetch|web_search)\b/i.test(title)) return 'danger';
  const op = String(obj?.type || obj?.operation || obj?.change || obj?.fileChange?.type || '').toLowerCase();
  if (op === 'delete' || op === 'remove') return 'danger';
  if (serviceTools.has(name)) return 'read';
  if (kind === 'read' || kind === 'search' || kind === 'think') return 'read';
  if (kind === 'edit' || kind === 'move' || kind === 'write') return 'edit';
  const shellTitle = /\b(bash|shell|powershell|cmd\.exe)\b/i.test(title) || /выполнение команды/i.test(title);
  if (kind === 'execute' || shellTitle) return classifyCommand(command || extra, String(obj?.shell || ''));
  if (/\b(read|grep|glob|ls|list_dir|search_file_content|view)\b/i.test(title) || name === 'read' || name === 'grep' || name === 'glob')
    return 'read';
  if (/\b(write|edit|strreplace|apply_patch|notebookedit|search_replace)\b/i.test(title)
    || /изменени[ея] файлов/i.test(title)) {
    const op = String(obj?.type || obj?.operation || obj?.change || obj?.fileChange?.type || '').toLowerCase();
    if (op === 'delete' || op === 'remove') return 'danger';
    return 'edit';
  }
  return 'danger';
}
export function dangerCover(title: string, detail = ''): {needs: Privilege[]; safeCommand: boolean; safeEdit?: boolean} | undefined {
  if (permissionClass(title, detail) !== 'danger') return;
  let obj: any, kind = '', command = '';
  try {obj = JSON.parse(detail);} catch {obj = undefined;}
  if (obj && typeof obj === 'object') {
    kind = String(obj.kind || obj.toolCall?.kind || obj._meta?.kind || metaTool(obj).kind || '').toLowerCase();
    command = String(obj.rawInput?.command || obj.command || obj.title || '');
  }
  const extra = detail.trim().startsWith('{') ? '' : detail;
  const needs = new Set<Privilege>();
  let safeCommand = false;
  if (kind === 'delete') needs.add('delete');
  if (kind === 'fetch' || kind === 'web_fetch' || kind === 'web_search' || /\b(webfetch|websearch|web_fetch|web_search)\b/i.test(title)) needs.add('network');
  const op = String(obj?.type || obj?.operation || obj?.change || obj?.fileChange?.type || '').toLowerCase();
  if (op === 'delete' || op === 'remove') needs.add('delete');
  const shellTitle = /\b(bash|shell|powershell|cmd\.exe)\b/i.test(title) || /выполнение команды/i.test(title);
  const commandText = command || extra;
  if (kind === 'execute' || shellTitle || kind === 'danger' && commandText.trim()) {
    // Codex marks a shell wrapper it could not open as danger: its text is not the real command.
    const found = kind === 'danger' || !commandText.trim() ? 'unparsed' : commandPrivileges(commandText, String(obj?.shell || ''));
    if (found === 'unparsed') needs.add('unparsed');
    else {
      for (const item of found.needs) needs.add(item);
      if (found.needs.size && found.safeCommand) safeCommand = true;
    }
  }
  if (!needs.size) needs.add('other');
  const safeEdit = Array.isArray(obj?.changes) && obj.changes.some((change: any) => ['add', 'update'].includes(change?.kind?.type ?? change?.kind));
  return {needs: privilegeIds.filter(id => needs.has(id)), safeCommand, ...(safeEdit ? {safeEdit: true} : {})};
}
// A command or tool name for the journal. Arguments stay out: a secret often
// sits there, and field redaction does not see it inside a command string.
function journalToken(raw: string): string {
  const token = raw.replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (!token || token.length > 60 || !/^[a-z][a-z0-9._+-]*$/.test(token)) return '';
  return token;
}
export function privilegeJournalHit(title: string, detail = ''): Pick<PrivilegeJournalRow, 'privilege' | 'word' | 'reason'> | undefined {
  const cover = dangerCover(title, detail);
  if (!cover) return;
  const privilege = cover.needs.includes('unparsed') ? 'unparsed' as const
    : cover.needs.includes('other') ? 'other' as const : undefined;
  if (!privilege) return;
  let obj: any, command = '';
  try {obj = JSON.parse(detail);} catch {obj = undefined;}
  if (obj && typeof obj === 'object') command = String(obj.rawInput?.command || obj.command || obj.title || '');
  const extra = detail.trim().startsWith('{') ? '' : detail;
  const commandText = command || extra;
  const named = () => {
    const loose = journalToken((commandText.trim().split(/\s+/)[0] || ''));
    if (loose) return loose;
    const tool = String(obj?.name || metaTool(obj).name || title || '').split(/[\s`]/)[0] || '';
    return journalToken(tool) || 'прочее';
  };
  if (privilege === 'other') return {privilege, word: named(), reason: 'прочее'};
  // A wrapper Codex could not open is not the real command. Do not read inside it.
  const kind = String(obj?.kind || obj?.toolCall?.kind || obj?._meta?.kind || metaTool(obj).kind || '').toLowerCase();
  if (kind === 'danger' || !commandText.trim()) {
    return {privilege, word: named(), reason: commandText.trim() ? 'обёртка' : 'нет текста'};
  }
  const read = readCommand(commandText, String(obj?.shell || ''));
  return {privilege, word: journalToken(read.word || '') || named(), reason: read.reason || 'нет головы'};
}
export function permissionSignature(title: string, detail = ''): string | undefined {
  let obj: any, kind = '', command = '';
  try {obj = JSON.parse(detail);} catch {obj = undefined;}
  if (obj && typeof obj === 'object') {
    kind = String(obj.kind || obj.toolCall?.kind || obj._meta?.kind || metaTool(obj).kind || '').toLowerCase();
    command = String(obj.rawInput?.command || obj.command || obj.title || '');
  }
  const extra = detail.trim().startsWith('{') ? '' : detail;
  const shellTitle = /\b(bash|shell|powershell|cmd\.exe)\b/i.test(title) || /выполнение команды/i.test(title);
  if (kind === 'execute' || shellTitle) {
    if (obj?.shell === 'powershell' && /[$(){}]/.test(command || extra)) return;
    const parts = commandParts(command || extra, String(obj?.shell || '')) || [];
    const bits = parts.map(part => {
      const head = commandHead(part);
      if (!head || wrapperBins.has(head.bin)) return '';
      if (head.bin === 'ssh' && head.arg) return 'ssh ' + head.arg.toLowerCase();
      if (head.bin === 'git' && head.arg) return 'git ' + head.arg.toLowerCase();
      return head.bin;
    }).filter(Boolean);
    return bits.length ? 'cmd:' + bits.join('+') : undefined;
  }
  const name = toolName(title, obj);
  return name ? 'tool:' + name : undefined;
}
export function permissionCaption(title: string, detail = ''): string {
  let command = '', files: string[] = [];
  try {
    const obj = JSON.parse(detail);
    command = String(obj?.rawInput?.command || obj?.command || '');
    // Codex supplies structured changes as well as a comma-joined path.
    // Keep paths with commas intact and make additional files explicit.
    files = Array.isArray(obj?.changes) ? obj.changes.map((c: any) => c?.path)
      .filter((p: unknown): p is string => typeof p === 'string' && !!p.trim()) : [];
    if (!files.length) files = [String(obj?.rawInput?.path || obj?.path || obj?.file_path || obj?.filePath || '')];
  } catch { /* detail is not JSON */ }
  if (command.trim()) return brief(command.trim().split(/\n/)[0]);
  const label = brief(title), file = (files[0] || '').replace(/\s+/gu, ' ').trim();
  if (!file) return label;
  const more = files.length > 1 ? ' (+' + (files.length - 1) + ')' : '';
  const limit = 60 - label.length - more.length - 1;
  if (file.length <= limit) return label + ' ' + file + more;
  const separator = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  // Only directories may be shortened. A long filename wraps in the dialog.
  if (separator < 0) return label + ' ' + file + more;
  const tail = file.slice(separator);
  const head = file.slice(0, Math.max(0, limit - tail.length - 1)).replace(/[\\/]+$/u, '');
  return label + ' ' + head + '…' + tail + more;
}
export function brief(title: string, limit = 60): string {
  const flat = title.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1).trimEnd() + '…';
}
export function riskyPermission(title: string, detail = ''): boolean {
  return permissionClass(title, detail) !== 'read';
}
// The card chooses the mode. Words in the message, including «обсуждаем, код не трогать», do not.
export function assignedMode(text: string, fallback: Mode): Mode {
  void text;
  return fallback;
}
export function diskImagePath(text: string): string | undefined {
  const match = /^Изображение на диске:\s*(.+)$/m.exec(text);
  if (!match) return;
  const file = match[1].trim();
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(file) ? file : undefined;
}
export function plainAttachment(a: Attachment): Attachment {
  return {id: a.id, label: a.label, text: a.text};
}
export function validAttachments(value: unknown): value is Attachment[] {
  return Array.isArray(value) && value.length <= 8 && value.every(a => a && typeof a.id === 'string' && a.id.length <= 100 && typeof a.label === 'string' && a.label.length <= 500 && typeof a.text === 'string' && a.text.length <= 50000) && new Set(value.map(a => a.id)).size === value.length && value.reduce((n, a) => n + a.text.length, 0) <= 200000;
}
// The answer lives inside the question card, not in a second post from Anton: the panel
// shows the picked option on the card itself, and the prompt reads it from here.
export function messageText(message: Pick<Message, 'text' | 'attachments' | 'question'>): string {
  const answered = message.question?.answered;
  const answers = answered
    ? Object.entries(answered).map(([key, value]) => {
      const prompt = message.question?.items.find(q => questionKey(q) === key)?.prompt || key;
      return '\n\nОтвет Антона' + (prompt ? ' на «' + prompt + '»' : '') + ': ' + answerLabels(value).join(', ');
    }).join('')
    : '';
  return message.text + answers + (message.attachments || []).map(a => '\n\nФайл ' + a.label + ':\n' + a.text).join('');
}
export function afterMessage(messages: Message[], through?: string): Message[] {
  if (!through) return messages;
  const at = messages.findIndex(m => m.id === through);
  return at < 0 ? messages : messages.slice(at + 1);
}
// Same count the panel paints as #N: Anton messages that have a turn, including cancelled.
export function questionNumber(messages: Message[], turns: {messageId: string}[], messageId: string): number {
  const i = messages.filter(m => m.author === 'Антон' && turns.some(t => t.messageId === m.id))
    .findIndex(m => m.id === messageId);
  return i < 0 ? 0 : i + 1;
}
// #К #Ж #Г count each author's replies in feed order. A question card is not a reply.
const replyMarks: Partial<Record<Message['author'], string>> = {Колян: 'К', Жека: 'Ж', Гриха: 'Г'};
export function replyNumber(messages: Message[], turns: {replyId?: string}[], messageId: string): number {
  const message = messages.find(m => m.id === messageId);
  if (!message || !replyMarks[message.author]) return 0;
  const i = messages.filter(m => m.author === message.author && turns.some(t => t.replyId === m.id))
    .findIndex(m => m.id === messageId);
  return i < 0 ? 0 : i + 1;
}
export function messageMark(messages: Message[], turns: {messageId: string; replyId?: string}[], messageId: string): string {
  const question = questionNumber(messages, turns, messageId);
  if (question) return '#' + question;
  const message = messages.find(m => m.id === messageId);
  const n = replyNumber(messages, turns, messageId);
  const mark = message && replyMarks[message.author];
  return n && mark ? '#' + mark + n : '';
}
function speaker(m: Message, messages: Message[], turns: {messageId: string; replyId?: string}[]): string {
  const mark = messageMark(messages, turns, m.id);
  return (mark ? m.author + ' ' + mark : m.author)
    + (m.partial ? ' [частичный ответ]' : '')
    + (m.cancelled ? ' [снят]' : '')
    + (m.error ? ' [ошибка]' : '');
}
// The summarizer's source: plain text with the old feed numbers. The raw state is
// several times larger (permission cards, traces, diagnostics) and no engine could read it.
export function summaryFeed(state: State, git: string): string {
  const {messages, turns} = state;
  const posts = messages.map(m => '### ' + speaker(m, messages, turns)
    + (m.control ? ' [служебное]' : '')
    + (typeof m.at === 'number' ? ' · ' + new Date(m.at).toISOString().slice(0, 10) : '')
    + '\n' + messageText(m) + '\n');
  const queue = state.queue.map(x => turns.find(t => t.id === x)).filter((t): t is Turn => !!t)
    .map((t, i) => (i + 1) + '. ' + (messageMark(messages, turns, t.messageId) || 'сообщение без номера')
      + ' → ' + (t.recipient === 'all' ? 'всем' : names[t.recipient]));
  return ['# Лента Trio для сводки', '',
    'Номера — старой ленты. В сводке пиши их одним словом: #арх464, #архК183.', '',
    '## Git', '', git.trim() || 'не получено', '',
    '## Очередь (' + queue.length + ')', '', queue.length ? queue.join('\n') : 'пусто', '',
    '## Сообщения (' + messages.length + ')', '', ...posts].join('\n').replace(/\r\n?/g, '\n');
}
export function contextFit(messages: Message[], current: string, limit: number,
    catalog?: {messages: Message[]; turns: {messageId: string; replyId?: string}[]}): {text: string; omitted: number; shown: number} {
  if (current.length > limit) throw new Error('Поручение превышает trio.contextChars. Увеличьте лимит или сократите сообщение.');
  const all = catalog?.messages ?? messages;
  const turns = catalog?.turns ?? [];
  const history = messages.map(m => speaker(m, all, turns) + ': ' + messageText(m) + '\n');
  let text = '', omitted = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    if (text.length + history[i].length + current.length > limit) break;
    text = history[i] + text; omitted--;
  }
  return {
    text: (omitted ? '[Ранняя история не поместилась: ' + omitted + ' сообщений.]\n' : '') + text + '\nТекущее поручение Антона:\n' + current,
    omitted, shown: history.length - omitted
  };
}
export function context(messages: Message[], current: string, limit: number,
    catalog?: {messages: Message[]; turns: {messageId: string; replyId?: string}[]}): string {
  return contextFit(messages, current, limit, catalog).text;
}
export type Input =
  | {type: 'ready' | 'export' | 'import' | 'settings' | 'plugin-settings' | 'popout' | 'attach' | 'archives' | 'project' | 'reconnect' | 'pong'}
  | {type: 'open-image'; id: string}
  | {type: 'save-image'; id: string}
  | {type: 'diagnostics'; reducedMotion?: boolean}
  | {type: 'draft'; text: string; recipient: Recipient; responseOrder?: Provider[]; conversationId?: string; attachments?: Attachment[]}
  | {type: 'send'; text: string; recipient: Recipient; responseOrder?: Provider[]; conversationId?: string; attachments?: Attachment[]; discuss?: boolean}
  | {type: 'layout'; side: 'left' | 'right'; width: number; agentsFolded?: boolean; queueFolded?: boolean; draftHeight?: number}
  | {type: 'pause'; on: boolean}
  | {type: 'queue-edit'; messageId: string; text: string}
  | {type: 'queue-move'; messageId: string; before?: string}
  | {type: 'queue-remove'; messageId: string}
  | {type: 'reset'; mode: 'context' | 'conversation'; conversationId?: string; provider?: Provider}
  | {type: 'fresh-summary'; provider: Provider; conversationId?: string}
  | {type: 'feed-max'; count: number; conversationId?: string}
  | {type: 'handoff'; provider: Provider; turnId?: string}
  | {type: 'retry'; turnId: string}
  | {type: 'stop'; provider?: Provider}
  | {type: 'catalog'; provider: Provider}
  | {type: 'usage'; provider: Provider}
  | {type: 'compact'; provider?: Provider}
  | {type: 'image'; data: string; mime: string; name?: string}
  | {type: 'agent'; agent: Agent}
  | {type: 'changes'; taskId: string}
  | {type: 'discard'; turnId: string}
  | {type: 'flags'; autoReply?: boolean; autoEdits?: boolean; autoCommands?: boolean; autoActions?: boolean; privilegeOn?: boolean; privileges?: Privilege[]}
  | {type: 'answer'; requestId: string; answers: QuestionAnswers}
  | {type: 'permission'; requestId: string; allow: boolean; whole?: boolean; standing?: boolean}
  | {type: 'snippets'; items: Snippet[]}
  | {type: 'copy'; text: string};
export function input(value: unknown): Input | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, any>;
  if (['ready', 'export', 'import', 'settings', 'plugin-settings', 'diagnostics', 'popout', 'attach', 'archives', 'project', 'reconnect', 'pong'].includes(v.type)) return v as Input;
  if ((v.type === 'open-image' || v.type === 'save-image') && typeof v.id === 'string' && v.id.length <= 100) return v as Input;
  if (v.type === 'copy' && typeof v.text === 'string' && v.text.length <= 20000) return {type: 'copy', text: v.text};
  if (v.attachments !== undefined && !validAttachments(v.attachments)) return;
  if (v.conversationId !== undefined && typeof v.conversationId !== 'string') return;
  if (v.responseOrder !== undefined && (!Array.isArray(v.responseOrder) || v.responseOrder.length > 10 || v.responseOrder.some((p: unknown) => !isProvider(p)))) return;
  if (v.discuss !== undefined && typeof v.discuss !== 'boolean') return;
  if (v.type === 'layout' && ['left', 'right'].includes(v.side) && typeof v.width === 'number' && Number.isFinite(v.width) && v.width >= 260 && v.width <= 600
    && (v.agentsFolded === undefined || typeof v.agentsFolded === 'boolean')
    && (v.queueFolded === undefined || typeof v.queueFolded === 'boolean')
    && (v.draftHeight === undefined || (typeof v.draftHeight === 'number' && Number.isFinite(v.draftHeight) && v.draftHeight >= 64 && v.draftHeight <= 4000))) return v as Input;
  if (v.type === 'pause' && typeof v.on === 'boolean') return v as Input;
  if (v.type === 'queue-edit' && typeof v.messageId === 'string' && typeof v.text === 'string' && v.text.length <= 1000000) return v as Input;
  if (v.type === 'queue-move' && typeof v.messageId === 'string' && (v.before === undefined || typeof v.before === 'string')) return v as Input;
  if (v.type === 'queue-remove' && typeof v.messageId === 'string') return v as Input;
  if (v.type === 'reset' && ['context', 'conversation'].includes(v.mode)
    && (v.provider === undefined || isProvider(v.provider))) return v as Input;
  if (v.type === 'fresh-summary' && isProvider(v.provider)) return v as Input;
  if (v.type === 'feed-max' && Number.isInteger(v.count) && v.count >= 1 && v.count <= 1000000) return v as Input;
  if (['draft', 'send'].includes(v.type) && typeof v.text === 'string' && v.text.length <= 1000000 && (v.recipient === 'all' || isProvider(v.recipient))) return v as Input;
  if (v.type === 'stop' && (v.provider === undefined || isProvider(v.provider))) return v as Input;
  if (v.type === 'catalog' && isProvider(v.provider)) return v as Input;
  if (v.type === 'usage' && isProvider(v.provider)) return v as Input;
  if (v.type === 'compact' && (v.provider === undefined || isProvider(v.provider))) return v as Input;
  if (v.type === 'image' && typeof v.data === 'string' && v.data.length <= 14000000 && /^[A-Za-z0-9+/=]*$/.test(v.data)
    && imageExtensions[v.mime] && (v.name === undefined || typeof v.name === 'string' && v.name.length <= 200)) return v as Input;
  if (v.type === 'handoff' && isProvider(v.provider) && (v.turnId === undefined || typeof v.turnId === 'string')) return v as Input;
  if (v.type === 'retry' && typeof v.turnId === 'string') return v as Input;
  if (v.type === 'permission' && typeof v.requestId === 'string' && typeof v.allow === 'boolean'
    && (v.whole === undefined || typeof v.whole === 'boolean')
    && (v.standing === undefined || typeof v.standing === 'boolean')) return v as Input;
  if (v.type === 'changes' && typeof v.taskId === 'string') return v as Input;
  if (v.type === 'discard' && typeof v.turnId === 'string') return v as Input;
  if (v.type === 'flags' && (v.autoReply === undefined || typeof v.autoReply === 'boolean')
    && (v.autoEdits === undefined || typeof v.autoEdits === 'boolean')
    && (v.autoCommands === undefined || typeof v.autoCommands === 'boolean')
    && (v.autoActions === undefined || typeof v.autoActions === 'boolean')
    && (v.privilegeOn === undefined || typeof v.privilegeOn === 'boolean')
    && (v.privileges === undefined || Array.isArray(v.privileges) && v.privileges.every((p: unknown) => privilegeIds.includes(p as Privilege)) && new Set(v.privileges).size === v.privileges.length)) return v as Input;
  if (v.type === 'answer' && typeof v.requestId === 'string' && v.answers && typeof v.answers === 'object'
    && !Array.isArray(v.answers) && Object.keys(v.answers).length <= 8
    && Object.values(v.answers).every(x => typeof x === 'string' ? x.length <= 2000
      : Array.isArray(x) && x.length <= 32 && x.every(s => typeof s === 'string' && s.length <= 2000))) return v as Input;
  if (v.type === 'snippets') {
    if (!Array.isArray(v.items) || v.items.length > snippetLimits.count) return;
    const items = parseSnippets(v.items);
    if (items.length !== v.items.length) return;
    return {type: 'snippets', items};
  }
  const a = v.agent;
  if (v.type === 'agent' && a && isProvider(a.id) && typeof a.enabled === 'boolean' && ['discuss', 'execute'].includes(a.mode) && typeof a.model === 'string' && a.model.length <= 100 && typeof a.effort === 'string' && ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(a.effort)
    && (a.instruction === undefined || typeof a.instruction === 'string' && a.instruction.length <= instructionLimit)) return v as Input;
}
