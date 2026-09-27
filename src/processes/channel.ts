import {spawn, ChildProcessWithoutNullStreams} from 'node:child_process';
import {Launch} from './supervisor';

export interface ChannelOptions {
  launch: Launch; args: string[]; cwd: string; jobRunner: string; signal: AbortSignal;
  onPid(pid: number): Promise<void>; onMessage(value: any): void; env?: NodeJS.ProcessEnv;
}
export class Channel {
  private child?: ChildProcessWithoutNullStreams;
  private done?: Promise<void>;
  private failure?: Error;
  private buffer = '';
  stderr = '';
  closed = false;
  private stopping = false;
  onClose: (error: Error) => void = () => {};
  private cancel = () => {void this.close().catch(() => {});};
  constructor(private readonly options: ChannelOptions) {}
  async open() {
    const o = this.options;
    if (o.signal.aborted) throw new Error('Запуск отменён.');
    const args = [...o.launch.args, ...o.args];
    const child = process.platform === 'win32'
      ? spawn(o.jobRunner, [String(process.pid), o.launch.file, ...args], {cwd: o.cwd, env: o.env, windowsHide: true, shell: false})
      : spawn(o.launch.file, args, {cwd: o.cwd, env: o.env, detached: true, shell: false});
    this.child = child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdin.on('error', () => {});
    child.stderr.on('data', text => {this.stderr = (this.stderr + text).slice(-16000);});
    child.stdout.on('data', (text: string) => {
      this.buffer += text;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (line.length > 8 * 1024 * 1024) {this.fail(new Error('Слишком большое сообщение CLI.')); return;}
        if (!line.trim()) continue;
        try {o.onMessage(JSON.parse(line));} catch (e) {this.fail(new Error('Ошибка протокола CLI: ' + String(e))); return;}
      }
      if (this.buffer.length > 8 * 1024 * 1024) this.fail(new Error('Слишком большое сообщение CLI.'));
    });
    this.done = new Promise<void>(resolve => {
      child.once('error', error => {this.failure = error;});
      child.once('close', code => {
        this.closed = true;
        o.signal.removeEventListener('abort', this.cancel);
        const error = this.failure || new Error(this.stopping ? 'Процесс остановлен.' : 'CLI завершился с кодом ' + code + (this.stderr ? ': ' + this.stderr : ''));
        this.onClose(error); resolve();
      });
    });
    o.signal.addEventListener('abort', this.cancel, {once: true});
    try {
      await new Promise<void>((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
      if (child.pid) await o.onPid(child.pid);
      if (o.signal.aborted) {await this.close(); throw new Error('Запуск отменён.');}
    } catch (e) {await this.close(); throw e;}
  }
  private fail(error: Error) {this.failure = error; this.onClose(error); void this.close().catch(() => {});}
  write(value: unknown) {
    if (!this.child || this.closed || this.stopping) throw new Error('Канал CLI закрыт.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  async close() {
    const child = this.child;
    if (!child || this.closed) return;
    this.stopping = true;
    if (child.pid) {
      // Terminating JobRunner closes its kill-on-close job, including grandchildren.
      if (process.platform === 'win32') {
        if (!child.kill() && child.exitCode === null) throw new Error('Не удалось остановить Windows JobRunner.');
      } else {
        try {process.kill(-child.pid, 'SIGKILL');} catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;}
      }
    }
    await this.done;
  }
}
export class Rpc {
  private next = 0;
  private pending = new Map<number, {resolve(value: any): void; reject(error: Error): void}>();
  constructor(readonly channel: Channel, readonly jsonrpc = false) {
    channel.onClose = error => {for (const p of this.pending.values()) p.reject(error); this.pending.clear();};
  }
  notify(method: string, params: unknown = {}) {this.channel.write({...this.header(), method, params});}
  request(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      try {this.channel.write({...this.header(), id, method, params});} catch (e) {this.pending.delete(id); reject(e);}
    });
  }
  private header() {return this.jsonrpc ? {jsonrpc: '2.0'} : {};}
  receive(event: any, notify: (method: string, params: any) => void, request: (method: string, params: any) => Promise<unknown>) {
    if (!event || typeof event !== 'object') throw new Error('Неверный JSON-RPC пакет.');
    if (typeof event.method === 'string') {
      if (event.id === undefined) {notify(event.method, event.params); return;}
      void request(event.method, event.params).then(result => {
        if (!this.channel.closed) this.channel.write({...this.header(), id: event.id, result});
      }, error => {
        if (!this.channel.closed) this.channel.write({...this.header(), id: event.id, error: {code: -32601, message: String(error)}});
      }).catch(() => {});
    } else {
      const pending = this.pending.get(event.id); if (!pending) return;
      this.pending.delete(event.id);
      if (event.error) pending.reject(new Error(event.error.message || 'Ошибка JSON-RPC'));
      else pending.resolve(event.result);
    }
  }
}
