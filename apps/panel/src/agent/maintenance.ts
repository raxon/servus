import type Docker from 'dockerode';

export type AgentDrainResult = { status: 'drained' | 'uncertain' | 'timeout' };
type DrainScope = { legacyUploadId:string;serviceId:string } | undefined;

/** Confirm a successfully started exec has exited; a failed inspection remains uncertain. */
export async function consoleExecStopped(exec: Docker.Exec, containerId: string, timeoutMs = 3000): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(exec.id) || !/^[a-f0-9]{12,64}$/.test(containerId)) return false;
  const deadline=performance.now()+timeoutMs;
  while(performance.now()<deadline) {
    const controller=new AbortController();
    const remaining=Math.max(1,Math.min(1000,deadline-performance.now()));
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Inspection timed out'));},remaining);});
      const info=await Promise.race([exec.inspect({abortSignal:controller.signal}),timeout]);
      if(info.ID!==exec.id || !/^[a-f0-9]{64}$/.test(info.ContainerID) || !info.ContainerID.startsWith(containerId) || typeof info.Running!=='boolean') return false;
      if(!info.Running) return Number.isSafeInteger(info.Pid) && info.Pid>0 && Number.isInteger(info.ExitCode);
    } catch {return false;}
    finally {if(timer)clearTimeout(timer);controller.abort();}
    const wait=Math.min(100,Math.max(0,deadline-performance.now()));
    if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  }
  return false;
}

// This barrier covers one agent process only. A coordinator must exclude other writers.
export class AgentMaintenanceGate {
  private draining = false;
  private uncertain = false;
  private active = 0;
  private journalCheck?: (scope:DrainScope) => boolean;
  private drainScope?: string;
  private readonly closers = new Set<() => void>();
  private readonly waiters = new Set<() => void>();

  bindJournal(check: (scope:DrainScope) => boolean) {
    if (this.journalCheck) throw new Error('Agent maintenance gate already bound');
    this.journalCheck = check;
  }

  admit(): (() => void) | undefined {
    if (this.draining) return undefined;
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      if (!this.active) for (const wake of this.waiters) wake();
    };
  }

  markUncertain() { this.uncertain = true; }

  registerCloser(close: () => void): () => void {
    if (this.draining) { try { close(); } catch { this.markUncertain(); } return () => {}; }
    this.closers.add(close);
    return () => this.closers.delete(close);
  }

  async drain(timeoutMs: number): Promise<AgentDrainResult> {
    return this.drainWithScope(timeoutMs,undefined);
  }

  /** Local barrier only; host-side process and filesystem checks remain required. */
  async drainForLegacyUpload(timeoutMs:number,operationId:string,serviceId:string):Promise<AgentDrainResult> {
    if(typeof operationId!=='string'||!/^[a-f0-9]{32}$/.test(operationId)||typeof serviceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(serviceId))throw new Error('Invalid legacy restore identity');
    return this.drainWithScope(timeoutMs,{legacyUploadId:operationId,serviceId});
  }

  private async drainWithScope(timeoutMs:number,scope:DrainScope):Promise<AgentDrainResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new Error('Invalid drain timeout');
    const requestedScope=scope ? `${scope.legacyUploadId}:${scope.serviceId}` : 'ordinary';
    if(this.draining && this.drainScope!==requestedScope){this.markUncertain();return {status:'uncertain'};}
    this.draining = true;
    this.drainScope=requestedScope;
    for (const close of [...this.closers]) { try { close(); } catch { this.markUncertain(); } }
    if (this.active) {
      const finished = await new Promise<boolean>(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(true); };
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve(false); }, timeoutMs);
        this.waiters.add(wake);
      });
      if (!finished) return { status: 'timeout' };
    }
    try {
      if (!this.journalCheck || this.journalCheck(scope)) this.markUncertain();
    } catch { this.markUncertain(); }
    return { status: this.uncertain ? 'uncertain' : 'drained' };
  }
}
