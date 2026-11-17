import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Docker from 'dockerode';
import { AGENT_VOLUME_BACKUP_SCHEMA_SQL, type VolumeRestoreBinding } from '../../src/shared/volume-backups.js';
import { readVolumeBindings, validateBoundMounts, verifyBoundRuntime } from '../../src/agent/volume-binding.js';
import type { Service } from '../../src/shared/types.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'volume-binding-'));roots.push(dir);
  const db=new Database(join(dir,'agent.sqlite'));db.exec(AGENT_VOLUME_BACKUP_SCHEMA_SQL);
  const serviceId=randomUUID(),operationId=randomUUID();
  const binding:VolumeRestoreBinding={service_id:serviceId,mount_target:'/data',mount_name:'data',volume_name:`panel-volume-restore-${operationId}`,operation_id:operationId,created_at:new Date().toISOString()};
  db.prepare('INSERT INTO volume_restore_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(operationId,serviceId,randomUUID(),'/data','data','completed','enc:v1:fixture',binding.volume_name,`panel-data-${serviceId}-data`,null,binding.created_at,binding.created_at);
  db.prepare('INSERT INTO volume_restore_bindings VALUES(?,?,?,?,?,?)').run(serviceId,'/data','data',binding.volume_name,operationId,binding.created_at);db.close();
  return{dir,binding};
}
it('persists the new data selection and refuses a binding with no matching completed switch',()=>{
  const{dir,binding}=fixture();expect(readVolumeBindings(dir,binding.service_id)).toEqual([binding]);
  const db=new Database(join(dir,'agent.sqlite'));db.prepare("UPDATE volume_restore_operations SET phase='switching'").run();db.close();
  expect(()=>readVolumeBindings(dir,binding.service_id)).toThrow('metadata is invalid');
});
it('rejects configuration changes that would silently select a different volume',()=>{
  const{binding}=fixture();const service={kind:'app',mounts:[{type:'volume',name:'data',target:'/data'}]} as Service;
  expect(()=>validateBoundMounts(service,[binding])).not.toThrow();
  for(const mounts of [[],[{type:'volume',name:'other',target:'/data'}],[{type:'volume',name:'data',target:'/data',readOnly:true}],[{type:'bind',name:'data',target:'/data',source:'/host'}]])expect(()=>validateBoundMounts({...service,mounts} as Service,[binding])).toThrow('restored application mount');
});
it('verifies both committed mount selection and owned Docker volume identity',async()=>{
  const{binding}=fixture();const inspected={Name:binding.volume_name,Driver:'local',Labels:{'panel.owner':'self-hosted-panel','panel.service':binding.service_id,'panel.volume.restore.operation':binding.operation_id,'panel.volume.restore.purpose':'candidate'}};
  const docker={getVolume:vi.fn(()=>({inspect:async()=>inspected}))} as unknown as Docker;
  const spec:Docker.ServiceSpec={Labels:{'panel.owner':'self-hosted-panel','panel.service':binding.service_id},TaskTemplate:{ContainerSpec:{Image:'alpine',Mounts:[{Type:'volume',Source:binding.volume_name,Target:'/data'}]}}};
  await expect(verifyBoundRuntime(docker,spec,[binding])).resolves.toBeUndefined();
  await expect(verifyBoundRuntime(docker,spec,[])).rejects.toThrow('binding is missing');
  inspected.Labels['panel.service']=randomUUID();await expect(verifyBoundRuntime(docker,spec,[binding])).rejects.toThrow('ownership');
});
