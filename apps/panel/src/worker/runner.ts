import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { AgentRequestError, agentRequest, applyService, type ApplyResult } from '../agent/client.js';
import type { ActionType, Service, ServiceState } from '../shared/types.js';

export interface WorkerOptions {
  allowWork?: () => boolean;
  apply?: (operationId: string, service: Service, type: ActionType) => Promise<ApplyResult>;
  readState?: (serviceId: string) => Promise<{state:ServiceState;deployedRevision?:number}>;
  wait?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
}
export type WorkerDrainResult = {status:'drained'|'uncertain'|'timeout'|'stopped'};
function freezeSnapshot<T extends object>(value:T):T {
  for(const child of Object.values(value))if(child&&typeof child==='object')freezeSnapshot(child);
  return Object.freeze(value);
}

export class Worker {
  readonly id = randomUUID();
  stopping = false;
  private readonly apply;
  private readonly readState;
  private readonly wait;
  private readonly retryDelayMs;
  private readonly allowWork;
  private draining = false;
  private active: Promise<boolean> | undefined;
  private readonly uncertainActions = new Set<string>();
  private claimUncertain = false;
  constructor(readonly store: Store, readonly leaseMs = 60000, options: WorkerOptions = {}) {
    this.apply = options.apply ?? applyService;
    this.readState = options.readState ?? ((serviceId: string) => agentRequest<{state:ServiceState;deployedRevision?:number}>(`/services/${serviceId}/state`));
    this.wait = options.wait ?? delay;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.allowWork = options.allowWork ?? (() => true);
  }

  once(): Promise<boolean> {
    if(this.active) return this.active;
    if(this.stopping || this.draining) return Promise.resolve(false);
    const active = Promise.resolve().then(() => this.processOne());
    this.active = active;
    void active.then(() => { if(this.active===active)this.active=undefined; }, () => { if(this.active===active)this.active=undefined; });
    return active;
  }

  // This reports only this worker's drain; callers must also verify durable jobs and other writers.
  async drain(timeoutMs: number): Promise<WorkerDrainResult> {
    if(!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)throw new Error('Invalid drain timeout');
    this.draining = true;
    const active = this.active;
    if(active) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(resolve => {timer=setTimeout(()=>resolve('timeout'),timeoutMs);});
      const result = await Promise.race([active.then(()=> 'finished' as const,()=> 'finished' as const),timeout]);
      if(timer)clearTimeout(timer);
      if(result==='timeout')return {status:'timeout'};
    }
    if(this.claimUncertain || this.uncertainActions.size)return {status:'uncertain'};
    if(this.stopping)return {status:'stopped'};
    return {status:'drained'};
  }

  private async processOne(): Promise<boolean> {
    if(this.stopping || this.draining || !this.allowWork()) return false;
    let job: ReturnType<Store['claimNextJob']>;
    try { job = this.store.claimNextJob(this.id,this.leaseMs); }
    catch(error) { this.claimUncertain=true; throw error; }
    if(!job) return false;
    this.uncertainActions.add(job.actionId);
    const snapshot = freezeSnapshot(job.snapshot);
    let ownsLease = true;
    const renew = () => {
      if(!ownsLease) return false;
      try { ownsLease = this.store.renewJob(job.id,this.id,this.leaseMs); }
      catch { ownsLease = false; }
      return ownsLease;
    };
    const heartbeat = setInterval(renew,Math.max(10,this.leaseMs/4));
    const event = (level: 'info' | 'warn' | 'error', message: string) => this.store.appendOwnedEvent(job.actionId,this.id,level,message);
    try {
      if(!renew()) return true;
      event(job.recovered ? 'warn' : 'info',job.recovered ? 'Recovered an interrupted action. The agent will reconcile its durable operation journal.' : 'Worker claimed the durable deployment job.');
      if(!this.store.setActionPhase(job.actionId,this.id,'applying')) return true;
      event('info',`Applying ${job.type} for ${snapshot.image}; the configuration snapshot is revision ${snapshot.revision}.`);
      let uncertainAttempts = 0;
      while(!this.stopping && renew()) {
        try {
          const result = await this.apply(job.actionId,snapshot,job.type);
          if(!renew()) return true;
          if(!this.store.setActionPhase(job.actionId,this.id,'checking')) return true;
          for(const line of result.messages) if(!event('info',line)) return true;
          if(this.store.completeAction(job.actionId,this.id,{...result,lastError:null}))this.uncertainActions.delete(job.actionId);
          return true;
        } catch(error) {
          if(!renew()) return true;
          if(error instanceof AgentRequestError && error.certainty === 'definitive') {
            const accepted = error.code === 'BUILD_CANCELLED'
              ? this.store.cancelRunningAction(job.actionId,this.id,error.message)
              : this.store.failAction(job.actionId,this.id,error.message);
            if(accepted) {
              this.uncertainActions.delete(job.actionId);
              try {
                const observed = await this.readState(job.serviceId);
                this.store.updateServiceRuntime(job.serviceId,{...observed,lastError:error.code === 'BUILD_CANCELLED' ? null : error.message},job.actionId);
              } catch { /* Preserve the recorded terminal failure if runtime observation is unavailable. */ }
            }
            return true;
          }
          if(!this.store.setActionPhase(job.actionId,this.id,'reconciling')) return true;
          uncertainAttempts += 1;
          if(uncertainAttempts === 1 || uncertainAttempts % 30 === 0) {
            const detail = error instanceof AgentRequestError ? error.message : 'An agent outcome could not be confirmed.';
            if(!event('warn',`${detail} Retaining the service lock and retrying the same operation identity.`)) return true;
          }
          if(this.stopping) return true;
          await this.wait(this.retryDelayMs);
        }
      }
      return true;
    } finally {
      clearInterval(heartbeat);
      // An uncertain operation keeps its running job. Another worker reconciles it after lease expiry.
    }
  }

  async run() {
    while(!this.stopping) {
      try { if(!await this.once()) await delay(500); }
      catch(error) { console.error(error instanceof Error ? error.message : 'Worker loop failed'); await delay(1000); }
    }
  }
}
