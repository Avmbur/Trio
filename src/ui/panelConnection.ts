// Recover the existing panel only; this never starts an agent.
export class PanelConnection {
  private timer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private disposed = false;
  constructor(private readonly ping: () => void, private readonly reload: () => void,
    private readonly failed: () => void, private readonly timeout = 6000) {}
  check() {
    if (this.disposed) return;
    this.pause();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed) return;
      if (this.retries++ < 2) {this.reload(); this.check();}
      else this.failed();
    }, this.timeout);
    this.ping();
  }
  received() {this.pause(); this.retries = 0;}
  pause() {if (this.timer) clearTimeout(this.timer); this.timer = undefined;}
  dispose() {this.disposed = true; this.pause();}
}

export function renderPanelHtml(template: string, css: string, composer: string, script: string, nonce: string, csp: string, version: string): string {
  return template
    .replace('<link rel="stylesheet" href="{{css}}">', () => '<style nonce="{{nonce}}">' + css + '</style>')
    .replace('<script nonce="{{nonce}}" src="{{composer}}" defer></script>', () => '<script nonce="{{nonce}}">' + composer + '</script>')
    .replace('<script nonce="{{nonce}}" src="{{script}}" defer></script>', () => '<script nonce="{{nonce}}">document.addEventListener("DOMContentLoaded", () => {' + script + '\n});</script>')
    .replaceAll('{{cspSource}}', csp).replaceAll('{{nonce}}', nonce)
    .replaceAll('{{version}}', version.replace(/[&<>"']/g, character => '&#' + character.charCodeAt(0) + ';'));
}
