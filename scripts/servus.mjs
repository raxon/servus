#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request, resourceId } from './servus-client.mjs';

const help=`Servus CLI
Set SERVUS_URL and SERVUS_TOKEN (a project-scoped API token).

  projects                      List the authorized project
  services PROJECT_ID           List project services
  service SERVICE_ID            Read service configuration
  project-env PROJECT_ID        List shared project environment variables
  project-scripts PROJECT_ID    List saved project operational scripts
  action ACTION_ID              Read deployment status and events
  action-cancel ACTION_ID       Cancel a queued action or active build
  logs SERVICE_ID               Read recent runtime logs
  logs-history SERVICE_ID [--window 1h|6h|24h|7d] [--q TEXT] [--level all|error|warn|info]
                                Search archived service logs
  metrics SERVICE_ID            Read current runtime metrics
  metrics-history SERVICE_ID [--window 1h|6h|24h]
                                Read historical service metrics
  backups SERVICE_ID            List managed database backups
  backup-create SERVICE_ID [--name NAME] [--idempotency-key KEY]
                                Queue a manual managed database backup
  deploy SERVICE_ID [--force-rebuild] [--idempotency-key KEY]
  start|stop|restart SERVICE_ID [--idempotency-key KEY]
  compose PROJECT_ID            List project Compose workloads
  compose-create PROJECT_ID --name NAME --file PATH [--idempotency-key KEY]
                                Create and deploy an inline Compose workload
  compose-workload WORKLOAD_ID   Read Compose workload metadata
  compose-actions WORKLOAD_ID    Read Compose action history and status
  compose-logs WORKLOAD_ID       Read Compose runtime logs
  compose-metrics WORKLOAD_ID    Read Compose runtime metrics
  compose-deploy|compose-start|compose-stop|compose-restart WORKLOAD_ID [--idempotency-key KEY]
  compose-destroy WORKLOAD_ID --confirm [--idempotency-key KEY]

Output is JSON. Mutations return an action ID; poll with action ACTION_ID.
For Compose, poll with compose-actions WORKLOAD_ID.
Use node scripts/servus-mcp.mjs for the stdio MCP server.
`;
try {
  const [command,id,...flags]=process.argv.slice(2);
  if(!command||['help','--help','-h'].includes(command)){process.stdout.write(help);}
  else {
    let path,method='GET',body,key;
    const mutations=['deploy','start','stop','restart'],composeOperation=command.startsWith('compose-')?command.slice(8):undefined;
    if(command==='projects'){if(id||flags.length)throw new Error('projects takes no arguments.');path='/projects';}
    else {
      resourceId(id);
      if(command==='compose-create'){
        let name,file;
        for(let index=0;index<flags.length;index++){
          if(flags[index]==='--name'&&flags[index+1])name=flags[++index];
          else if(flags[index]==='--file'&&flags[index+1])file=flags[++index];
          else if(flags[index]==='--idempotency-key'&&flags[index+1])key=flags[++index];
          else throw new Error('Unknown or incomplete compose-create option. Use --help.');
        }
        if(!name||!file)throw new Error('compose-create requires --name and --file.');
        if(key&&key.length>128)throw new Error('Idempotency keys cannot exceed 128 characters.');
        key||=randomUUID();method='POST';path=`/projects/${id}/compose`;
        body={name,source:{type:'inline',yaml:readFileSync(file,'utf8')},domains:[]};
      } else if(command==='compose-destroy'){
        let confirm=false;
        for(let index=0;index<flags.length;index++){
          if(flags[index]==='--confirm')confirm=true;
          else if(flags[index]==='--idempotency-key'&&flags[index+1])key=flags[++index];
          else throw new Error('Unknown or incomplete compose-destroy option. Use --help.');
        }
        if(!confirm)throw new Error('compose-destroy requires --confirm.');
        if(key&&key.length>128)throw new Error('Idempotency keys cannot exceed 128 characters.');
        key||=randomUUID();method='POST';path=`/compose/${id}/destroy`;body={confirm:true};
      } else if(mutations.includes(command)||mutations.includes(composeOperation)){
        let forceRebuild=false;
        for(let index=0;index<flags.length;index++){
          if(flags[index]==='--force-rebuild'&&command==='deploy')forceRebuild=true;
          else if(flags[index]==='--idempotency-key'&&flags[index+1])key=flags[++index];
          else throw new Error('Unknown or incomplete option. Use --help.');
        }
        if(key&&key.length>128)throw new Error('Idempotency keys cannot exceed 128 characters.');
        key||=randomUUID();method='POST';body=command==='deploy'?{forceRebuild}:{};path=composeOperation?`/compose/${id}/${composeOperation}`:`/services/${id}/${command}`;
      } else if(command==='logs-history'){
        let window='24h',q='',level='all';
        for(let index=0;index<flags.length;index++){
          if(flags[index]==='--window'&&['1h','6h','24h','7d'].includes(flags[index+1]))window=flags[++index];
          else if(flags[index]==='--q'&&flags[index+1]!==undefined)q=flags[++index];
          else if(flags[index]==='--level'&&['all','error','warn','info'].includes(flags[index+1]))level=flags[++index];
          else throw new Error('Unknown or invalid logs-history option. Use --help.');
        }
        const params=new URLSearchParams({window,level,...(q?{q}:{})});
        path=`/services/${id}/logs/history?${params.toString()}`;
      } else if(command==='metrics-history'){
        let window='1h';
        for(let index=0;index<flags.length;index++){
          if(flags[index]==='--window'&&['1h','6h','24h'].includes(flags[index+1]))window=flags[++index];
          else throw new Error('Unknown or invalid --window option. Use 1h, 6h or 24h.');
        }
        path=`/services/${id}/metrics/history?window=${window}`;
      } else if(command==='backup-create'){
        let name;
        for(let index=0;index<flags.length;index++){
          if(flags[index]==='--name'&&flags[index+1])name=flags[++index];
          else if(flags[index]==='--idempotency-key'&&flags[index+1])key=flags[++index];
          else throw new Error('Unknown or incomplete option. Use --help.');
        }
        if(key&&key.length>128)throw new Error('Idempotency keys cannot exceed 128 characters.');
        key||=randomUUID();method='POST';body=name?{name}:{};path=`/services/${id}/backups`;
      } else if(command==='action-cancel'){
        if(flags.length)throw new Error('Unknown option. Use --help.');
        method='POST';body={};path=`/actions/${id}/cancel`;
      } else {
        if(flags.length)throw new Error('Unknown option. Use --help.');
        path=command==='services'?`/projects/${id}/services`:command==='service'?`/services/${id}`:command==='project-env'?`/projects/${id}/env`:command==='project-scripts'?`/projects/${id}/scripts`:command==='action'?`/actions/${id}`:command==='logs'?`/services/${id}/logs`:command==='metrics'?`/services/${id}/metrics`:command==='backups'?`/services/${id}/backups`:command==='compose'?`/projects/${id}/compose`:command==='compose-workload'?`/compose/${id}`:command==='compose-actions'?`/compose/${id}/actions`:command==='compose-logs'?`/compose/${id}/logs`:command==='compose-metrics'?`/compose/${id}/metrics`:undefined;
        if(!path)throw new Error('Unknown command. Use --help.');
      }
    }
    const result=await request(path,{method,body,key});
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  }
} catch(error){process.stderr.write(`${error instanceof Error?error.message:'The command failed.'}\n`);process.exitCode=1;}
