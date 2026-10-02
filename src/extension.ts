import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PanelConnection, renderPanelHtml} from './ui/panelConnection';
import {Store, shortError} from './storage/store';
import {Controller} from './orchestrator/controller';
import {input, id, Provider, Turn, providers, messageText, Catalogs, imageExtensions, names, Attachment, State, diskImagePath, plainAttachment, parseSnippets, Snippet} from './shared/model';
import {compactProvider, readCatalog, formatUsage, readProviderUsage, readClaudeOauthUsage, extractQuotas, rememberedCli, rememberCli} from './providers/adapter';
import {canonical, ProjectLock} from './processes/lock';
import {resolveCli, Supervisor} from './processes/supervisor';
import {compare, beforeFile, Limits, inside} from './snapshots/snapshots';
import {SnapshotStorage} from './snapshots/storage';
import {preserveDirty} from './snapshots/dirtyDocuments';

const exec = promisify(execFile);
let controller: Controller | undefined;
let workspaceOwner: ProjectLock | undefined;
export async function activate(ctx: vscode.ExtensionContext) {
  const loadedVersion = String(ctx.extension.packageJSON.version);
  let panel: vscode.WebviewPanel | undefined, initializing: Promise<void> | undefined;
  let shuttingDown = false;
  let detached = ctx.workspaceState.get<boolean>('trio.detached', false);
  let layout = ctx.workspaceState.get<{side: 'left' | 'right'; width: number; agentsFolded?: boolean; queueFolded?: boolean; draftHeight?: number}>('trio.layout', {side: 'right', width: 400});
  let snippets: Snippet[] = parseSnippets(ctx.globalState.get('trio.snippets'));
  let refreshPanel: (() => void) | undefined;
  let contextEditor = vscode.window.activeTextEditor;
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {if (editor) contextEditor = editor;}));
  const output = vscode.window.createOutputChannel('Trio'); ctx.subscriptions.push(output);
  output.appendLine('Trio ' + loadedVersion + ' · ' + ctx.extensionPath);
  const reportedCopyFailures = new Set<string>();
  const config = () => vscode.workspace.getConfiguration('trio');
  const feedMax = () => {
    const n = config().get<number>('feedMaxMessages', 1000);
    return Number.isInteger(n) && n >= 1 ? Math.min(1000000, n) : 1000;
  };
  const maxResponders = () => {
    const n = config().get<number>('maxResponders', 3);
    if (!Number.isInteger(n) || n < 1) return 3;
    return Math.min(n, 10);
  };
  const snapshots = new SnapshotStorage(ctx.globalStorageUri.fsPath, () => config().get<number>('snapshotStorageMiB', 1024) * 1048576);
  const cleanSnapshots = () => snapshots.prune().catch(e => output.appendLine('Snapshots: ' + String(e)));
  const jobRunner = path.join(ctx.extensionPath, 'dist', 'native', 'JobRunner.exe');
  const limits = (): Limits => ({
    file: config().get<number>('snapshotFileMiB', 20) * 1048576,
    total: config().get<number>('snapshotTotalMiB', 200) * 1048576,
    count: config().get<number>('snapshotMaxFiles', 20000),
    excludes: config().get<string[]>('snapshotExcludes', [])
  });
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const catalogs: Catalogs = {};
  const allowImageRoots = () => {
    if (!panel) return;
    const roots = [ctx.globalStorageUri];
    if (controller) roots.push(vscode.Uri.file(path.join(controller.store.dir, 'images')));
    panel.webview.options = {enableScripts: true, localResourceRoots: roots};
  };
  const imagePreview = (file: string): string | undefined => {
    if (!panel) return;
    const resolved = path.resolve(file);
    try {
      allowImageRoots();
      return panel.webview.asWebviewUri(vscode.Uri.file(resolved)).toString();
    } catch {return;}
  };
  const withImagePreviews = (state: State): State => {
    const add = (a: Attachment): Attachment => {
      const file = diskImagePath(a.text);
      const preview = file && imagePreview(file);
      return preview ? {...a, preview} : a;
    };
    return {
      ...state,
      draftAttachments: state.draftAttachments.map(add),
      messages: state.messages.map(m => m.attachments?.length ? {...m, attachments: m.attachments.map(add)} : m)
    };
  };
  const publishNow = () => {
    if (controller && panel) void panel.webview.postMessage({type: 'state', state: withImagePreviews(controller.state),
      active: controller.active, progress: controller.progress, permissions: controller.permissions,
      // Several VS Code windows look alike; the panel has to say which folder it drives.
      compacting: controller.compacting, root: controller.host.root, detached, layout, catalogs,
      deltas: controller.deltaHints(), snippets,
      // The feed folds long messages; the threshold lives in settings, so it rides along with the state.
      collapseLines: config().get<number>('collapseMessageLines', 100),
      feedMax: feedMax(),
      maxResponders: maxResponders()});
  };
  const publish = () => {
    if (!publishTimer) publishTimer = setTimeout(() => {publishTimer = undefined; publishNow();}, 40);
  };
  const fail = (e: unknown) => {output.appendLine(String(e)); void vscode.window.showErrorMessage(shortError(e)); publish();};
  async function cli(provider: Provider): Promise<string> {
    const configured = config().get<string>(provider + 'Path', provider);
    if (configured && configured !== provider) {await resolveCli(configured); return configured;}
    const extension = vscode.extensions.getExtension(provider === 'codex' ? 'openai.chatgpt' : 'anthropic.claude-code');
    const candidates = provider === 'grok' ? [path.join(os.homedir(), '.grok', 'bin', 'grok.exe')]
      : provider === 'codex' ? [extension && path.join(extension.extensionPath, 'bin', 'windows-x86_64', 'codex.exe')]
      : [extension && path.join(extension.extensionPath, 'resources', 'native-binary', 'claude.exe'), path.join(os.homedir(), '.local', 'bin', 'claude.exe')];
    for (const candidate of candidates) if (candidate) {
      try {if ((await fs.stat(candidate)).isFile()) return candidate;} catch {}
    }
    await resolveCli(provider); return provider;
  }
  async function initialize() {
    if (controller) return;
    if (initializing) return initializing;
    initializing = (async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (process.platform !== 'win32' || vscode.env.remoteName || folders?.length !== 1 || folders[0].uri.scheme !== 'file') throw new Error('Trio: нужна одна локальная папка в VS Code для Windows.');
      const root = await canonical(folders[0].uri.fsPath);
      const key = createHash('sha256').update(root).digest('hex');
      const dir = path.join(ctx.globalStorageUri.fsPath, 'projects', key);
      const owner = await ProjectLock.for(root, path.join(ctx.globalStorageUri.fsPath, 'owners'));
      await owner.acquire();
      workspaceOwner = owner;
      const store = new Store(dir), state = await store.load();
      Object.assign(catalogs, await store.loadCatalogs());
      const next = new Controller(state, store, {
        root, jobRunner, lockBase: path.join(process.env.LOCALAPPDATA || ctx.globalStorageUri.fsPath, 'Trio', 'locks'),
        cli, limit: () => config().get<number>('contextChars', 64000),
        timeout: execute => 1000 * config().get<number>(execute ? 'executionTimeoutSeconds' : 'discussionTimeoutSeconds', execute ? 1800 : 600),
        ceiling: () => 1000 * 60 * config().get<number>('turnCeilingMinutes', 60),
        maxResponders,
        sessionIdle: () => 1000 * 60 * config().get<number>('sessionIdleMinutes', 55),
        sessionMaxTokens: (provider) => config().get<number>(provider + 'SessionMaxTokens', provider === 'grok' ? 0 : 150000),
        notify: (kind, text) => {
          if (!config().get<boolean>('notify', true)) return;
          if (panel?.active && vscode.window.state.focused) return;
          if (panel) panel.title = 'Trio ●';
          const shown = kind === 'permission'
            ? vscode.window.showWarningMessage(text, {modal: false}, 'Открыть Trio')
            : vscode.window.showInformationMessage(text, {modal: false}, 'Открыть Trio');
          void shown.then(choice => {
            if (choice === 'Открыть Trio') {panel?.reveal(); if (panel) panel.title = 'Trio';}
          });
        },
        trusted: () => vscode.workspace.isTrusted && !shuttingDown,
        changed: publish,
        gitState: async () => {
          const run = async (...args: string[]) => String((await exec('git', ['-c', 'core.quotepath=false', '-C', root, ...args], {timeout: 10000, maxBuffer: 1048576, windowsHide: true})).stdout).trim();
          const text = '$ git status --short --branch\n' + await run('status', '--short', '--branch')
            + '\n\n$ git log --oneline -5\n' + await run('log', '--oneline', '-5');
          return text.length > 20000 ? text.slice(0, 20000) + '\n…' : text;
        },
        compact: async ({provider, session, signal}) => {
          await compactProvider({provider, session, signal, cli: await cli(provider), root,
            jobRunner, timeout: 1000 * config().get<number>('executionTimeoutSeconds', 1800),
            onPid: async () => {}});
        },
        refreshQuota: async (provider) => {
          if (provider !== 'claude') return;
          const account = await readClaudeOauthUsage({provider, cli: await cli(provider), root,
            jobRunner, signal: new AbortController().signal, timeout: 8000});
          next.rememberQuota(provider, account);
          await next.save();
        },
        finished: async (turn: Turn) => {await snapshots.finish(path.join(dir, 'snapshots', turn.id)).catch(e => output.appendLine('Snapshots: ' + String(e)));},
        prepare: async (turn: Turn, signal: AbortSignal) => {
          const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === 'file' && inside(root, d.uri.fsPath.toLowerCase()));
          if (dirty.length) {
            const copyDir = path.join(dir, 'unsaved');
            const preserved = await preserveDirty(dirty.map(d => ({path: d.uri.fsPath, text: d.getText()})), copyDir);
            const fresh = preserved.copies.filter(c => c.created);
            for (const copy of fresh) output.appendLine('Несохранённый текст ' + copy.path + ' → ' + copy.copy);
            if (fresh.length) void vscode.window.showInformationMessage(
              'Trio: несохранённый текст редактора сохранён отдельно (' + fresh.length + '). Агент работает с файлами на диске.',
              {modal: false}, 'Открыть копии').then(choice => {
                if (choice === 'Открыть копии') void vscode.env.openExternal(vscode.Uri.file(copyDir));
              });
            const failures = preserved.failed.filter(f => {
              const key = f.path + '\0' + f.error;
              if (reportedCopyFailures.has(key)) return false;
              reportedCopyFailures.add(key); return true;
            });
            for (const failure of failures) output.appendLine('Не сохранил копию ' + failure.path + ': ' + failure.error);
            if (failures.length) void vscode.window.showWarningMessage(
              'Trio: не удалось сохранить копию несохранённого текста: ' + failures.map(f => path.basename(f.path)).join(', ')
              + '. Буфер редактора и файл на диске не перезаписывались; агент работает с диском.',
              {modal: false}, 'Подробности').then(choice => {if (choice === 'Подробности') output.show(true);});
          }
          if (signal.aborted) return;
          const target = path.join(dir, 'snapshots', turn.id), manifest = await snapshots.create(root, target, limits());
          if (signal.aborted) {await snapshots.finish(target); return;}
          const unexpected = manifest.entries.filter(e => e.skip && e.skip !== 'Исключено настройками');
          if (unexpected.length) {
            const choice = await vscode.window.showWarningMessage('Снимок неполный: ' + unexpected.slice(0, 5).map(e => e.path + ': ' + e.skip).join('; '), {modal: true}, 'Продолжить');
            if (!choice) return;
          }
          return target;
        }
      });
      await next.recover(); controller = next;
      allowImageRoots();
      void pruneImages();
      await cleanSnapshots();
    })().catch(async e => {await workspaceOwner?.release(); workspaceOwner = undefined; throw e;})
      .finally(() => {initializing = undefined;});
    return initializing;
  }
  // Pasted screenshots live beside the conversation, never inside the project.
  const imageDir = () => path.join(controller!.store.dir, 'images');
  async function pruneImages() {
    const c = controller; if (!c) return;
    try {
      const files = await fs.readdir(imageDir());
      const kept = new Set<string>();
      for (const attachment of [...c.state.draftAttachments, ...c.state.messages.flatMap(m => m.attachments || [])])
        for (const match of attachment.text.matchAll(/[^\s"']+\.(?:png|jpg|gif|webp|bmp)/gi)) kept.add(path.basename(match[0]));
      for (const file of files) if (!kept.has(file)) await fs.rm(path.join(imageDir(), file), {force: true});
    } catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') output.appendLine(String(e));}
  }
  async function changes(taskId: string) {
    const c = controller!;
    const task = [...c.state.turns, ...c.state.tasks].find(t => t.id === taskId);
    if (!task?.snapshot) throw new Error('У этого поручения нет снимка.');
    const entries = await snapshots.exclusive(() => compare(c.host.root, task.snapshot!, limits()));
    if (!entries.length) {void vscode.window.showInformationMessage('Изменений с начала поручения нет.'); return;}
    const selected = await vscode.window.showQuickPick(entries.map(e => ({label: e.path, description: e.kind + (e.binary ? ' (бинарный/ссылка)' : '') + (e.reason ? ' · ' + e.reason : ''), entry: e})), {title: 'Изменения с начала поручения, включая внешние правки'});
    if (!selected || selected.entry.kind === 'excluded') return;
    const e = selected.entry;
    if (e.binary) {void vscode.window.showInformationMessage(e.path + ': ' + e.kind + '; текстовый diff недоступен.'); return;}
    await snapshots.exclusive(async () => {
      const current = path.resolve(c.host.root, e.path), before = e.kind === 'created' ? '' : await beforeFile(task.snapshot!, e.path, snapshots.blobs);
      if (!inside(c.host.root, current)) throw new Error('Недопустимый путь.');
      if (e.kind !== 'deleted' && !inside(c.host.root, (await fs.realpath(current)).toLowerCase())) throw new Error('Файл ведёт за пределы workspace.');
      const empty = path.join(c.store.dir, 'empty'); await fs.writeFile(empty, '');
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(e.kind === 'created' ? empty : before), vscode.Uri.file(e.kind === 'deleted' ? empty : current), e.path + ' — с начала поручения');
    });
  }
  async function handle(raw: unknown) {
    const m = input(raw); if (!m) throw new Error('Недопустимое сообщение интерфейса.');
    if (m.type === 'pong') return;
    if (m.type === 'layout') {
      const next: {side: 'left' | 'right'; width: number; agentsFolded: boolean; queueFolded: boolean; draftHeight?: number} = {
        side: m.side, width: m.width, agentsFolded: !!m.agentsFolded, queueFolded: !!m.queueFolded
      };
      const height = typeof m.draftHeight === 'number' ? m.draftHeight : layout.draftHeight;
      if (typeof height === 'number') next.draftHeight = height;
      layout = next;
      await ctx.workspaceState.update('trio.layout', layout); publishNow(); return;
    }
    if (m.type === 'snippets') {snippets = m.items; await ctx.globalState.update('trio.snippets', snippets); publishNow(); return;}
    if (m.type === 'reconnect') {refreshPanel?.(); return;}
    if (m.type === 'copy') {await vscode.env.clipboard.writeText(m.text); return;}
    await initialize();
    const c = controller!;
    if (c.resetting) throw new Error('Дождитесь завершения очистки разговора.');
    if ('conversationId' in m && m.conversationId && m.conversationId !== c.state.conversationId) throw new Error('Разговор уже сменился. Повторите действие в текущем разговоре.');
    switch (m.type) {
      case 'ready': publishNow(); break;
      case 'draft': c.state.draft = m.text; c.state.recipient = m.recipient; c.state.responseOrder = m.responseOrder || [];
        c.state.draftAttachments = (m.attachments || []).map(plainAttachment); await c.save(); break;
      case 'send': await c.send(m.text, m.recipient, m.responseOrder, (m.attachments || []).map(plainAttachment), !!m.discuss); break;
      case 'archives': {const dir = path.join(c.store.dir, 'archives'); await fs.mkdir(dir, {recursive: true}); await vscode.env.openExternal(vscode.Uri.file(dir)); break;}
      case 'project': await vscode.env.openExternal(vscode.Uri.file(c.host.root)); break;
      case 'open-image': {
        const found = c.state.draftAttachments.find(a => a.id === m.id)
          || c.state.messages.flatMap(msg => msg.attachments || []).find(a => a.id === m.id);
        const file = found && diskImagePath(found.text);
        if (file) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
        break;
      }
      case 'save-image': {
        const found = c.state.draftAttachments.find(a => a.id === m.id)
          || c.state.messages.flatMap(msg => msg.attachments || []).find(a => a.id === m.id);
        const file = found && diskImagePath(found.text);
        if (!file) break;
        const target = await vscode.window.showSaveDialog({defaultUri: vscode.Uri.file(path.basename(file)), filters: {Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']}});
        if (target) await fs.copyFile(file, target.fsPath);
        break;
      }
      case 'fresh-summary': await c.beginSummary(m.provider); break;
      case 'feed-max':
        await vscode.workspace.getConfiguration('trio').update('feedMaxMessages', m.count, vscode.ConfigurationTarget.Global);
        publishNow();
        break;
      case 'reset': {
        const archive = await c.reset(m.mode, m.provider);
        if (!m.provider) {await pruneImages(); await cleanSnapshots();}
        publishNow();
        return archive ? {archive} : undefined;
      }
      case 'handoff': await c.handoff(m.provider, m.turnId); break;
      case 'retry': await c.retry(m.turnId); break;
      case 'flags': await c.setFlags({autoReply: m.autoReply, autoEdits: m.autoEdits, autoCommands: m.autoCommands, autoActions: m.autoActions, privilegeOn: m.privilegeOn, privileges: m.privileges}); break;
      case 'answer': c.answer(m.requestId, m.answers); break;
      case 'stop': await c.stop(m.provider); break;
      case 'compact': await c.compact(m.provider); break;
      case 'image': {
        const bytes = Buffer.from(m.data, 'base64');
        if (!bytes.length) throw new Error('Пустое изображение.');
        if (bytes.length > 10485760) throw new Error('Изображение больше 10 МБ. Сохрани его файлом и прикрепи через «+ Код…».');
        await fs.mkdir(imageDir(), {recursive: true});
        const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16) + imageExtensions[m.mime];
        const file = path.join(imageDir(), name);
        await fs.writeFile(file, bytes);
        const label = (m.name || 'Скриншот') + ' · ' + Math.round(bytes.length / 1024) + ' КБ';
        // The engines read the picture from disk themselves; no protocol carries it inline.
        const text = 'Изображение на диске: ' + file + '\nОткрой его своим инструментом чтения файлов.';
        return {attachment: {id: name, label, text, preview: imagePreview(file)}};
      }
      case 'usage': {
        if (!vscode.workspace.isTrusted) throw new Error('Usage доступен в доверенном проекте.');
        if (c.busy) throw new Error('Дождитесь ответа или остановите участника: usage читается запуском CLI.');
        const agent = c.state.agents.find(a => a.id === m.provider);
        const preferred = m.provider + ':' + (agent?.mode || 'discuss');
        const session = c.state.sessions[preferred]?.id
          || Object.entries(c.state.sessions).find(([key]) => key.startsWith(m.provider + ':'))?.[1]?.id;
        let extra = '';
        let account: unknown;
        try {
          account = await readProviderUsage({provider: m.provider, cli: await cli(m.provider), root: c.host.root,
            jobRunner, signal: new AbortController().signal, timeout: 30000, session});
          c.rememberQuota(m.provider, account);
          await c.save();
        } catch (e) {output.appendLine(String(e)); extra = '\n\nCLI: ' + shortError(e);}
        const occ = c.state.usage[m.provider];
        const occPercent = occ?.tokens !== undefined && occ.window ? Math.round(occ.tokens / occ.window * 100) : undefined;
        const info = account && typeof account === 'object' ? account as Record<string, unknown> : undefined;
        const sessionInfo = info?.session && typeof info.session === 'object' ? info.session as Record<string, unknown> : undefined;
        const hint = extra.replace(/^\s*CLI:\s*/u, '').trim()
          || (typeof info?.hint === 'string' ? info.hint : undefined);
        return {title: names[m.provider] + ' — расход', text: formatUsage(occ, account) + extra,
          occupancy: occ ? {percent: occPercent, tokens: occ.tokens, window: occ.window, source: occ.source} : undefined,
          quotas: extractQuotas(account),
          session: sessionInfo ? {totalTokens: sessionInfo.totalTokens, limit: sessionInfo.limit} : undefined,
          plan: typeof info?.plan === 'string' ? info.plan : typeof info?.subscriptionType === 'string' ? String(info.subscriptionType) : undefined,
          hint: hint || undefined};
      }
      case 'catalog': {
        if (!vscode.workspace.isTrusted) throw new Error('Списки моделей доступны в доверенном проекте.');
        if (c.busy) throw new Error('Дождитесь ответа или остановите участника: список читается запуском CLI.');
        const cancel = new AbortController();
        const models = await readCatalog({provider: m.provider, cli: await cli(m.provider), root: c.host.root,
          jobRunner, signal: cancel.signal, timeout: 60000});
        if (!models.length) throw new Error('CLI не вернул список моделей. Модель можно задать вручную.');
        catalogs[m.provider] = models;
        await c.store.saveCatalogs(catalogs).catch(e => output.appendLine(String(e)));
        publishNow(); break;
      }
      case 'agent': await c.configure(m.agent); break;
      case 'discard': await c.discard(m.turnId); break;
      case 'pause': await c.pause(m.on); break;
      case 'queue-edit': await c.editQueued(m.messageId, m.text); break;
      case 'queue-move': await c.moveQueued(m.messageId, m.before); break;
      case 'queue-remove': await c.removeQueued(m.messageId); break;
      case 'permission': c.permission(m.requestId, m.allow, m.whole, m.standing); break;
      case 'changes': await changes(m.taskId); break;
      case 'plugin-settings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:trio-local.trio-chat'); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'trio.claudePath'); break;
      case 'popout':
        if (panel && !detached) {
          panel?.reveal();
          await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
          detached = true; await ctx.workspaceState.update('trio.detached', true); publishNow();
        }
        break;
      case 'attach': {
        const epoch = c.state.conversationId;
        const editor = contextEditor;
        const contextSelection = editor?.selection;
        const choices: {label: string; description?: string; action: string}[] = [];
        if (editor && editor.document.uri.scheme === 'file' && inside(c.host.root, editor.document.uri.fsPath.toLowerCase())) {
          const label = path.relative(c.host.root, editor.document.uri.fsPath);
          if (!editor.selection.isEmpty) choices.push({label: 'Выделение: ' + label, description: 'строки ' + (editor.selection.start.line + 1) + '–' + (editor.selection.end.line + 1), action: 'selection'});
          choices.push({label: 'Файл: ' + label, description: 'целиком', action: 'active'});
        }
        choices.push({label: 'Выбрать файл…', action: 'file'});
        const choice = await vscode.window.showQuickPick(choices, {title: 'Прикрепить код', placeHolder: 'Выбери, что передать агенту'});
        if (!choice) return {cancelled: true};
        let text: string, label: string;
        if (choice.action === 'file') {
          const files = await vscode.window.showOpenDialog({canSelectMany: false, defaultUri: vscode.Uri.file(c.host.root), openLabel: 'Прикрепить'});
          if (!files?.[0]) return {cancelled: true};
          const file = await fs.realpath(files[0].fsPath);
          const outside = !inside(c.host.root, file.toLowerCase());
          if (outside) {
            const warned = await vscode.window.showWarningMessage('Файл вне папки проекта: ' + file,
              {modal: true, detail: 'Его содержимое уйдёт выбранному агенту в его процесс.'}, 'Прикрепить');
            if (warned !== 'Прикрепить') return {cancelled: true};
          }
          if ((await fs.stat(file)).size > 200000) throw new Error('Файл слишком большой. Откройте его и выберите нужный фрагмент.');
          text = await fs.readFile(file, 'utf8'); label = outside ? file : path.relative(c.host.root, file);
          if (text.includes('\u0000')) throw new Error('Это двоичный файл. Картинки и другие двоичные вложения пока не поддерживаются.');
        } else {
          const selected = choice.action === 'selection' ? contextSelection : undefined;
          text = editor!.document.getText(selected);
          label = path.relative(c.host.root, editor!.document.uri.fsPath) + (selected ? ':' + (selected.start.line + 1) + '–' + (selected.end.line + 1) : '');
        }
        if (epoch !== c.state.conversationId) throw new Error('Разговор изменился. Прикрепите файл заново.');
        if (text.length > 50000) throw new Error('Выделите фрагмент до 50 000 символов.');
        return {attachment: {id: createHash('sha256').update(label + '\n' + text).digest('hex'), label, text}};
      }
      case 'diagnostics': {
        output.appendLine('Trio ' + loadedVersion + ' · ' + ctx.extensionPath);
        // What the panel's own engine decided about the environment: a reduce here used to
        // switch off the blinking queue button, and nothing in the panel said so.
        output.appendLine('панель: prefers-reduced-motion — ' + (m.reducedMotion ? 'reduce' : 'no-preference'));
        if (!vscode.workspace.isTrusted || c.busy) throw new Error('Диагностика доступна в доверенном проекте, когда агенты свободны.');
        for (const p of providers) {
          try {
            const launch = await resolveCli(await cli(p));
            const known = rememberedCli(p);
            output.appendLine(p + ': ' + (known || launch.file));
            if (!known || !known.includes(' · ')) {
              let version = '';
              const result = await new Supervisor(jobRunner).run(launch, ['--version'], c.host.root, '', 15000, line => {version += line;});
              output.appendLine(version.trim() + ', exit ' + result.code);
              if (version.trim()) rememberCli(p, launch.file, {version: version.trim()});
            }
          } catch (e) {output.appendLine(p + ': ' + String(e));}
        }
        for (const p of providers) {
          const used = c.state.usage[p];
          output.appendLine(p + ': контекст движка — ' + (used
            ? (used.tokens?.toLocaleString('ru-RU') ?? '?') + ' из ' + (used.window?.toLocaleString('ru-RU') ?? '?')
              + ' токенов, по ' + used.source + ' от ' + new Date(used.at).toLocaleString('ru-RU')
            : 'движок ещё не сообщал'));
        }
        for (const diagnostic of c.state.diagnostics) output.appendLine(diagnostic);
        output.show(); break;
      }
      case 'export': {
        const target = await vscode.window.showSaveDialog({filters: {Markdown: ['md']}, saveLabel: 'Экспортировать'});
        if (!target) return;
        const text = c.state.messages.map(m => '--- ' + m.author + ' ---\n' + (m.error ? '[Ошибка]\n' : '') + (m.partial ? '[Частичный ответ]\n' : '') + messageText(m) + '\n').join('\n');
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8')); break;
      }
      case 'import': {
        if (c.busy || c.summarizing) throw new Error('Импортируйте историю после завершения ответа.');
        const importingConversation = c.state.conversationId;
        const files = await vscode.window.showOpenDialog({canSelectMany: false, filters: {Markdown: ['md']}});
        if (!files?.[0]) return;
        const raw = await fs.readFile(files[0].fsPath, 'utf8'), digest = createHash('sha256').update(raw).digest('hex');
        if (c.busy || c.resetting || importingConversation !== c.state.conversationId) throw new Error('Разговор изменился во время выбора файла. Повторите импорт.');
        if (c.state.imports.includes(digest)) throw new Error('Этот файл уже импортирован.');
        const parts = raw.split(/^--- (Антон|Колян|Жека|Гриха|Trio) ---\s*$/m);
        if (parts[0].trim()) c.note(parts[0]);
        for (let i = 1; i < parts.length; i += 2) c.state.messages.push({id: id(), author: parts[i] as 'Антон', text: parts[i + 1].trim()});
        c.state.imports.push(digest); await c.save(); break;
      }
    }
  }
  async function bind(target: vscode.WebviewPanel) {
    panel = target; target.title = 'Trio ' + loadedVersion;
    allowImageRoots();
    const [template, css, composer, script] = await Promise.all(
      ['main.html', 'main.css', 'composer.js', 'main.js'].map(name => fs.readFile(path.join(ctx.extensionPath, 'webview', name), 'utf8')));
    const creatorImage = 'data:image/png;base64,' + (await fs.readFile(path.join(ctx.extensionPath, 'webview', 'avmbur.png'))).toString('base64');
    let disposed = false;
    const setHtml = () => {
      if (disposed) return;
      const nonce = id().replace(/-/g, '');
      // Inline packaged assets avoid stale resource URLs when an auxiliary window is restored.
      target.webview.html = renderPanelHtml(template.replaceAll('{{creatorImage}}', creatorImage), css, composer, script, nonce, target.webview.cspSource, loadedVersion);
      output.appendLine('Panel HTML set · ' + (detached ? 'detached' : 'main'));
    };
    const connection = new PanelConnection(
      () => {void target.webview.postMessage({type: 'ping'});},
      () => {output.appendLine('Panel did not respond; restoring HTML'); setHtml();},
      () => {output.appendLine('Panel recovery timed out'); void vscode.window.showWarningMessage('Trio: панель не отвечает. Выполните «Trio: Восстановить панель».');});
    const refresh = () => {setHtml(); connection.received(); connection.check();};
    refreshPanel = refresh;
    const subscriptions: vscode.Disposable[] = [];
    subscriptions.push(target.webview.onDidReceiveMessage(async raw => {
      if (disposed) return;
      if (raw?.type === 'ready' || raw?.type === 'pong') {
        connection.received();
        if (raw.type === 'ready') output.appendLine('Panel ready');
      }
      try {
        const data = await handle(raw);
        if (!disposed) void target.webview.postMessage({type: 'ack', requestId: raw?.clientRequestId, clientId: raw?.clientId, data});
      } catch (e) {
        fail(e);
        if (controller) controller.state.diagnostics.push(String(e));
        if (!disposed) void target.webview.postMessage({type: 'error', requestId: raw?.clientRequestId, clientId: raw?.clientId, text: shortError(e)});
      }
    }));
    subscriptions.push(target.onDidChangeViewState(() => {
      if (target.visible) {connection.check(); publishNow();} else connection.pause();
      if (target.active && panel === target) panel.title = 'Trio';
    }));
    target.onDidDispose(() => {
      disposed = true; connection.dispose(); subscriptions.forEach(s => s.dispose());
      if (panel === target) {panel = undefined; refreshPanel = undefined;}
    });
    ctx.subscriptions.push({dispose: () => {connection.dispose(); subscriptions.forEach(s => s.dispose());}});
    refresh();
  }
  ctx.subscriptions.push(vscode.commands.registerCommand('trio.open', async () => {
    try {
      if (panel) {panel.reveal(); refreshPanel?.(); return;}
      detached = false; await ctx.workspaceState.update('trio.detached', false);
      await bind(vscode.window.createWebviewPanel('trio', 'Trio', vscode.ViewColumn.Beside, {enableScripts: true, retainContextWhenHidden: true}));
    } catch (e) {fail(e);}
  }));
  ctx.subscriptions.push(vscode.window.registerWebviewPanelSerializer('trio', {
    async deserializeWebviewPanel(target) {try {output.appendLine('Restoring panel'); await bind(target);} catch (e) {fail(e);}}
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand('trio.refresh', () => refreshPanel?.()));
  ctx.subscriptions.push(vscode.commands.registerCommand('trio.popout', async () => {try {if (!panel) await vscode.commands.executeCommand('trio.open'); await handle({type: 'popout'});} catch (e) {fail(e);}}));
  for (const p of ['all', ...providers]) ctx.subscriptions.push(vscode.commands.registerCommand('trio.stop.' + p, async () => {
    try {await controller?.stop(p === 'all' ? undefined : p as Provider);} catch (e) {fail(e);}
  }));
  const snapshotTimer = setInterval(() => {void cleanSnapshots();}, 5 * 60 * 1000);
  ctx.subscriptions.push({dispose: () => clearInterval(snapshotTimer)});
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('trio.snapshotStorageMiB')) void cleanSnapshots();
    // A new folding threshold has to reach the open panel without a reload.
    if (e.affectsConfiguration('trio.collapseMessageLines') || e.affectsConfiguration('trio.feedMaxMessages') || e.affectsConfiguration('trio.maxResponders')) publish();
  }));
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    shuttingDown = true; void controller?.stop().catch(fail);
    void vscode.window.showWarningMessage('Папка workspace изменилась. Перезагрузите окно перед следующим запуском Trio.');
  }));
  ctx.subscriptions.push({dispose: () => {shuttingDown = true; if (publishTimer) clearTimeout(publishTimer);}});
}
export async function deactivate() {await controller?.stop(); await workspaceOwner?.release(); workspaceOwner = undefined; controller = undefined;}
