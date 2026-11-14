export type DrainResult = { status: 'drained' | 'uncertain' | 'timeout' };

// This is an in-process barrier only. A coordinator must also exclude other writers.
export class MaintenanceGate {
  private draining = false;
  private uncertain = false;
  private active = 0;
  private readonly waiters = new Set<() => void>();
  private readonly closers = new Set<() => void>();

  get isDraining() { return this.draining; }

  admit(): (() => void) | undefined {
    if (this.draining) return undefined;
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

  markUncertain() { this.uncertain = true; }

  registerCloser(close: () => void): () => void {
    if (this.draining) { close(); return () => {}; }
    this.closers.add(close);
    return () => this.closers.delete(close);
  }

  async drain(timeoutMs: number): Promise<DrainResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new Error('Invalid drain timeout');
    this.draining = true;
    for (const close of [...this.closers]) {
      try { close(); } catch { this.markUncertain(); }
    }
    if (this.active) {
      const waited = await new Promise<boolean>(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(true); };
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve(false); }, timeoutMs);
        this.waiters.add(wake);
      });
      if (!waited) return {status:'timeout'};
    }
    return {status:this.uncertain?'uncertain':'drained'};
  }
}
