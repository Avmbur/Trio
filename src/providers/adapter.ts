import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {ModelChoice, Provider, Usage, Quota, TraceStep, brief, QuestionItem, QuestionAnswers, answerLabels, questionKey} from '../shared/model';
import {codexApproval, codexItemTitle, CodexUsage} from './codexProtocol';
import {resolveCli, Launch, Supervisor} from '../processes/supervisor';
import {Channel, Rpc} from '../processes/channel';
import {writeAtomic} from '../storage/store';

export interface RunOptions {
  provider: Provider; cli: string; root: string; execute: boolean; prompt: string;
  model: string; effort: string; session?: string; timeout: number; ceiling?: number; signal: AbortSignal; jobRunner: string;
  onPid(pid: number): Promise<void>; onSession(id: string): Promise<void>;
  text(text: string): void; progress(text: string): void;
  trace?(steps: TraceStep[]): void;
  permission(title: string, detail: string): Promise<boolean>;
  question?(items: QuestionItem[], signal?: AbortSignal): Promise<QuestionAnswers | undefined>;
  usage?(report: UsageReport, source: string): void;
  compacted?(): void;
  notice?(title: string, detail?: string): void;
  activity?(): void;
}
export interface RunResult {text: string; error?: string; interrupted: boolean; stderr?: string; denied?: string;
  // Grok closed the prompt with stopReason cancelled, and Anton did not press Stop.
  cancelled?: boolean; refused?: boolean}
// What the engine reported about its own window. `tokens` is the occupancy after the turn,
// never the spend of the turn: those differ by an order of magnitude once a cache is reused.
// `raw` goes to diagnostics untouched, so a changed payload is visible instead of guessed.
export interface UsageReport {tokens?: number; window?: number; spent?: number; spentHint?: string; raw: unknown}
const cliIdentity = new Map<Provider, string>();
export function rememberCli(provider: Provider, file: string, handshake?: unknown) {
  const version = extractCliVersion(handshake);
  cliIdentity.set(provider, file + (version ? ' · ' + version : ''));
}
export function rememberedCli(provider: Provider): string | undefined {return cliIdentity.get(provider);}
export function extractCliVersion(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return;
  const obj = raw as Record<string, any>;
  const bags = [obj, obj._meta, obj.clientInfo, obj.implementation, obj.response, obj.serverInfo];
  const keys = ['cliVersion', 'cli_version', 'agentVersion', 'claude_code_version', 'claudeCodeVersion', 'grokVersion', 'version'];
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue;
    for (const key of keys) {
      const value = bag[key];
      if (typeof value === 'string' && value.trim() && !/^\d+$/.test(value.trim())) return value.trim();
    }
  }
  const version = typeof obj.userAgent === 'string'
    ? /(?:codex[^/\s]*|trio[^/\s]*)\/([0-9]+\.[0-9]+\.[0-9]+[^\s()]*)/i.exec(obj.userAgent)?.[1] : undefined;
  return version;
}
function field(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {const n = number(row[key]); if (n !== undefined) return n;}
}
export function joinChunks(text: string, chunk: string): string {
  // Stream boundaries carry no paragraph semantics; punctuation can split a path or code.
  return text + chunk;
}
// A tool call or thinking between two messages is a new stage, like Codex items and Claude blocks.
export function stageBreak(text: string): string {
  return text.trim() ? text.trimEnd() + '\n\n' : text;
}

function makeTracer(o: RunOptions) {
  const steps: TraceStep[] = [];
  const thoughts = new Map<string, string>();
  const emit = () => o.trace?.(steps.map(s => ({...s})));
  const cap = () => {
    while (steps.length > 40) {
      const gone = steps.shift();
      if (gone) thoughts.delete(gone.id);
    }
  };
  const finishThoughts = () => {
    for (const s of steps) if (s.kind === 'thought' && s.status === 'running') s.status = 'done';
  };
  return {
    thought(chunk: string) {
      if (!chunk) return;
      let last = steps.at(-1);
      if (last?.kind !== 'thought' || last.status !== 'running') {
        last = {id: 'thought-' + steps.length, kind: 'thought', title: '', status: 'running'};
        steps.push(last);
        thoughts.set(last.id, '');
      }
      const full = (thoughts.get(last.id) || '') + chunk;
      thoughts.set(last.id, full);
      last.title = brief(full, 80);
      cap(); emit();
    },
    tool(id: string, title: string, status: 'running' | 'done' = 'running') {
      finishThoughts();
      const key = id || title;
      for (const s of steps) if (s.kind === 'tool' && s.status === 'running' && s.id !== key) s.status = 'done';
      const existing = steps.find(s => s.id === key && s.kind === 'tool');
      if (existing) {
        if (title) existing.title = brief(title, 80);
        existing.status = status;
      } else steps.push({id: key, kind: 'tool', title: brief(title || key, 80), status});
      cap(); emit();
    },
    finish() {
      for (const s of steps) s.status = 'done';
      if (steps.length) emit();
    }
  };
}
export function spendHint(provider: Provider, raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return;
  const obj = raw as Record<string, any>;
  if (provider === 'claude') {
    const usage = obj.modelUsage && typeof obj.modelUsage === 'object' ? obj.modelUsage : obj;
    let input = 0, created = 0, read = 0, output = 0, seen = false, cost = 0;
    for (const item of Object.values(usage)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const inn = field(row, 'inputTokens', 'input_tokens');
      const out = field(row, 'outputTokens', 'output_tokens');
      if (inn === undefined && out === undefined) continue;
      input += inn ?? 0;
      created += field(row, 'cacheCreationInputTokens', 'cache_creation_input_tokens') ?? 0;
      read += field(row, 'cacheReadInputTokens', 'cache_read_input_tokens') ?? 0;
      output += out ?? 0;
      cost += field(row, 'costUSD', 'costUsd', 'cost') ?? 0;
      seen = true;
    }
    if (!seen) return;
    cost ||= field(obj, 'costUSD', 'costUsd', 'total_cost_usd', 'totalCostUsd') ?? 0;
    const parts = ['выход ' + output, 'запись кэша ' + created, 'чтение кэша ' + read, 'вход ' + input];
    if (cost) parts.push('$' + cost.toFixed(2) + ' по прайсу API');
    return parts.join(' · ');
  }
  if (provider === 'grok') {
    if (number(obj.inputTokens) === undefined) return;
    const created = number(obj.cacheCreationTokens);
    const parts = ['выход ' + (number(obj.outputTokens) ?? 0),
      created === undefined ? 'запись кэша движком не сообщается' : 'запись кэша ' + created,
      'чтение кэша ' + (number(obj.cachedReadTokens) ?? 0),
      'вход ' + (number(obj.inputTokens) ?? 0)];
    const reason = number(obj.reasoningTokens);
    if (reason) parts.push('мысли ' + reason);
    return parts.join(' · ');
  }
}
export function spendTokens(provider: Provider, raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return;
  const obj = raw as Record<string, any>;
  if (provider === 'claude') {
    const usage = obj.modelUsage && typeof obj.modelUsage === 'object' ? obj.modelUsage : obj;
    let total = 0, seen = false;
    for (const item of Object.values(usage)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const input = field(row, 'inputTokens', 'input_tokens');
      const created = field(row, 'cacheCreationInputTokens', 'cache_creation_input_tokens') ?? 0;
      const output = field(row, 'outputTokens', 'output_tokens');
      if (input === undefined && output === undefined) continue;
      total += (input ?? 0) + created + (output ?? 0);
      seen = true;
    }
    return seen ? total : undefined;
  }
  if (provider === 'grok') {
    const input = number(obj.inputTokens);
    if (input === undefined) return;
    const cached = number(obj.cachedReadTokens) ?? 0;
    const created = number(obj.cacheCreationTokens) ?? 0;
    const output = number(obj.outputTokens) ?? 0;
    const reason = number(obj.reasoningTokens) ?? 0;
    return Math.max(0, input - cached + created + output + reason);
  }
}
function usageRowMatch(top: any, row: any): boolean {
  if (!top || !row) return false;
  const pairs: [string[], string[]][] = [
    [['cache_read_input_tokens', 'cacheReadInputTokens'], ['cacheReadInputTokens', 'cache_read_input_tokens']],
    [['cache_creation_input_tokens', 'cacheCreationInputTokens'], ['cacheCreationInputTokens', 'cache_creation_input_tokens']],
    [['output_tokens', 'outputTokens'], ['outputTokens', 'output_tokens']],
    [['input_tokens', 'inputTokens'], ['inputTokens', 'input_tokens']]
  ];
  let hits = 0;
  for (const [a, b] of pairs) {
    const left = field(top, ...a), right = field(row, ...b);
    if (left !== undefined && left === right) hits++;
  }
  return hits >= 2;
}
export function pickContextWindow(usage: any, modelUsage: any): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return;
  const rows = Object.values(modelUsage).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  const matched = rows.find(row => usageRowMatch(usage, row));
  const pick = matched || rows.reduce((best: Record<string, unknown> | undefined, row) => {
    const sum = (field(row, 'inputTokens', 'input_tokens') ?? 0)
      + (field(row, 'cacheReadInputTokens', 'cache_read_input_tokens') ?? 0)
      + (field(row, 'cacheCreationInputTokens', 'cache_creation_input_tokens') ?? 0)
      + (field(row, 'outputTokens', 'output_tokens') ?? 0);
    const bestSum = best ? (field(best, 'inputTokens', 'input_tokens') ?? 0)
      + (field(best, 'cacheReadInputTokens', 'cache_read_input_tokens') ?? 0)
      + (field(best, 'cacheCreationInputTokens', 'cache_creation_input_tokens') ?? 0)
      + (field(best, 'outputTokens', 'output_tokens') ?? 0) : -1;
    return sum > bestSum ? row : best;
  }, undefined);
  return pick ? field(pick, 'contextWindow', 'context_window', 'modelContextWindow') : undefined;
}
const totalTokenKeys = ['tokens_used', 'tokensUsed', 'total_tokens', 'totalTokens', 'used_tokens', 'usedTokens',
  'context_tokens', 'contextTokens', 'token_count', 'tokenCount'];
const partTokenKeys = ['input_tokens', 'inputTokens', 'cache_read_input_tokens', 'cacheReadInputTokens',
  'cache_creation_input_tokens', 'cacheCreationInputTokens', 'output_tokens', 'outputTokens'];
const windowKeys = ['model_context_window', 'modelContextWindow', 'max_context_window', 'maxContextWindow',
  'context_window', 'contextWindow', 'contextWindowSize', 'totalContextTokens', 'maxContextTokens'];
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
function compactOnce(o: RunOptions) {
  let seen = false;
  return () => {if (seen || !o.compacted) return; seen = true; o.compacted();};
}
export function isAutoCompact(method = '', payload?: any): boolean {
  const m = method.toLowerCase();
  if (/auto[_-]?compact/.test(m)) return true;
  const bags = [payload];
  if (payload && typeof payload === 'object') {
    bags.push(payload.update, payload._meta);
  }
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue;
    const row = bag as Record<string, unknown>;
    const kind = String(row.subtype ?? row.type ?? row.kind ?? row.reason
      ?? row.trigger ?? row.notification ?? row.event
      ?? row.sessionUpdate ?? row.stopReason ?? '').toLowerCase();
    if (kind === 'compact_boundary' || kind === 'auto_compact' || kind === 'autocompact') return true;
    if (/auto[_-]?compact/.test(kind)) return true;
    if (/compact/.test(m) && (kind === 'auto' || row.reason === 'auto' || row.trigger === 'auto')) return true;
  }
  return false;
}
export function sumTokens(value: any): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  let parts = 0, counted = false;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) continue;
    if (totalTokenKeys.includes(key)) return item;
    if (partTokenKeys.includes(key)) {parts += item; counted = true;}
  }
  return counted ? parts : undefined;
}
// Fallback for an engine whose payload shape Trio has not seen live yet. Parts are summed
// within one object only: nested breakdowns (per iteration, per model, per session) repeat
// the same tokens, and adding them up inflates the figure several times over.
export function readUsage(raw: unknown): {tokens?: number; window?: number} {
  let tokens: number | undefined, window: number | undefined;
  const visit = (value: any, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (!Array.isArray(value)) {
      tokens ??= sumTokens(value);
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && windowKeys.includes(key)) window ??= item;
      }
    }
    for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item, depth + 1);
  };
  visit(raw, 0);
  return {tokens, window};
}
export function subscriptionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = {...source};
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|XAI_API_KEY|GROK_API_KEY)$/i.test(key)) delete env[key];
  }
  // The CLI owns subscription credentials; Trio never reads or stores tokens.
  return env;
}
export function isolatedEngineEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = subscriptionEnvironment(source);
  // Computer Hub / dashboard / workspace command would expose the same tree remotely.
  env.GROK_WORKSPACE_COMMAND = '0';
  env.GROK_AGENT_DASHBOARD = '0';
  return env;
}
export function claudeLaunchSettings(): Record<string, unknown> {
  return {forceLoginMethod: 'claudeai', disableRemoteControl: true, remoteControlAtStartup: false};
}
const claudeSettingsArg = JSON.stringify(claudeLaunchSettings());
const codexServerArgs = ['app-server', '--listen', 'stdio://',
  '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
  '-c', 'features.multi_agent=false', '-c', 'features.remote_control=false'];
const grokAgentArgs = ['agent', '--no-leader', 'stdio'];
export function requireSubscription(account: any, provider: 'codex' | 'claude') {
  const okay = provider === 'codex'
    ? account?.type === 'chatgpt'
    : account?.loggedIn === true && account?.authMethod === 'claude.ai' && account?.apiProvider === 'firstParty';
  if (!okay) throw new Error('Для ' + provider + ' нужен вход по подписке в официальном CLI. API-подключения в Trio отключены.');
}
export interface CompactOptions extends CatalogOptions {session: string; onPid(pid: number): Promise<void>}
// Each engine compresses its own history. Trio's feed is untouched.
export async function compactProvider(o: CompactOptions): Promise<void> {
  const launch = await resolveCli(o.cli);
  const env = isolatedEngineEnv(process.env);
  const timeout = new AbortController();
  const signal = AbortSignal.any([o.signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), o.timeout);
  let rpc: Rpc | undefined, finish!: () => void, fail!: (e: Error) => void, error = '', closing = false;
  let compactRequested = false;
  const done = new Promise<void>((resolve, reject) => {finish = resolve; fail = reject;});
  void done.catch(() => {});
  const args = o.provider === 'codex' ? [...codexServerArgs]
    : o.provider === 'grok' ? [...grokAgentArgs]
      : ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--permission-prompt-tool', 'stdio', '--permission-mode', 'plan',
        '--settings', claudeSettingsArg, '--resume=' + o.session];
  const channel = new Channel({launch, args, cwd: o.root, jobRunner: o.jobRunner, signal, env, onPid: o.onPid,
    onMessage: value => {
      if (o.provider === 'claude') {
        if (value?.type === 'result') {
          if (value.is_error) error = (value.errors || [value.result || 'Ошибка сжатия']).join('\n');
          finish();
        }
        return;
      }
      rpc!.receive(value, (method, p) => {
        if (o.provider !== 'codex' || !compactRequested || p?.threadId && p.threadId !== o.session) return;
        if (method === 'thread/compacted' || method === 'thread/compact/completed'
          || method === 'item/completed' && p.item?.type === 'contextCompaction') finish();
        if (method === 'error' && !p.willRetry) fail(new Error(p.error?.message || 'Ошибка сжатия Codex'));
        if (method === 'turn/completed' && p.turn?.status === 'failed') fail(new Error(p.turn.error?.message || 'Ошибка сжатия Codex'));
      }, async () => {throw new Error('Запрос не поддержан.');});
    }});
  if (o.provider !== 'claude') rpc = new Rpc(channel, o.provider === 'grok');
  const closed = channel.onClose;
  channel.onClose = e => {closed(e); if (!closing) fail(e); };
  try {
    await channel.open();
    if (o.provider === 'claude') {
      channel.write({type: 'user', message: {role: 'user', content: '/compact'}, parent_tool_use_id: null, session_id: o.session});
      await done;
    } else if (o.provider === 'grok') {
      const init = await rpc!.request('initialize', {protocolVersion: 1,
        clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}});
      requireGrokSubscription(init);
      await rpc!.request('session/load', {cwd: o.root, mcpServers: [], sessionId: o.session});
      // The documented extension method first; the slash command is the portable fallback.
      try {await rpc!.request('x.ai/compact_conversation', {sessionId: o.session});}
      catch {await rpc!.request('session/prompt', {sessionId: o.session, prompt: [{type: 'text', text: '/compact'}]});}
    } else {
      await rpc!.request('initialize', {clientInfo: {name: 'trio', title: 'Trio', version: '0.1.0'}, capabilities: {}});
      rpc!.notify('initialized');
      const account = await rpc!.request('account/read', {refreshToken: false});
      requireSubscription(account.account, 'codex');
      await rpc!.request('thread/resume', {cwd: o.root, threadId: o.session, excludeTurns: true});
      compactRequested = true;
      await rpc!.request('thread/compact/start', {threadId: o.session});
      await done;
    }
    if (error) throw new Error(error);
  } finally {clearTimeout(timer); closing = true; await channel.close();}
}
export interface CatalogOptions {
  provider: Provider; cli: string; root: string; jobRunner: string; signal: AbortSignal; timeout: number;
  home?: string; fetcher?: typeof fetch; now?: number; session?: string;
}
function addScalars(lines: string[], obj: any, heading?: string) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  const rows: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value == null || typeof value === 'object') continue;
    rows.push(key + ': ' + String(value));
  }
  if (!rows.length) return;
  if (heading) lines.push('', heading);
  lines.push(...rows);
}
export function parseResetAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
function formatReset(value: unknown): string {
  const at = parseResetAt(value);
  if (at !== undefined) return new Date(at).toLocaleString('ru-RU');
  return typeof value === 'string' ? value : '';
}
function formatRateLimits(lines: string[], account: any) {
  const buckets = account?.rateLimitsByLimitId
    || (account?.rateLimits ? {[account.rateLimits.limitId || 'plan']: account.rateLimits} : null);
  if (!buckets || typeof buckets !== 'object') return;
  const rows: string[] = [];
  for (const [id, bucket] of Object.entries(buckets as Record<string, any>)) {
    const primary = bucket?.primary;
    if (!primary || typeof primary.usedPercent !== 'number') continue;
    const reset = formatReset(primary.resetsAt);
    rows.push((bucket.limitName || id) + ': ' + primary.usedPercent + '%'
      + (primary.windowDurationMins ? ' / ' + primary.windowDurationMins + ' мин' : '')
      + (reset ? ', сброс ' + reset : ''));
  }
  if (!rows.length) return;
  lines.push('', 'Лимиты подписки', ...rows);
}
export function formatUsage(occupancy?: Usage, account?: any): string {
  const lines: string[] = [];
  if (occupancy && (occupancy.tokens !== undefined || occupancy.window !== undefined)) {
    const tokens = occupancy.tokens !== undefined ? occupancy.tokens.toLocaleString('ru-RU') : '—';
    const window = occupancy.window !== undefined ? occupancy.window.toLocaleString('ru-RU') : '—';
    const percent = occupancy.tokens !== undefined && occupancy.window ? Math.round(occupancy.tokens / occupancy.window * 100) + '%' : '';
    lines.push('Окно контекста', tokens + ' из ' + window + ' токенов' + (percent ? ' (' + percent + ')' : ''));
    if (occupancy.source) lines.push('источник: ' + occupancy.source);
  } else lines.push('Движок ещё не сообщал заполнение окна.');
  if (account && typeof account === 'object') {
    formatRateLimits(lines, account);
    if (account.session && typeof account.session === 'object') addScalars(lines, account.session, 'Сессия CLI');
    else if (!account.rateLimits && !account.rateLimitsByLimitId) addScalars(lines, account, 'Сессия CLI');
    if (Array.isArray(account.turns)) lines.push('ходов: ' + account.turns.length);
    if (account.plan || account.fiveHour || account.rateLimit) {
      addScalars(lines, {plan: account.plan, ...account.fiveHour, ...account.rateLimit}, 'Подписка');
    }
  }
  return lines.join('\n');
}
function windowPhrase(mins?: number): string {
  if (typeof mins !== 'number') return '';
  if (mins >= 10080) return Math.round(mins / 1440) + ' д';
  if (mins >= 1440) return Math.round(mins / 1440) + ' д';
  if (mins >= 60) return Math.round(mins / 60) + ' ч';
  return mins + ' мин';
}
function quotaLabel(path: string[], mins?: number): string | undefined {
  const joined = path.join('.');
  const last = path[path.length - 1] || '';
  // Internal meter ids are not a plan window. Showing them as a bar is noise, not a quota.
  if (/extra_usage|extraUsage|oauth_apps|cowork|iguana|nimbus_quill/i.test(joined)) return undefined;
  if (/^[a-z][a-z0-9]*_[a-z0-9_]+$/i.test(last) && !/five_hour|seven_day|used_percent|rate_limit/i.test(last))
    return undefined;
  let base: string;
  if (/five_hour|fiveHour|5h|five-hour/i.test(joined)) base = '5 ч';
  else if (/seven_day_sonnet|sevenDaySonnet/i.test(joined)) base = 'неделя · Sonnet';
  else if (/seven_day_opus|sevenDayOpus/i.test(joined)) base = 'неделя · Opus';
  else if (/seven_day|sevenDay|7d|week/i.test(joined)) base = 'неделя';
  else if (/secondary/i.test(joined) && (mins === undefined || mins >= 1440)) base = 'неделя';
  else if (typeof mins === 'number') {
    if (mins >= 10080) base = 'неделя';
    else if (mins >= 240 && mins <= 360) base = '5 ч';
    else base = windowPhrase(mins);
  } else if (/primary/i.test(joined)) base = '5 ч';
  else base = last || 'лимит';
  if (base === 'неделя') {
    const days = windowPhrase(mins) || '7 д';
    base = 'неделя · ' + days;
  }
  return base;
}
function unwrapNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = (value as {val?: unknown; value?: unknown}).val ?? (value as {value?: unknown}).value;
    if (typeof inner === 'number' && Number.isFinite(inner) && inner >= 0) return inner;
  }
}
function quotaPercent(obj: any): number | undefined {
  for (const key of ['usedPercent', 'used_percent', 'used_percentage', 'percent_used', 'percentUsed',
    'utilization', 'utilization_pct']) {
    const value = unwrapNumber(obj?.[key]);
    if (value !== undefined) return value;
  }
}
function quotaMinutes(obj: any): number | undefined {
  const value = obj?.windowDurationMins ?? obj?.window_duration_mins ?? obj?.window_minutes;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function extractQuotas(account: any, source = 'usage'): Quota[] {
  const found: Quota[] = [];
  const seen = new Set<string>();
  const visit = (obj: any, path: string[]) => {
    if (!obj || typeof obj !== 'object' || path.length > 6) return;
    const last = path[path.length - 1] || '';
    if (last === 'turns' || /extra_usage|extraUsage|oauth_apps|cowork|iguana/i.test(path.join('.'))) return;
    // Codex repeats its main bucket in rateLimits and rateLimitsByLimitId.
    // Prefer the map and identify windows by bucket + slot, never by percentage.
    const buckets = new Map<string, any>();
    if (obj.rateLimits && typeof obj.rateLimits === 'object')
      buckets.set(obj.rateLimits.limitId || 'codex', obj.rateLimits);
    if (obj.rateLimitsByLimitId && typeof obj.rateLimitsByLimitId === 'object') {
      for (const [id, bucket] of Object.entries(obj.rateLimitsByLimitId)) {
        if (bucket && typeof bucket === 'object') buckets.set(id, bucket);
      }
    }
    for (const [limitId, bucket] of buckets) {
      const limitName = limitId === 'base_model_inference'
        ? 'Резерв' + (bucket.normalModelSlug ? ' · ' + bucket.normalModelSlug : '')
        : bucket.limitName || (limitId === 'codex' ? 'Codex' : limitId);
      for (const slot of ['primary', 'secondary']) {
        const window = bucket[slot];
        const percent = quotaPercent(window);
        if (percent === undefined) continue;
        const key = 'codex:' + JSON.stringify([limitId, slot]);
        if (seen.has(key)) continue;
        seen.add(key);
        const resetAt = window.resetsAt ?? window.resets_at;
        found.push({percent, label: quotaLabel([slot], quotaMinutes(window)), limitId, limitName,
          resets: formatReset(resetAt) || undefined, resetsAt: parseResetAt(resetAt), source, at: Date.now()});
      }
    }
    const percent = quotaPercent(obj);
    if (percent !== undefined && !Array.isArray(obj)) {
      const mins = quotaMinutes(obj);
      const label = quotaLabel(path, mins);
      if (label) {
        const key = path.join('.') + ':' + Math.round(percent);
        if (!seen.has(key) && !seen.has(label + ':' + Math.round(percent))) {
          seen.add(key); seen.add(label + ':' + Math.round(percent));
          const resetAt = obj.resetsAt ?? obj.resets_at;
          found.push({percent, label, resets: formatReset(resetAt) || undefined, resetsAt: parseResetAt(resetAt),
            source, at: Date.now()});
        }
      }
    }
    if (Array.isArray(obj)) return;
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'rateLimits' && key !== 'rateLimitsByLimitId') visit(value, path.concat(key));
    }
  };
  visit(account, []);
  const rank = (label?: string) => !label ? 9 : label === '5 ч' ? 0 : label.startsWith('неделя') ? 2 : 3;
  const groupRank = (q: Quota) => q.limitId === 'codex' ? 0 : q.limitId === 'base_model_inference' ? 2 : 1;
  return found.sort((a, b) => groupRank(a) - groupRank(b)
    || (a.limitId || '').localeCompare(b.limitId || '') || rank(a.label) - rank(b.label));
}
export function extractQuota(account: any, source = 'usage', preferredLimitId?: string): Quota | undefined {
  const all = extractQuotas(account, source);
  const preferred = preferredLimitId || (all.some(q => q.limitId === 'codex') ? 'codex' : undefined);
  const windows = preferred ? all.filter(q => q.limitId === preferred || !q.limitId) : all;
  return windows.find(q => q.label === '5 ч') || windows.find(q => q.label === 'окно') || windows[0];
}
export function parseAgentQuestions(p: any, byId = false, multipleByDefault = false): QuestionItem[] {
  const raw = p?.questions || p?.items || p?.params?.questions || [];
  return (Array.isArray(raw) ? raw : []).map((q: any) => ({
    prompt: String(q.question || q.prompt || q.header || q.text || 'Вопрос'),
    ...(byId && typeof q.id === 'string' ? {id: q.id} : {}),
    ...(q.isSecret ? {secret: true} : {}),
    options: (Array.isArray(q.options || q.choices) ? q.options || q.choices : []).map((opt: any) => ({
      label: String(opt.label || opt.title || opt),
      description: opt.description ? String(opt.description) : undefined
    })),
    multi: !!(q.multiSelect ?? q.multi_select ?? q.multi ?? multipleByDefault)
  }));
}
export function withCustomAnswers(input: any, answers: QuestionAnswers) {
  const out: Record<string, string | string[]> = {};
  const questions = (Array.isArray(input?.questions) ? input.questions : []).map((q: any) => {
    const prompt = String(q.question || q.header || 'Вопрос');
    const answer = answers[prompt];
    const multi = !!(q.multiSelect || q.multi_select || q.multi);
    const labels = answerLabels(answer);
    if (labels.length) out[prompt] = multi ? labels : labels[0];
    return q;
  });
  return {...input, questions, answers: out};
}
export function grokQuestionResult(answers: QuestionAnswers, items?: QuestionItem[]) {
  const mapped: Record<string, string | string[]> = {};
  for (const [prompt, value] of Object.entries(answers))
    mapped[prompt] = items?.find(i => questionKey(i) === prompt)?.multi ? answerLabels(value) : answerLabels(value)[0] || '';
  return {outcome: 'accepted', answers: mapped, partial_answers: {}};
}
const usageCache = new Map<string, {at: number; data: any}>();
export function clearUsageCache() {usageCache.clear();}
function usageHome(o: {home?: string}) {return o.home || os.homedir();}
function usageNow(o: {now?: number}) {return o.now ?? Date.now();}
function usageFetcher(o: {fetcher?: typeof fetch}): typeof fetch {
  return o.fetcher || ((...args: Parameters<typeof fetch>) => fetch(...args));
}
const expiredHint = (who: string) =>
  'Токен CLI просрочен: сделай ход ' + who + ', CLI обновит сам.';
const claudeOauthClient = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const claudeOauthToken = 'https://console.anthropic.com/v1/oauth/token';
export function expiryMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
export function redactSecrets(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const out: any = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(accessToken|refreshToken|access_token|refresh_token|authorization|secret|password|key)$/i.test(key)) continue;
    out[key] = typeof item === 'object' && item ? redactSecrets(item) : item;
  }
  return out;
}
async function claudeRefreshToken(o: {home?: string; now?: number; fetcher?: typeof fetch}, creds: any, oauth: any): Promise<{token: string; plan?: string}> {
  const refresh = oauth?.refreshToken || oauth?.refresh_token || '';
  if (!refresh) throw new Error(expiredHint('Коляном'));
  const response = await usageFetcher(o)(claudeOauthToken, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'claude-code/2.0'},
    body: 'grant_type=refresh_token&client_id=' + claudeOauthClient + '&refresh_token=' + encodeURIComponent(refresh),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(expiredHint('Коляном'));
  const body: any = await response.json();
  const token = typeof body?.access_token === 'string' ? body.access_token : '';
  if (!token) throw new Error(expiredHint('Коляном'));
  oauth.accessToken = token;
  if (typeof body.refresh_token === 'string' && body.refresh_token) oauth.refreshToken = body.refresh_token;
  const expires = expiryMs(body.expires_at) || (typeof body.expires_in === 'number' && body.expires_in > 0
    ? usageNow(o) + body.expires_in * 1000 : usageNow(o) + 8 * 3600 * 1000);
  oauth.expiresAt = expires;
  const file = path.join(usageHome(o), '.claude', '.credentials.json');
  await writeAtomic(file, JSON.stringify(creds, null, 2));
  const plan = [oauth?.subscriptionType, oauth?.rateLimitTier].filter(Boolean).join(' · ') || undefined;
  return {token, plan};
}
export async function claudeAccessToken(o: {home?: string; now?: number; fetcher?: typeof fetch; forceRefresh?: boolean} = {}): Promise<{token: string; plan?: string}> {
  let creds: any, oauth: any;
  try {
    creds = JSON.parse(await fs.readFile(path.join(usageHome(o), '.claude', '.credentials.json'), 'utf8'));
    oauth = creds?.claudeAiOauth || creds;
  } catch {throw new Error(expiredHint('Коляном'));}
  const token = oauth?.accessToken || oauth?.access_token || '';
  const expires = expiryMs(oauth?.expiresAt ?? oauth?.expires_at);
  const plan = [oauth?.subscriptionType, oauth?.rateLimitTier].filter(Boolean).join(' · ') || undefined;
  if (!o.forceRefresh && token && !(expires > 0 && expires < usageNow(o) + 30000)) return {token, plan};
  return claudeRefreshToken(o, creds, oauth);
}
export async function readClaudeOauthUsage(o: CatalogOptions): Promise<any> {
  let {token, plan} = await claudeAccessToken(o);
  const get = async (value: string) => usageFetcher(o)('https://api.anthropic.com/api/oauth/usage', {
    headers: {Authorization: 'Bearer ' + value, 'User-Agent': 'claude-code/2.0', Accept: 'application/json'},
    signal: AbortSignal.any([o.signal, AbortSignal.timeout(10000)])
  });
  let response = await get(token);
  if (response.status === 401) {
    const next = await claudeAccessToken({...o, forceRefresh: true});
    token = next.token; plan = next.plan || plan;
    response = await get(token);
  }
  if (response.status === 401) throw new Error(expiredHint('Коляном'));
  if (!response.ok) throw new Error('Claude usage: HTTP ' + response.status);
  const body = await response.json() as object;
  return redactSecrets({...body, ...(plan ? {plan} : {})});
}
export async function grokAccessToken(o: {home?: string; now?: number} = {}): Promise<{token: string; plan?: string}> {
  let data: any;
  try {data = JSON.parse(await fs.readFile(path.join(usageHome(o), '.grok', 'auth.json'), 'utf8'));}
  catch {throw new Error(expiredHint('Грихой'));}
  const entry = Object.values(data || {}).find((item: any) => item && typeof item.key === 'string') as any;
  if (!entry?.key) throw new Error(expiredHint('Грихой'));
  const expires = expiryMs(entry.expires_at ?? entry.expiresAt);
  if (expires > 0 && expires < usageNow(o) + 30000) throw new Error(expiredHint('Грихой'));
  return {token: entry.key, plan: entry.auth_mode || entry.plan};
}
function grokPlan(billing: any, user?: any): string | undefined {
  for (const obj of [user, billing, billing?.config, user?.subscription, billing?.subscription]) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of ['subscriptionTier', 'subscription_tier', 'plan', 'planName', 'plan_name', 'tier']) {
      if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key].trim();
    }
  }
}
function grokPercent(obj: any): number | undefined {
  if (!obj || typeof obj !== 'object') return;
  const named = quotaPercent(obj)
    ?? unwrapNumber(obj.creditUsagePercent ?? obj.usagePercent ?? obj.usage_percent ?? obj.percent);
  if (named !== undefined) return named;
  const used = unwrapNumber(obj.used ?? obj.totalUsed ?? obj.includedUsed ?? obj.creditsUsed ?? obj.onDemandUsed);
  const limit = unwrapNumber(obj.limit ?? obj.monthlyLimit ?? obj.cap ?? obj.onDemandCap ?? obj.allowance);
  if (used !== undefined && limit !== undefined && limit > 0) return Math.min(100, used / limit * 100);
}
export function normalizeGrokBilling(billing: any, user?: any): any {
  const cfg = billing?.config && typeof billing.config === 'object' ? billing.config : billing || {};
  const period = cfg.currentPeriod && typeof cfg.currentPeriod === 'object' ? cfg.currentPeriod
    : billing?.currentPeriod && typeof billing.currentPeriod === 'object' ? billing.currentPeriod : {};
  const kind = String(period.type || period.kind || cfg.periodType || '').toLowerCase();
  const percent = grokPercent(cfg) ?? grokPercent(billing) ?? grokPercent(period);
  const resets = period.end || period.resetsAt || period.resets_at || cfg.billingPeriodEnd || billing?.billingPeriodEnd;
  const window = /week|seven|7d/.test(kind) ? 'seven_day' : 'five_hour';
  const out: any = {plan: grokPlan(billing, user)};
  if (typeof percent === 'number') out[window] = {utilization: percent, resets_at: resets};
  else if (resets) out[window] = {resets_at: resets};
  const unified = cfg.isUnifiedBillingUser === true || billing?.isUnifiedBillingUser === true;
  if (unified) out.unified = true;
  if (typeof percent !== 'number' && (out.plan || resets || unified)) {
    const when = resets ? formatReset(resets) : '';
    out.hint = when
      ? 'Процент лимита CLI в этом ответе не отдаёт. Сброс ' + when + '.'
      : 'Процент лимита CLI в этом ответе не отдаёт.';
  }
  return out;
}
export async function readGrokOauthUsage(o: CatalogOptions): Promise<any> {
  const {token, plan} = await grokAccessToken(o);
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(10000)]);
  const get = async (url: string) => {
    const response = await usageFetcher(o)(url, {
      headers: {Authorization: 'Bearer ' + token, Accept: 'application/json', 'X-XAI-Token-Auth': 'xai-grok-cli'},
      signal
    });
    if (response.status === 401 || response.status === 403) throw new Error(expiredHint('Грихой'));
    if (!response.ok) throw new Error('Grok usage: HTTP ' + response.status);
    return response.json();
  };
  const billing = await get('https://cli-chat-proxy.grok.com/v1/billing?format=credits');
  let user: any;
  try {user = await get('https://cli-chat-proxy.grok.com/v1/user?include=subscription');} catch {user = {plan};}
  return redactSecrets(normalizeGrokBilling(billing, user));
}
async function grokRpcBilling(rpc: Rpc): Promise<any | undefined> {
  const errors: string[] = [];
  for (const method of ['_x.ai/billing', 'x.ai/billing']) {
    try {
      const billing = await rpc.request(method, {});
      if (billing) return billing;
      errors.push(method + ': пусто');
    } catch (e) {errors.push(method + ': ' + String(e));}
  }
  throw new Error(errors.join(' | '));
}
async function grokQuotaAfterTurn(rpc: Rpc, o: RunOptions): Promise<void> {
  const errors: string[] = [];
  let rpcBilling: any, httpBilling: any;
  try {
    rpcBilling = await grokRpcBilling(rpc);
    const raw = redactSecrets(normalizeGrokBilling(rpcBilling, rpcBilling));
    if (extractQuotas(raw).length) {o.usage?.({raw}, 'x.ai/billing'); return;}
    errors.push('rpc: пустой тариф');
  } catch (e) {errors.push(String(e));}
  try {
    httpBilling = await readGrokOauthUsage({provider: 'grok', cli: o.cli, root: o.root, jobRunner: o.jobRunner,
      signal: o.signal, timeout: Math.min(8000, o.timeout)});
    if (extractQuotas(httpBilling).length) {o.usage?.({raw: httpBilling}, 'cli-chat-proxy'); return;}
    errors.push('http: пустой тариф');
  } catch (e) {errors.push('http: ' + String(e));}
  o.usage?.({raw: redactSecrets({error: errors.join(' | '), rpc: rpcBilling, http: httpBilling})}, 'billing');
}
async function readGrokAcpBilling(o: CatalogOptions): Promise<any | undefined> {
  const launch = await resolveCli(o.cli);
  const env = isolatedEngineEnv(process.env);
  const timeout = new AbortController();
  const signal = AbortSignal.any([o.signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), Math.min(8000, o.timeout));
  let rpc: Rpc | undefined;
  const channel = new Channel({launch, args: [...grokAgentArgs], cwd: o.root, jobRunner: o.jobRunner,
    signal, env, onPid: async () => {}, onMessage: value => {rpc!.receive(value, () => {}, async () => {throw new Error('Запрос не поддержан.');});}});
  rpc = new Rpc(channel, true);
  try {
    await channel.open();
    const init = await rpc.request('initialize', {protocolVersion: 1,
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}});
    requireGrokSubscription(init);
    const billing = await grokRpcBilling(rpc);
    if (!billing) return undefined;
    return redactSecrets(normalizeGrokBilling(billing, billing));
  } catch {return undefined;}
  finally {clearTimeout(timer); await channel.close();}
}
async function readGrokSessionUsage(o: CatalogOptions & {session: string}): Promise<any> {
  const launch = await resolveCli(o.cli);
  const env = isolatedEngineEnv(process.env);
  let out = '';
  const result = await new Supervisor(o.jobRunner, env).run(launch, ['usage', o.session], o.root, '', o.timeout, line => {out += line + '\n';});
  if (result.interrupted) throw new Error('Чтение usage остановлено.');
  const text = out.trim();
  if (!text) throw new Error((result.stderr || 'CLI usage ничего не вернул.').slice(0, 300));
  try {return JSON.parse(text);}
  catch {throw new Error('CLI usage вернул не JSON: ' + text.slice(0, 200));}
}
export async function readProviderUsage(o: CatalogOptions): Promise<any> {
  const hit = usageCache.get(o.provider);
  if (hit && usageNow(o) - hit.at < 60000) return hit.data;
  const data = o.provider === 'grok' ? await readGrokUsage(o)
    : o.provider === 'claude' ? await readClaudeUsage(o)
      : await readCodexUsage(o);
  const clean = redactSecrets(data);
  usageCache.set(o.provider, {at: usageNow(o), data: clean});
  return clean;
}
export async function readGrokUsage(o: CatalogOptions): Promise<any> {
  let session: any;
  if (o.session) {
    try {session = await readGrokSessionUsage(o as CatalogOptions & {session: string});}
    catch {session = undefined;}
  }
  let billing = await readGrokAcpBilling(o);
  if (!extractQuotas(billing).length) {
    try {billing = await readGrokOauthUsage(o);}
    catch (e) {
      if (!session) throw e;
      return redactSecrets({session: session.session || session, turns: session.turns, hint: String(e)});
    }
  }
  return redactSecrets({...billing, session: session?.session || session, turns: session?.turns});
}
async function readClaudeUsage(o: CatalogOptions): Promise<any> {
  const launch = await resolveCli(o.cli);
  const env = isolatedEngineEnv(process.env);
  let raw = '';
  const result = await new Supervisor(o.jobRunner, env).run(launch, ['auth', 'status', '--json'], o.root, '', Math.min(60000, o.timeout), line => {raw += line + '\n';});
  if (result.interrupted) throw new Error('Чтение usage остановлено.');
  if (result.code !== 0) throw new Error('Claude: не удалось прочитать статус подписки.');
  const auth = JSON.parse(raw);
  if (extractQuotas(auth).length) return redactSecrets(auth);
  const oauth = await readClaudeOauthUsage(o);
  return redactSecrets({...auth, ...oauth, plan: oauth.plan || auth.plan || auth.subscriptionType});
}
async function readCodexUsage(o: CatalogOptions): Promise<any> {
  const launch = await resolveCli(o.cli);
  const env = isolatedEngineEnv(process.env);
  const timeout = new AbortController();
  const signal = AbortSignal.any([o.signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), o.timeout);
  let rpc: Rpc | undefined;
  const channel = new Channel({launch, args: [...codexServerArgs], cwd: o.root, jobRunner: o.jobRunner, signal, env, onPid: async () => {},
    onMessage: value => {rpc!.receive(value, () => {}, async () => {throw new Error('Запрос не поддержан.');});}});
  rpc = new Rpc(channel);
  try {
    await channel.open();
    await rpc.request('initialize', {clientInfo: {name: 'trio', title: 'Trio', version: '0.1.0'}, capabilities: {}});
    rpc.notify('initialized');
    const account = await rpc.request('account/read', {refreshToken: false});
    requireSubscription(account.account, 'codex');
    const limits = await rpc.request('account/rateLimits/read', {});
    let usage: any;
    try {usage = await rpc.request('account/usage/read', {});} catch {usage = undefined;}
    return {...limits, ...(usage && typeof usage === 'object' ? {usage} : {})};
  } finally {clearTimeout(timer); await channel.close();}
}
const effortRank: Record<string, number> = {minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5};
const choice = (value: string, label: unknown, description: unknown, efforts: unknown[]): ModelChoice =>
  ({value, label: typeof label === 'string' && label ? label : value,
    description: typeof description === 'string' ? description : undefined,
    efforts: [...new Set(efforts.filter((e): e is string => typeof e === 'string' && !!e))]
      .sort((a, b) => (effortRank[a] ?? 50) - (effortRank[b] ?? 50))});
// Reads what the installed CLI itself offers. No turn is started, so no model is called.
export async function readCatalog(o: CatalogOptions): Promise<ModelChoice[]> {
  const launch = await resolveCli(o.cli);
  const env = isolatedEngineEnv(process.env);
  const timeout = new AbortController();
  const signal = AbortSignal.any([o.signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), o.timeout);
  let rpc: Rpc | undefined, settle!: (value: any) => void, reject!: (e: Error) => void;
  const answer = new Promise<any>((resolve, fail) => {settle = resolve; reject = fail;});
  void answer.catch(() => {});
  const args = o.provider === 'codex' ? [...codexServerArgs]
    : o.provider === 'grok' ? [...grokAgentArgs]
      : ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--permission-prompt-tool', 'stdio', '--permission-mode', 'plan', '--settings', claudeSettingsArg];
  const channel = new Channel({launch, args, cwd: o.root, jobRunner: o.jobRunner, signal, env, onPid: async () => {},
    onMessage: value => {
      if (o.provider === 'claude') {
        if (value?.type === 'control_response' && value.response?.request_id === 'trio-catalog') {
          if (value.response.subtype === 'error') reject(new Error(value.response.error));
          else settle(value.response.response);
        }
        return;
      }
      rpc!.receive(value, () => {}, async () => {throw new Error('Запрос не поддержан.');});
    }});
  if (o.provider !== 'claude') rpc = new Rpc(channel, o.provider === 'grok');
  const closed = channel.onClose;
  channel.onClose = e => {closed(e); reject(e);};
  try {
    await channel.open();
    if (o.provider === 'claude') {
      channel.write({type: 'control_request', request_id: 'trio-catalog', request: {subtype: 'initialize'}});
      const init = await answer;
      return (init?.models || []).map((m: any) =>
        choice(String(m?.value ?? ''), m?.displayName, m?.description, m?.supportsEffort ? m?.supportedEffortLevels || [] : []))
        .filter((m: ModelChoice) => m.value);
    }
    if (o.provider === 'grok') {
      const init = await rpc!.request('initialize', {protocolVersion: 1,
        clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}});
      requireGrokSubscription(init);
      return (init?._meta?.modelState?.availableModels || []).map((m: any) =>
        choice(String(m?.modelId ?? ''), m?.name, m?.description,
          m?._meta?.supportsReasoningEffort ? (m?._meta?.reasoningEfforts || []).map((e: any) => e?.value) : []))
        .filter((m: ModelChoice) => m.value);
    }
    await rpc!.request('initialize', {clientInfo: {name: 'trio', title: 'Trio', version: '0.1.0'}, capabilities: {}});
    rpc!.notify('initialized');
    const account = await rpc!.request('account/read', {refreshToken: false});
    requireSubscription(account.account, 'codex');
    const list = await rpc!.request('model/list', {});
    return (list?.data || []).filter((m: any) => !m?.hidden).map((m: any) =>
      choice(String(m?.id ?? ''), m?.displayName, m?.description, (m?.supportedReasoningEfforts || []).map((e: any) => e?.reasoningEffort)))
      .filter((m: ModelChoice) => m.value);
  } finally {clearTimeout(timer); await channel.close();}
}
export function requireGrokSubscription(init: any) {
  const methods: any[] = Array.isArray(init?.authMethods) ? init.authMethods : [];
  // A cached token means grok login; XAI_API_KEY is already stripped from the environment.
  if (!methods.some(m => m?.id === 'cached_token') || init?._meta?.defaultAuthMethodId !== 'cached_token')
    throw new Error('Для Grok нужен вход по подписке: выполните grok login в терминале. API-подключения в Trio отключены.');
}
// Idle budget resets on progress/text. It does not tick while Trio waits for Anton.
// A separate ceiling aborts a turn that never ends, even if the CLI keeps talking.
export function remainingTimer(ms: number, abort: (reason: 'idle' | 'ceiling') => void, ceilingMs = 3600000) {
  const budget = Math.max(0, ms), cap = Math.max(0, ceilingMs), begun = Date.now();
  let remaining = budget, started = Date.now(), holds = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wallLeft = () => Math.max(0, begun + cap - Date.now());
  const fire = () => {
    timer = undefined;
    abort(Date.now() >= begun + cap ? 'ceiling' : 'idle');
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(fire, holds ? wallLeft() : Math.min(Math.max(0, remaining), wallLeft()));
  };
  arm();
  return {
    hold() {
      if (holds++ !== 0) return;
      remaining -= Date.now() - started;
      arm();
    },
    release() {
      if (holds === 0 || --holds !== 0) return;
      started = Date.now();
      if (remaining <= 0 || wallLeft() <= 0) fire(); else arm();
    },
    touch() {
      remaining = budget;
      if (holds) return;
      started = Date.now();
      arm();
    },
    stop() {clearTimeout(timer); timer = undefined;}
  };
}
export async function runProvider(o: RunOptions): Promise<RunResult> {
  const timeout = new AbortController();
  const signal = AbortSignal.any([o.signal, timeout.signal]);
  let stage = 'поиск CLI', text = '', kind: 'idle' | 'ceiling' | undefined;
  const clock = remainingTimer(o.timeout, reason => {kind = reason; timeout.abort();}, o.ceiling ?? 3600000);
  const wait = async <T>(work: Promise<T>): Promise<T> => {
    clock.hold();
    try {return await work;} finally {clock.release();}
  };
  const options = {...o, signal,
    activity: () => {clock.touch(); o.activity?.();},
    progress: (value: string) => {clock.touch(); stage = value; o.progress(value);},
    text: (value: string) => {clock.touch(); text = value; o.text(value);},
    trace: (steps: TraceStep[]) => {clock.touch(); o.trace?.(steps);},
    permission: (title: string, detail: string) => wait(o.permission(title, detail)),
    question: o.question ? (items: QuestionItem[], signal?: AbortSignal) =>
      wait(o.question!(items, signal)) : undefined
  };
  const timedOut = () => ({
    text, interrupted: false,
    error: (kind === 'ceiling'
      ? 'Ход шёл дольше ' + Math.round((o.ceiling ?? 3600000) / 60000) + ' мин'
      : 'Нет ответа ' + Math.round(o.timeout / 1000) + ' с')
      + '. Этап: ' + stage + '. Процесс остановлен; повторного запуска нет.'
  });
  try {
    const result = await (o.provider === 'codex' ? codex(options) : o.provider === 'grok' ? grok(options) : claude(options));
    if (o.signal.aborted) return {...result, interrupted: true, error: undefined};
    if (timeout.signal.aborted) return {...result, ...timedOut()};
    return result;
  } catch (e) {
    if (o.signal.aborted) return {text, interrupted: true};
    if (timeout.signal.aborted) return timedOut();
    return {text, interrupted: false, error: 'Этап: ' + stage + '. ' + String(e)};
  } finally {clock.stop();}
}
async function codex(o: RunOptions): Promise<RunResult> {
  const launch = await resolveCli(o.cli);
  let closing = false;
  let rpc: Rpc, text = '', error = '', denied = '', complete!: () => void, session = o.session || '', accepting = false;
  let rolloutMiss = '';
  const finished = new Promise<void>(resolve => {complete = resolve;});
  const items = new Map<string, string>();
  const startedItems = new Map<string, any>();
  const meter = new CodexUsage();
  let turnId = '', turnEnded = false;
  const asyncQuestions = new Set<string>();
  const questionLife = new AbortController();
  const questionSignal = AbortSignal.any([o.signal, questionLife.signal]);
  let pendingQuestions = 0, questionQueue: Promise<void> = Promise.resolve();
  const finishIfReady = () => {if (turnEnded && !pendingQuestions) complete();};
  async function startTurn(input: {type: string; text: string}[]) {
    turnId = ''; turnEnded = false;
    const started = await rpc.request('turn/start', {threadId: session, input,
      ...(o.effort ? {effort: o.effort} : {})});
    turnId ||= started.turn?.id || '';
  }
  function askAsync(item: any): boolean {
    if (item.delivery !== 'async' || !item.id || !Array.isArray(item.questions) || !item.questions.length || !o.question) return false;
    // request_user_input_async emits an agentMessage, not a server RPC request.
    // Handle completed items: this event need not have an item/started precursor.
    if (asyncQuestions.has(item.id)) return true;
    asyncQuestions.add(item.id); pendingQuestions++;
    // Async questions accept several answers; show checkboxes immediately.
    // Explicit single-selection flags still take precedence over this default.
    const questions = parseAgentQuestions({questions: item.questions.map((q: any, i: number) => ({
      ...q, id: item.id + ':' + i, question: q.title
    }))}, true, true);
    o.usage?.({raw: {itemId: item.id, questions: item.questions}}, 'question/async');
    questionQueue = questionQueue.then(async () => {
      if (questionSignal.aborted) return;
      const answers = await o.question!(questions, questionSignal);
      if (questionSignal.aborted) return;
      // Keep each selection intact, including commas and several free answers.
      const input = [{type: 'text', text: answers
        ? 'Ответы Антона на вопросы:\n' + questions.map(q => q.prompt + '\n'
          + JSON.stringify(answerLabels(answers[questionKey(q)]))).join('\n\n')
        : 'Антон закрыл вопрос без ответа. Выбор не сделан.'}];
      if (!turnEnded) {
        try {
          await rpc.request('turn/steer', {threadId: session, expectedTurnId: turnId, input});
          return;
        } catch (e) {
          // Retry only if completion actually arrived while steer was in flight.
          // Never turn a transport error into a duplicate answer or a fresh turn.
          if (!turnEnded || error || denied || questionSignal.aborted) throw e;
        }
      }
      if (answers && !questionSignal.aborted && !error && !denied) await startTurn(input);
    }).catch(e => {
      if (!questionSignal.aborted) {
        error = 'Не удалось передать ответ на вопрос Codex: ' + String(e);
        o.usage?.({raw: {itemId: item.id, error}}, 'question/async');
        questionLife.abort(); complete();
      }
    }).finally(() => {pendingQuestions--; finishIfReady();});
    return true;
  }
  const compacted = compactOnce(o);
  const tracer = makeTracer(o);
  const channel = new Channel({launch, args: [...codexServerArgs],
    cwd: o.root, jobRunner: o.jobRunner, signal: o.signal, onPid: o.onPid, env: isolatedEngineEnv(process.env),
    onMessage: value => rpc.receive(value, notification, permission)});
  rpc = new Rpc(channel);
  const rpcClose = channel.onClose;
  channel.onClose = e => {rpcClose(e); if (!closing && !error) error = e.message; questionLife.abort(); complete();};
  function notification(method: string, p: any) {
    if (p?.threadId && p.threadId !== session) return;
    if (accepting && method === 'turn/started' && !turnId) turnId = p.turn?.id || '';
    const eventTurn = p?.turnId || (method.startsWith('turn/') ? p?.turn?.id : undefined);
    if (accepting && eventTurn && turnId && eventTurn !== turnId) return;
    if (method === 'account/rateLimits/updated') o.usage?.({raw: p}, method);
    if (method === 'thread/tokenUsage/updated') {
      const report = meter.read(p.tokenUsage, accepting && !turnEnded);
      if (report) o.usage?.(report, method);
    }
    if (method === 'thread/compacted' || isAutoCompact(method, p)
      || method === 'item/completed' && p.item?.type === 'contextCompaction') compacted();
    if (!accepting || turnEnded) return;
    if (p?.turnId && turnId && p.turnId !== turnId) return;
    if (method.startsWith('item/') || method === 'thread/tokenUsage/updated') o.activity?.();
    if (method === 'item/agentMessage/delta' && !asyncQuestions.has(p.itemId)) {
      items.set(p.itemId, (items.get(p.itemId) || '') + p.delta);
      text = [...items.values()].join('\n\n'); o.text(text);
    }
    if (method === 'item/completed' && p.item?.type === 'agentMessage') {
      if (askAsync(p.item)) items.delete(p.item.id);
      else items.set(p.item.id, p.item.text);
      text = [...items.values()].join('\n\n'); o.text(text);
    }
    if (method === 'item/started') {
      if (p.item?.id) startedItems.set(p.item.id, p.item);
      if (!['agentMessage', 'userMessage', 'reasoning'].includes(p.item?.type)) {
        const label = codexItemTitle(p.item);
        o.progress(brief(label, 120)); tracer.tool(String(p.item?.id || label), label);
      }
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') tracer.thought(String(p.delta || ''));
    if (method === 'item/completed' && p.item?.id) {
      if (!['agentMessage', 'userMessage', 'reasoning'].includes(p.item.type)) tracer.tool(String(p.item.id), codexItemTitle(p.item), 'done');
      startedItems.delete(p.item.id);
    }
    if (method === 'error' && !p.willRetry) error = p.error?.message || 'Ошибка Codex';
    if (method === 'turn/completed') {
      // Legacy servers can still include occupancy here. Current servers report it separately.
      const reported = p.turn?.usage ?? p.usage;
      o.usage?.({...readUsage(reported), raw: reported ?? p.turn}, 'turn/completed');
      if (p.turn?.status === 'failed') error = p.turn.error?.message || error || 'Ход завершился ошибкой.';
      if (p.turn?.status === 'interrupted') error = 'Ход прерван.';
      turnEnded = true;
      if (error || denied) {questionLife.abort(); complete();}
      else finishIfReady();
    }
  }
  async function permission(method: string, p: any) {
    if (p?.threadId && p.threadId !== session) throw new Error('Запрос другой сессии.');
    if (p?.turnId && turnId && p.turnId !== turnId || !accepting || turnEnded) throw new Error('Запрос неактивного хода.');
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      if (!o.execute) return {decision: 'decline'};
      const request = codexApproval(method, p, startedItems.get(p.itemId));
      const allow = await o.permission(request.title, request.detail);
      if (!allow && !o.signal.aborted) denied = request.title;
      return {decision: allow ? 'accept' : 'cancel'};
    }
    if (method === 'item/tool/requestUserInput') {
      const questions = parseAgentQuestions(p, true);
      const answers = o.question ? await o.question(questions) : undefined;
      return {answers: Object.fromEntries(questions.map(q => [questionKey(q), {answers: answerLabels(answers?.[questionKey(q)])}]))};
    }
    o.notice?.(method, JSON.stringify(redactSecrets(p)));
    throw new Error('Этот запрос Codex пока не поддержан: ' + method);
  }
  try {
    await channel.open();
    const handshake = await rpc.request('initialize', {clientInfo: {name: 'trio', title: 'Trio', version: '0.1.0'}, capabilities: {}});
    o.usage?.({raw: handshake}, 'handshake');
    rememberCli(o.provider, launch.file, handshake);
    rpc.notify('initialized');
    const account = await rpc.request('account/read', {refreshToken: false});
    requireSubscription(account.account, 'codex');
    const params = {cwd: o.root, model: o.model || null, modelProvider: 'openai',
      approvalPolicy: o.execute ? 'on-request' : 'never', approvalsReviewer: 'user',
      ...(o.execute ? {developerInstructions: 'В Trio включены Правки. Изменения в рамках поручения разрешены через стандартные запросы согласования инструментов. Начальная песочница read-only защищает записи до разрешения; это не режим обсуждения и не повод просить Антона заново включить Правки.'} : {}),
      // File edits inside workspace-write can skip requestApproval altogether.
      // Keep writes gated by the CLI so Trio sees each patch, including deletions;
      // explicit accept permits that action. Read-only shell work remains available.
      sandbox: 'read-only'};
    const started = o.session
      // Keep prior turns: Trio now sends only the new feed slice on resume.
      ? await rpc.request('thread/resume', {...params, threadId: o.session, excludeTurns: false})
      : await rpc.request('thread/start', params);
    session = started.thread.id;
    // Codex keeps no rollout until it accepts the first message. Saving the id
    // straight after thread/start left a dead session when the turn died here.
    const freshThread = !o.session;
    if (!freshThread) await o.onSession(session);
    accepting = true;
    await startTurn([{type: 'text', text: o.prompt}]);
    if (freshThread) await o.onSession(session);
    await finished;
    if (!o.signal.aborted) {
      // Same live app-server, no second CLI and no model request. Billing failure
      // never turns a successful answer into a timeout/error.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([rpc.request('account/rateLimits/read'),
          new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error('таймаут чтения лимитов')), 3000);})]);
        o.usage?.({raw: redactSecrets(raw)}, 'account/rateLimits/read');
      } catch (e) {o.usage?.({raw: {error: String(e)}}, 'account/rateLimits/read');}
      finally {clearTimeout(timer);}
    }
  } catch (e) {
    const raw = String(e);
    // Keep the saved id. A missing file can reappear; a new thread would drop it.
    if (/no rollout found/i.test(raw)) {
      rolloutMiss = raw;
      error = 'Сессия Жеки у Codex не найдена, сбросьте ему контекст.';
    } else error = raw;
  }
  finally {questionLife.abort(); tracer.finish(); accepting = false; closing = true; await channel.close();}
  return {text, denied: o.signal.aborted ? undefined : denied || undefined,
    error: o.signal.aborted || denied ? undefined : error || (!text.trim() ? 'Codex вернул пустой ответ.' : undefined), interrupted: o.signal.aborted,
    stderr: rolloutMiss ? (channel.stderr ? channel.stderr + '\n' + rolloutMiss : rolloutMiss) : channel.stderr};
}
async function grok(o: RunOptions): Promise<RunResult> {
  const launch = await resolveCli(o.cli);
  let closing = false;
  let rpc: Rpc, text = '', error = '', session = '', accepting = false, newStage = false, refused = false, stop = '';
  const compacted = compactOnce(o);
  const tracer = makeTracer(o);
  o.progress('Гриха: запуск агента');
  // --no-leader keeps this agent in our own process tree, so Stop can kill it.
  const channel = new Channel({launch, args: [...grokAgentArgs],
    cwd: o.root, jobRunner: o.jobRunner, signal: o.signal, onPid: o.onPid, env: isolatedEngineEnv(process.env),
    onMessage: value => rpc.receive(value, notification, permission)});
  rpc = new Rpc(channel, true);
  const rpcClose = channel.onClose;
  channel.onClose = e => {rpcClose(e); if (!closing && !error) error = e.message;};
  o.signal.addEventListener('abort', () => {
    if (closing || !session) return;
    try {rpc.notify('session/cancel', {sessionId: session});} catch {}
  }, {once: true});
  function notification(method: string, p: any) {
    if (p?.sessionId && p.sessionId !== session) return;
    if (isAutoCompact(method, p) || isAutoCompact('', p?.update)) compacted();
    const sessionUpdate = method === 'session/update' || method === 'x.ai/session/update';
    if (!accepting || !sessionUpdate) return;
    const update = p.update;
    if (update?.sessionUpdate === 'agent_thought_chunk' || update?.sessionUpdate === 'thought') {
      const chunk = update.content?.text ?? update.text;
      if (chunk) {tracer.thought(String(chunk)); newStage = true;}
    }
    if (update?.sessionUpdate === 'agent_message_chunk') {
      const chunk = update.content?.text;
      if (chunk) {
        if (newStage) text = stageBreak(text);
        newStage = false;
        text = joinChunks(text, chunk); o.text(text);
      }
    }
    if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
      newStage = true;
      const title = update.title || update.kind || 'Гриха работает';
      o.progress(title);
      const done = /^(completed|failed|success)$/i.test(String(update.status || ''));
      tracer.tool(String(update.toolCallId || title), String(title), done ? 'done' : 'running');
    }
  }
  async function permission(method: string, p: any) {
    if (p?.sessionId && p.sessionId !== session) throw new Error('Запрос другой сессии.');
    if (method === '_x.ai/ask_user_question' || method === 'x.ai/ask_user_question') {
      o.usage?.({raw: {method, params: redactSecrets(p)}}, 'ask_user_question');
      const items = parseAgentQuestions(p);
      if (!items.length) {
        if (o.question) await o.question([]);
        return {outcome: 'cancelled'};
      }
      const answers = o.question ? await o.question(items) : undefined;
      if (answers && Object.keys(answers).length) return grokQuestionResult(answers, items);
      text += '\n\n' + items.map(q => q.prompt).join('\n'); o.text(text);
      return {outcome: 'cancelled'};
    }
    if (method === 'session/request_permission') {
      const options: any[] = Array.isArray(p?.options) ? p.options : [];
      const pick = (kinds: string[]) => options.find(x => kinds.includes(x?.kind))?.optionId;
      // Prefer the single-use answer. A standing grant lives in Trio, not in the CLI, so it can be revoked on reset.
      const allow = o.execute && await o.permission(p?.toolCall?.title || 'Действие агента', JSON.stringify(p?.toolCall ?? p, null, 2));
      if (!allow) refused = true;
      const chosen = allow ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
      return chosen ? {outcome: {outcome: 'selected', optionId: chosen}} : {outcome: {outcome: 'cancelled'}};
    }
    o.notice?.(method, JSON.stringify(redactSecrets(p)));
    throw new Error('Этот запрос Grok пока не поддержан: ' + method);
  }
  try {
    await channel.open();
    o.progress('Гриха: проверка существующего входа');
    const init = await rpc.request('initialize', {protocolVersion: 1,
      // Trio does not serve files or terminals to the agent; it uses its own tools under our permissions.
      clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}});
    o.usage?.({raw: init}, 'handshake');
    rememberCli(o.provider, launch.file, init);
    requireGrokSubscription(init);
    // The handshake already carries the window of each model; Trio does not start a second CLI to ask.
    const state = init?._meta?.modelState;
    const current = (state?.availableModels || []).find((m: any) => m?.modelId === (o.model || state?.currentModelId));
    if (current) o.usage?.({window: number(current?._meta?.totalContextTokens ?? current?.totalContextTokens), raw: current}, 'initialize');
    const params = {cwd: o.root, mcpServers: []};
    if (o.session) {await rpc.request('session/load', {...params, sessionId: o.session}); session = o.session;}
    else session = (await rpc.request('session/new', params)).sessionId;
    if (!session) throw new Error('Grok не вернул идентификатор сессии.');
    await o.onSession(session);
    // The live agent expects a plain string; the documented {value: {value}} shape is rejected.
    for (const [configId, value] of [['model', o.model], ['reasoning_effort', o.effort]] as const)
      if (value) await rpc.request('session/set_config_option', {sessionId: session, configId, value});
    accepting = true;
    o.progress('Гриха: ожидание ответа');
    const result = await rpc.request('session/prompt', {sessionId: session, prompt: [{type: 'text', text: o.prompt}]});
    if (isAutoCompact('session/prompt', result) || isAutoCompact('', result?._meta)) compacted();
    // Top-level totalTokens is this turn's context; the nested `usage` counts the whole
    // session across model calls and would show several times the real occupancy.
    const spent = result?._meta ?? result;
    o.usage?.({tokens: number(spent?.totalTokens), spent: spendTokens('grok', spent), spentHint: spendHint('grok', spent), raw: spent}, 'session/prompt');
    await grokQuotaAfterTurn(rpc, o);
    stop = typeof result?.stopReason === 'string' ? result.stopReason : '';
    if (stop && !['end_turn', 'cancelled'].includes(stop) && !isAutoCompact('', {type: stop}))
      error = 'Ход завершён: ' + stop;
  } catch (e) {error = String(e);}
  finally {tracer.finish(); accepting = false; closing = true; await channel.close();}
  const engineCancelled = stop === 'cancelled' && !o.signal.aborted;
  return {text,
    error: o.signal.aborted || engineCancelled ? undefined : error || (!text.trim() ? 'Grok вернул пустой ответ.' : undefined),
    interrupted: o.signal.aborted, cancelled: engineCancelled || undefined, refused: refused || undefined, stderr: channel.stderr};
}
async function claude(o: RunOptions): Promise<RunResult> {
  const launch = await resolveCli(o.cli);
  const env = isolatedEngineEnv(process.env);
  // The read-only status command prevents accidentally using an API-key login.
  let auth: any;
  o.progress('Claude: проверка существующего входа');
  await authStatus(o, launch, env).then(value => {auth = value;});
  requireSubscription(auth, 'claude');
  let closing = false;
  let text = '', error = '', denied = '', complete!: () => void, initialized!: (value: any) => void, initFailed!: (e: Error) => void;
  const compacted = compactOnce(o);
  const tracer = makeTracer(o);
  const finished = new Promise<void>(resolve => {complete = resolve;});
  const init = new Promise<any>((resolve, reject) => {initialized = resolve; initFailed = reject;});
  const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio',
    '--permission-mode', o.execute ? 'default' : 'plan',
    '--settings', claudeSettingsArg,
    '--disallowedTools', o.execute ? 'Agent,Task' : 'Agent,Task,Edit,Write,Bash,PowerShell,NotebookEdit'];
  if (!o.execute) args.push('--tools', 'Read,Grep,Glob,AskUserQuestion');
  if (o.session) args.push('--resume=' + o.session);
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  const blocks = new Map<string, string>();
  let messageKey = 'initial';
  let sessionSave = Promise.resolve();
  const channel = new Channel({launch, args, cwd: o.root, jobRunner: o.jobRunner, signal: o.signal, onPid: o.onPid, env,
    onMessage: value => {
      if (value.type === 'control_response' && value.response?.request_id === 'trio-init') {
        if (value.response.subtype === 'error') initFailed(new Error(value.response.error));
        else initialized(value.response.response);
      }
      if (value.type === 'control_request') {void control(value).catch(e => {error = String(e); complete();}); return;}
      if (value.type === 'stream_event') {
        const e = value.event;
        if (e?.type === 'message_start') messageKey = e.message.id;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking)
          tracer.thought(String(e.delta.thinking));
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          blocks.set(messageKey, (blocks.get(messageKey) || '') + e.delta.text);
          text = [...blocks.values()].join('\n\n'); o.text(text);
        }
      }
      if (value.type === 'assistant') {
        const content = value.message?.content || [];
        const answer = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        if (answer) {blocks.set(value.message.id || messageKey, answer); text = [...blocks.values()].join('\n\n'); o.text(text);}
        for (const tool of content.filter((b: any) => b.type === 'tool_use')) {
          o.progress(tool.name);
          const extra = String(tool.input?.path || tool.input?.file_path || tool.input?.command || '').trim();
          tracer.tool(String(tool.id || tool.name), extra ? tool.name + ' ' + extra : String(tool.name || 'tool'));
        }
      }
      if (value.type === 'system' && (value.subtype === 'compact_boundary' || isAutoCompact('system/' + (value.subtype || ''), value)))
        compacted();
      if (value.type === 'system' && value.subtype === 'init') {
        o.usage?.({raw: value}, 'system/init');
        rememberCli(o.provider, launch.file, value);
        if (value.session_id) {
          sessionSave = o.onSession(value.session_id);
          void sessionSave.catch(e => {error = String(e); complete();});
        }
      }
      if (value.type === 'result') {
        // The top-level usage sums every request of the turn, and a re-read cache counts
        // again each time — that runs into millions. Occupancy is the last request alone.
        const raw = {usage: value.usage, modelUsage: value.modelUsage, model: value.model,
          costUSD: value.total_cost_usd ?? value.costUSD};
        const last = value.usage?.iterations?.at?.(-1) ?? value.usage;
        o.usage?.({tokens: sumTokens(last),
          window: pickContextWindow(value.usage, value.modelUsage) ?? readUsage(value.modelUsage).window,
          spent: spendTokens('claude', raw), spentHint: spendHint('claude', raw), raw}, 'result');
        if (value.result && !text) {text = value.result; o.text(text);}
        if (value.is_error) error = (value.errors || [value.result || 'Ошибка Claude']).join('\n');
        if (value.permission_denials?.length)
          denied = value.permission_denials.map((p: any) => p.tool_name).join(', ');
        complete();
      }
    }});
  channel.onClose = e => {if (!closing) error ||= e.message; initFailed(e); complete();};
  void init.catch(() => {});
  async function control(value: any) {
    const request = value.request;
    let response: any;
    if (request?.subtype === 'can_use_tool') {
      const tool = request.tool_name;
      if (tool === 'AskUserQuestion') {
        const raw = Array.isArray(request.input?.questions) ? request.input.questions : [];
        const items = raw.map((q: any) => ({
          prompt: String(q.question || q.header || 'Вопрос'),
          options: (q.options || []).map((opt: any) => ({label: String(opt.label || opt), description: opt.description ? String(opt.description) : undefined})),
          multi: !!q.multiSelect
        }));
        if (!items.length) {
          if (o.question) await o.question([]);
          response = {behavior: 'deny', message: 'Пустой вопрос.'};
        } else {
          const answers = o.question ? await o.question(items) : undefined;
          if (answers && Object.keys(answers).length) {
            response = {behavior: 'allow', updatedInput: withCustomAnswers(request.input, answers)};
          } else {
            text += '\n\n' + items.map((q: {prompt: string}) => q.prompt).join('\n'); o.text(text);
            response = {behavior: 'deny', message: 'Антон ответит следующим сообщением.', interrupt: true}; complete();
          }
        }
      } else {
        const allow = o.execute && await o.permission(tool, JSON.stringify(request.input, null, 2));
        response = allow ? {behavior: 'allow', updatedInput: request.input} : {behavior: 'deny', message: 'Антон не разрешил это действие.'};
      }
      channel.write({type: 'control_response', response: {subtype: 'success', request_id: value.request_id, response}});
    } else {
      channel.write({type: 'control_response', response: {subtype: 'error', request_id: value.request_id, error: 'Запрос не поддержан Trio.'}});
    }
  }
  try {
    o.progress('Claude: запуск сессии');
    await channel.open();
    channel.write({type: 'control_request', request_id: 'trio-init', request: {subtype: 'initialize'}});
    const handshake = await init;
    o.usage?.({raw: handshake}, 'handshake');
    rememberCli(o.provider, launch.file, handshake);
    o.progress('Claude: ожидание ответа');
    channel.write({type: 'user', message: {role: 'user', content: o.prompt}, parent_tool_use_id: null, session_id: o.session || ''});
    await finished; await sessionSave;
  } catch (e) {error = String(e);}
  finally {tracer.finish(); closing = true; await channel.close();}
  return {text, error: o.signal.aborted ? undefined : error || (!denied && !text.trim() ? 'Claude вернул пустой ответ.' : undefined),
    denied: denied || undefined, interrupted: o.signal.aborted, stderr: channel.stderr};
}
async function authStatus(o: RunOptions, launch: Launch, env: NodeJS.ProcessEnv): Promise<any> {
  let raw = '';
  const supervisor = new Supervisor(o.jobRunner, env);
  const stop = () => {void supervisor.stop().catch(() => {});};
  if (o.signal.aborted) throw new Error('Запуск отменён.');
  o.signal.addEventListener('abort', stop, {once: true});
  try {
    const result = await supervisor.run(launch, ['auth', 'status', '--json'], o.root, '', Math.min(60000, o.timeout), line => {raw += line + '\n';}, o.onPid);
    if (o.signal.aborted) throw new Error('Запуск отменён.');
    if (result.interrupted) throw new Error('Claude не завершил проверку входа за 60 с. Процесс остановлен. Это тайм-аут, а не подтверждение отсутствия подписки.');
    if (result.code !== 0) throw new Error('Claude: требуется вход по подписке через официальный CLI.');
    return JSON.parse(raw);
  } finally {
    o.signal.removeEventListener('abort', stop);
    await supervisor.stop().catch(() => {});
  }
}
