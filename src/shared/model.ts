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
  for (const item of value) if (isProvider(item) && !order.includes(item)) order.push(item);
  return order.slice(0, 3);
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
}
export interface TraceStep {id: string; kind: 'tool' | 'thought'; title: string; status: 'running' | 'done'}
export interface Turn {
  id: string; messageId: string; recipient: Recipient; status: Status;
  executor?: Provider; mode?: Mode; replyId?: string; snapshot?: string;
  startedAt?: number; endedAt?: number;
  spent?: number; spentHint?: string;
  trace?: TraceStep[];
  cycle?: number;
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
}
// In the project root for the summary turn only; .gitignore lists it.
export const summaryFile = '.trio-summary.md';
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
  privilegeOn: false, privileges: []
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
function commandParts(raw: string, shell = ''): string[] | undefined {
  let source = raw;
  if (shell === 'powershell') {
    // Single-quoted here-strings are literal payloads, including JS $() and quotes.
    // Leave interpolated or unfinished here-strings for explicit approval.
    source = source.replace(/@'\r?\n[\s\S]*?\r?\n'@(?=\s|[;|)]|$)/g, ' ');
    if (/@['"]\r?\n/.test(source)) return;
  }
  if (/\$\(|\$\{/.test(source)) return;
  const unquoted = stripQuoted(stripHeredoc(source), shell);
  if (!unquoted.ok) return;
  const cleaned = unquoted.text.replace(/\s-m\s+\S+/gi, ' ').replace(/\s-F\s+\S+/gi, ' ');
  return cleaned.split(/\s*(?:&&|\|\||;|\||&|\r?\n)\s*/).map(p => p.trim()).filter(Boolean);
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
function commandPrivileges(raw: string, shell = ''): {needs: Set<Privilege>; safeCommand: boolean} | 'unparsed' {
  const parts = commandParts(raw, shell);
  if (!parts) return 'unparsed';
  const needs = new Set<Privilege>();
  let safeCommand = false;
  if (!parts.length) return 'unparsed';
  for (const part of parts) {
    const head = commandHead(part);
    if (!head) {needs.add('unparsed'); continue;}
    const key = head.bin.replace(/[^a-z0-9]+/g, '');
    if (['powershell', 'pwsh', 'bash', 'sh', 'zsh', 'cmd'].includes(head.bin)) needs.add('unparsed');
    else if (networkBins.has(key)) needs.add('network');
    else if (shellBins.has(key)) needs.add('shell');
    else if (head.bin === 'git' && dangerGit.has(head.arg.toLowerCase())) needs.add('git');
    else safeCommand = true;
  }
  return {needs, safeCommand};
}
function classifyCommand(raw: string, shell = ''): 'command' | 'danger' {
  const found = commandPrivileges(raw, shell);
  if (found === 'unparsed') return 'danger';
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
      if (!head) return '';
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
export function assignedMode(text: string, fallback: Mode): Mode {
  const body = text.trim().replace(/^(?:@)?(колян|claude|жека|codex|гриха|grok)[\s,:]+/iu, '');
  if (/обсуждаем|код не трогать/iu.test(body)) return 'discuss';
  if (/^(делай|сделай|исправь|реализуй|создай|напиши|выполни|удали|переименуй)(?=\s|[,.!]|$)/iu.test(body)) return 'execute';
  if (/^(обсуди|объясни|посмотри|проверь|оцени)(?=\s|[,.!]|$)/iu.test(body)) return 'discuss';
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
  | {type: 'layout'; side: 'left' | 'right'; width: number}
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
  if (v.responseOrder !== undefined && (!Array.isArray(v.responseOrder) || v.responseOrder.length > 3 || v.responseOrder.some((p: unknown) => !isProvider(p)) || new Set(v.responseOrder).size !== v.responseOrder.length)) return;
  if (v.discuss !== undefined && typeof v.discuss !== 'boolean') return;
  if (v.type === 'layout' && ['left', 'right'].includes(v.side) && typeof v.width === 'number' && Number.isFinite(v.width) && v.width >= 260 && v.width <= 600) return v as Input;
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
