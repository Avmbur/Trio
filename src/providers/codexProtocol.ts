// Shapes checked against codex app-server generate-ts, 0.154.0-alpha.6.2.

const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const keys = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;
type Counters = Partial<Record<typeof keys[number], number>>;
function counters(raw: any): Counters | undefined {
  if (!raw || num(raw.inputTokens) === undefined || num(raw.outputTokens) === undefined) return;
  return Object.fromEntries(keys.filter(k => num(raw[k]) !== undefined).map(k => [k, raw[k]]));
}

export class CodexUsage {
  private previous?: Counters;
  private sum: Counters = {};
  // Before turn/start, resume can replay the thread's old totals. They establish a
  // baseline only. Without that replay, last is the first billable call of this turn.
  read(raw: any, active: boolean) {
    const total = counters(raw?.total), last = counters(raw?.last);
    if (!active) {this.previous = total; return;}
    let added = last;
    if (total && this.previous && keys.every(k => (total[k] ?? 0) >= (this.previous![k] ?? 0)))
      added = Object.fromEntries(keys.filter(k => total[k] !== undefined).map(k => [k, total[k]! - (this.previous![k] ?? 0)]));
    if (added) for (const k of keys) if (added[k] !== undefined) this.sum[k] = (this.sum[k] ?? 0) + added[k]!;
    if (total) this.previous = total;
    const input = this.sum.inputTokens, output = this.sum.outputTokens;
    const spent = input === undefined || output === undefined ? undefined : Math.max(0, input - (this.sum.cachedInputTokens ?? 0)) + output;
    const parts = spent === undefined ? [] : [
      'выход ' + output,
      this.sum.cacheWriteInputTokens === undefined ? 'запись кэша движком не сообщается' : 'запись кэша ' + this.sum.cacheWriteInputTokens,
      'чтение кэша ' + (this.sum.cachedInputTokens ?? 0), 'вход ' + input,
      'мысли ' + (this.sum.reasoningOutputTokens ?? 0) + ' (уже в выходе)'
    ];
    return {tokens: num(raw?.last?.totalTokens), window: num(raw?.modelContextWindow), spent,
      spentHint: parts.length ? parts.join(' · ') : undefined, raw};
  }
}

export function codexItemTitle(item: any): string {
  if (item?.type === 'commandExecution') return String(item.command || 'Выполнение команды');
  if (item?.type === 'fileChange') return 'Изменение файлов: ' + (item.changes || []).map((c: any) => c.path).join(', ');
  if (item?.type === 'mcpToolCall') return [item.server, item.tool].filter(Boolean).join(' · ');
  return String(item?.tool || item?.type || 'Codex работает');
}

// Codex renders argv with shell quoting, including adjacent quoted fragments.
// Decode that display layer before inspecting the actual -Command argument.
// Execpolicy amendments are only proposed prefixes, never a source of command text.
function invocationWords(raw: string): string[] | undefined {
  const words: string[] = []; let word = '', quote = '', started = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i], next = raw[i + 1];
    if (quote === "'") {
      if (c === "'") quote = ''; else word += c;
    } else if (c === '\\' && (quote !== '"' || next && /["\\$`\n]/.test(next))) {
      if (next === undefined) return;
      if (next !== '\n') word += next;
      i++; started = true;
    } else if (quote === '"') {
      if (c === '"') quote = ''; else word += c;
    } else if (c === "'" || c === '"') {
      quote = c; started = true;
    } else if (/\s/.test(c)) {
      if (started) {words.push(word); word = ''; started = false;}
    } else {
      word += c; started = true;
    }
  }
  if (quote) return;
  if (started) words.push(word);
  return words;
}
function commandBody(raw: string, depth = 0): {command: string; known: boolean; shell?: string} {
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/.exec(raw.trim().replace(/^&\s+/, ''));
  if (!match) return {command: raw, known: true};
  const shell = (match[1] || match[2] || match[3]).replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (!['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'].includes(shell)) return {command: raw, known: true};
  if (depth >= 3) return {command: raw, known: false};
  const args = match[4];
  const body = shell === 'cmd' ? /^(?:\/[ds]\s+)*\/c\s+([\s\S]+)$/i.exec(args)?.[1]
    : /^(?:(?:-NoProfile|-NonInteractive|-NoLogo|--noprofile|--norc)\s+)*-(?:Command|c|lc)\s+([\s\S]+)$/i.exec(args)?.[1];
  if (!body) return {command: raw, known: false};
  let text = body.trim();
  if (text[0] === '"' || text[0] === "'") {
    const words = invocationWords(text);
    // Never discard a command after the quoted argument.
    if (words?.length !== 1) return {command: raw, known: false};
    text = words[0];
  }
  const inner = commandBody(text, depth + 1);
  return {...inner, shell: inner.shell || (shell === 'pwsh' ? 'powershell' : shell)};
}

export function codexApproval(method: string, params: any, item?: any): {title: string; detail: string} {
  if (method.includes('commandExecution')) {
    const original = String(params.command || item?.command || '');
    const {command, known, shell} = commandBody(original);
    return {title: 'Выполнение команды', detail: JSON.stringify({...params, command, shell,
      ...(command !== original ? {shellCommand: original} : {}), kind: command && known ? 'execute' : 'danger'}, null, 2)};
  }
  const changes = Array.isArray(item?.changes) ? item.changes : Array.isArray(params.changes) ? params.changes : [];
  const safe = changes.length && changes.every((c: any) => ['add', 'update'].includes(c?.kind?.type ?? c?.kind));
  const deletion = changes.some((c: any) => (c?.kind?.type ?? c?.kind) === 'delete');
  return {title: deletion ? 'Удаление файлов' : 'Изменение файлов', detail: JSON.stringify({...params,
    name: 'apply_patch', kind: safe ? 'edit' : deletion ? 'delete' : 'danger',
    path: changes.map((c: any) => c.path).filter(Boolean).join(', '), changes}, null, 2)};
}
