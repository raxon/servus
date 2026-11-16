import type Docker from 'dockerode';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { IngressMigrationDriver } from './https-migration.js';

/** Docker adapter; uses service versions as compare-and-swap tokens. */
export function dockerIngressMigrationDriver(docker:Docker,name:string,timeoutMs=90_000):IngressMigrationDriver {
  const service=docker.getService(name);
  return {
    async inspect() {
      const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline) {
        const value=await service.inspect();
        if(!Number.isSafeInteger(value.Version?.Index) || !value.Spec)throw new Error('Ingress version cannot be verified.');
        const state=value.UpdateStatus?.State;
        if(['paused','rollback_paused'].includes(state??''))throw new Error(`Ingress update ${state}; recovery requires review.`);
        if(!['updating','rollback_started'].includes(state??''))return {spec:value.Spec,version:value.Version.Index};
        await delay(500);
      }
      throw new Error('Timed out waiting for the current ingress update.');
    },
    async update(spec,version) {
      const current=await service.inspect();
      if(current.Version?.Index!==version)throw new Error('Ingress version changed before the update.');
      if(['updating','rollback_started','paused','rollback_paused'].includes(current.UpdateStatus?.State??''))throw new Error('Ingress already has an unresolved Swarm update.');
      await service.update({...spec,version});
    },
    async waitHealthy(expected) {
      const deadline=Date.now()+timeoutMs;
      const expectedContainer=expected.TaskTemplate && 'ContainerSpec' in expected.TaskTemplate ? expected.TaskTemplate.ContainerSpec : undefined;
      if(!expectedContainer?.Image || !expectedContainer.Args)throw new Error('Ingress task configuration is incomplete.');
      while(Date.now()<deadline) {
        const current=await service.inspect();
        const state=current.UpdateStatus?.State;
        if(['paused','rollback_paused'].includes(state??''))throw new Error(`Ingress update ${state}.`);
        if(isDeepStrictEqual(current.Spec,expected) && (!state||state==='completed'||state==='rollback_completed')) {
          const tasks=await docker.listTasks({filters:{service:[name],'desired-state':['running']}});
          for(const task of tasks) {
            const containerSpec=task.Spec?.ContainerSpec;
            const id=task.Status?.ContainerStatus?.ContainerID;
            if(task.Status?.State!=='running'||containerSpec?.Image!==expectedContainer.Image||!isDeepStrictEqual(containerSpec.Args,expectedContainer.Args)||!id)continue;
            const container=await docker.getContainer(id).inspect();
            if(container.State?.Running && (!container.State.Health || container.State.Health.Status==='healthy'))return;
          }
        }
        await delay(500);
      }
      throw new Error('Timed out waiting for the ingress to become healthy.');
    },
  };
}
