export type DrainResult = { status: 'drained' | 'uncertain' | 'timeout' };
export type UncertaintySource = 'handler' | 'request_aborted' | 'response_closed' | 'closer' | 'unknown';

// This is an in-process barrier only. A coordinator must also exclude other writers.
export class MaintenanceGate {
  constructor(private readonly allowWork:()=>boolean = () => true) {}
  private draining = false;
  private readonly uncertainty = new Set<UncertaintySource>();
  private active = 0;
  private readonly waiters = new Set<() => void>();
  private readonly closers = new Set<() => void>();

  get isDraining() { return this.draining; }

  admit(): (() => void) | undefined {
    if (this.draining || !this.allowWork()) return undefined;
    return this.beginWork();
  }

  beginWork(): () => void {
    this.active++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.active--;
      if (!this.active) for (const wake of this.waiters) wake();
    };
  }

  markUncertain(source: UncertaintySource = 'unknown') { this.uncertainty.add(source); }

  uncertaintySources(): readonly UncertaintySource[] { return [...this.uncertainty]; }

  registerCloser(close: () => void): () => void {
    if (this.draining) { close(); return () => {}; }
    this.closers.add(close);
    return () => this.closers.delete(close);
  }

  async drain(timeoutMs: number): Promise<DrainResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new Error('Invalid drain timeout');
    this.draining = true;
    for (const close of [...this.closers]) {
      try { close(); } catch { this.markUncertain('closer'); }
    }
    if (this.active) {
      const waited = await new Promise<boolean>(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(true); };
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve(false); }, timeoutMs);
        this.waiters.add(wake);
      });
      if (!waited) return {status:'timeout'};
    }
    return {status:this.uncertainty.size?'uncertain':'drained'};
  }
}
