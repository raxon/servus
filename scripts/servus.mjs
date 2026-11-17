#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { request, resourceId } from './servus-client.mjs';

const help=`Servus CLI
Set SERVUS_URL and SERVUS_TOKEN (a project-scoped API token).

  projects                      List the authorized project
  services PROJECT_ID           List project services
  service SERVICE_ID            Read service configuration
  action ACTION_ID              Read deployment status and events
  logs SERVICE_ID               Read recent runtime logs
  deploy SERVICE_ID [--force-rebuild] [--idempotency-key KEY]
  start|stop|restart SERVICE_ID [--idempotency-key KEY]
  compose PROJECT_ID            List project Compose workloads
  compose-workload WORKLOAD_ID   Read Compose workload metadata
  compose-actions WORKLOAD_ID    Read Compose action history and status
  compose-logs WORKLOAD_ID       Read Compose runtime logs
  compose-deploy|compose-start|compose-stop|compose-restart WORKLOAD_ID [--idempotency-key KEY]

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
      if(mutations.includes(command)||mutations.includes(composeOperation)){
        let forceRebuild=false;
        for(let index=0;index<flags.length;index++){
          if(flags[index]==='--force-rebuild'&&command==='deploy')forceRebuild=true;
          else if(flags[index]==='--idempotency-key'&&flags[index+1])key=flags[++index];
          else throw new Error('Unknown or incomplete option. Use --help.');
        }
        if(key&&key.length>128)throw new Error('Idempotency keys cannot exceed 128 characters.');
        key||=randomUUID();method='POST';body=command==='deploy'?{forceRebuild}:{};path=composeOperation?`/compose/${id}/${composeOperation}`:`/services/${id}/${command}`;
      } else {
        if(flags.length)throw new Error('Unknown option. Use --help.');
        path=command==='services'?`/projects/${id}/services`:command==='service'?`/services/${id}`:command==='action'?`/actions/${id}`:command==='logs'?`/services/${id}/logs`:command==='compose'?`/projects/${id}/compose`:command==='compose-workload'?`/compose/${id}`:command==='compose-actions'?`/compose/${id}/actions`:command==='compose-logs'?`/compose/${id}/logs`:undefined;
        if(!path)throw new Error('Unknown command. Use --help.');
      }
    }
    const result=await request(path,{method,body,key});
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  }
} catch(error){process.stderr.write(`${error instanceof Error?error.message:'The command failed.'}\n`);process.exitCode=1;}
