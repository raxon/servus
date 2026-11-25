import type Docker from 'dockerode';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { execOutput } from './observability.js';
import type { RestoreSwitchPlan } from './restore-switch-intent.js';

/** Verify Swarm convergence, exclusive volume use and authenticated database readiness. */
export async function verifyRestoreDatabase(options:{docker:Docker;plan:RestoreSwitchPlan;side:'source'|'target';kind:'postgres'|'mariadb'|'redis'|'mysql'|'mongodb';attempts?:number;delayMs?:number}):Promise<void> {
  const {inspection}=options.plan,expected=options.side==='source'?options.plan.previousSpec:options.plan.targetSpec;
  const volumeName=options.side==='source'?inspection.sourceVolume:inspection.candidateVolume,otherVolume=options.side==='source'?inspection.candidateVolume:inspection.sourceVolume;
  const dataPath=options.kind==='postgres'?'/var/lib/postgresql/data':options.kind==='redis'?'/data':options.kind==='mongodb'?'/data/db':'/var/lib/mysql',name=`panel-app-${inspection.serviceId}`;
  const attempts=options.attempts??60,delayMs=options.delayMs??1000;
  if(!Number.isInteger(attempts)||attempts<1||attempts>120||!Number.isInteger(delayMs)||delayMs<0||delayMs>5000)throw new Error('Invalid restore verification limits.');
  const command=options.kind==='postgres'
    ? 'PGCONNECT_TIMEOUT=3 PGPASSWORD="$(cat /run/secrets/panel-db-password)" exec psql --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-password --tuples-only --command="SELECT 1"'
    : options.kind==='redis' ? 'REDISCLI_AUTH="$(cat /run/secrets/panel-db-password)" exec redis-cli --no-auth-warning -h 127.0.0.1 ping'
    : options.kind==='mysql' ? 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)" exec mysql --connect-timeout=3 --protocol=TCP --host=127.0.0.1 --user="$MYSQL_USER" --database="$MYSQL_DATABASE" --batch --skip-column-names --execute="SELECT 1"'
    : options.kind==='mongodb' ? 'MONGO_PASS="$(cat /run/secrets/panel-db-password)" exec mongosh --quiet --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_PASS" --authenticationDatabase admin --eval "db.adminCommand({ping:1}).ok"'
    : 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)" exec mariadb --connect-timeout=3 --protocol=TCP --host=127.0.0.1 --user="$MARIADB_USER" --database="$MARIADB_DATABASE" --batch --skip-column-names --execute="SELECT 1"';
  for(let attempt=0;attempt<attempts;attempt++){
    const service=await options.docker.getService(name).inspect(),node=(await options.docker.info()).Swarm?.NodeID;
    if(service.ID!==inspection.serviceDockerId||node!==inspection.nodeId||!isDeepStrictEqual(service.Spec,expected))throw new Error('Database service does not match the recorded restore configuration.');
    const state=service.UpdateStatus?.State;
    if(state&&['paused','rollback_paused','rollback_started'].includes(state))throw new Error('Database service update did not converge.');
    const tasks=await options.docker.listTasks({filters:{service:[name],'desired-state':['running']}});
    const active=tasks.filter(task=>task.Status?.State==='running');
    if((!state||state==='completed'||(options.side==='source'&&state==='rollback_completed'))&&active.length===1){
      const task=active[0]!,id=task.Status?.ContainerStatus?.ContainerID;
      const spec=task.Spec&&'ContainerSpec' in task.Spec?task.Spec.ContainerSpec:undefined;
      const mounts=spec?.Mounts??[];
      if(task.NodeID!==inspection.nodeId||!id||mounts.length!==1||mounts[0]?.Type!=='volume'||mounts[0].Source!==volumeName||mounts[0].Target!==dataPath||mounts[0].ReadOnly)throw new Error('Database task does not match the recorded restore volume.');
      const attached=await options.docker.listContainers({all:true,filters:{volume:[volumeName]}});
      const running=[];
      for(const item of attached){const info=await options.docker.getContainer(item.Id).inspect();if(info.State.Running)running.push(info);}
      if(running.length===1){
        const info=running[0]!;
        if(info.Id!==id||info.Image!==inspection.imageId||info.Config.Labels?.['panel.owner']!=='self-hosted-panel'||info.Config.Labels?.['panel.service']!==inspection.serviceId||info.Config.Labels?.['com.docker.swarm.service.name']!==name||info.Mounts.length!==1||!info.Mounts.some(m=>m.Type==='volume'&&m.Name===volumeName&&m.Destination===dataPath&&m.RW))throw new Error('Running database container does not match the restore task.');
        const other=await options.docker.listContainers({all:true,filters:{volume:[otherVolume]}});
        for(const item of other){const stale=await options.docker.getContainer(item.Id).inspect();if(stale.State.Running&&!(options.side==='source'&&stale.Id===inspection.candidateContainerId&&stale.HostConfig.NetworkMode==='none'&&stale.Config.Labels?.['panel.restore.operation']===inspection.operationId))throw new Error('A database is still running on the other volume.');}
        let ready=false;try{const result=await execOutput(options.docker,id,['/bin/sh','-c',command]);const health=info.State.Health?.Status;ready=(!health||health==='healthy')&&result.code===0&&result.output.split('\n').some(line=>line.trim()===(options.kind==='redis'?'PONG':'1'));if(ready&&options.kind==='redis'){const denied=await execOutput(options.docker,id,['redis-cli','--no-auth-warning','-h','127.0.0.1','ping']);ready=denied.output.includes('NOAUTH');}}catch{ready=false;}
        if(ready){
          const latest=await options.docker.getService(name).inspect(),again=await options.docker.getContainer(id).inspect();
          if(latest.ID!==service.ID||latest.Version?.Index!==service.Version?.Index||!isDeepStrictEqual(latest.Spec,expected)||!again.State.Running)throw new Error('Database service changed during restore verification.');
          return;
        }
      } else if(running.length>1)throw new Error('More than one database is running on the restore volume.');
    } else if(active.length>1)throw new Error('More than one database task is running.');
    if(attempt+1<attempts)await delay(delayMs);
  }
  throw new Error('Database restore readiness could not be verified.');
}
