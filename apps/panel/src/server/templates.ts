import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { stringify } from 'yaml';
import { z } from 'zod';
import { APPLICATION_TEMPLATES, type ApplicationTemplateId } from '../shared/templates.js';
import { composeDomainSchema, composeName, type ComposeConfiguration } from '../shared/compose.js';
import type { User } from '../shared/types.js';
import type { registerCompose } from './compose.js';
import { AppError } from './errors.js';
import { parseComposeDefinition } from '../agent/compose-configuration.js';

export const templateInputSchema=z.object({name:composeName,hostname:composeDomainSchema.shape.hostname.optional(),apiHostname:composeDomainSchema.shape.hostname.optional()}).strict();
type TemplateInput=z.infer<typeof templateInputSchema>;
const secret=()=>randomBytes(32).toString('base64url');

/** Build independently maintained Compose configuration; never return generated secrets. */
export function templateConfiguration(id:ApplicationTemplateId,input:TemplateInput):ComposeConfiguration {
  const template=APPLICATION_TEMPLATES.find(template=>template.id===id);
  if(!template)throw new AppError('TEMPLATE_NOT_FOUND','Application template not found.',404);
  if(input.apiHostname&&id!=='minio')throw new AppError('TEMPLATE_FIELD','Only MinIO has a separate API domain.',400);
  if(input.hostname&&input.hostname===input.apiHostname)throw new AppError('TEMPLATE_DOMAIN','The application and API need different hostnames.',400);
  let definition:Record<string,unknown>,port=80;
  const runtime={restart:'unless-stopped',cpus:1,mem_limit:'512m'};
  switch(id) {
    case 'wordpress': {
      const password=secret();
      definition={services:{app:{...runtime,image:template.images[0],environment:{WORDPRESS_DB_HOST:'database:3306',WORDPRESS_DB_USER:'wordpress',WORDPRESS_DB_NAME:'wordpress',WORDPRESS_DB_PASSWORD:password},volumes:['site:/var/www/html'],networks:['private'],depends_on:['database'],expose:[80]},database:{...runtime,image:template.images[1],environment:{MARIADB_DATABASE:'wordpress',MARIADB_USER:'wordpress',MARIADB_PASSWORD:password,MARIADB_ROOT_PASSWORD:secret()},volumes:['database:/var/lib/mysql'],networks:['private']}},volumes:{site:{},database:{}},networks:{private:{internal:true}}};
      break;
    }
    case 'n8n': {
      port=5678;
      const environment:Record<string,string>={N8N_ENCRYPTION_KEY:secret(),N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:'true',N8N_RUNNERS_ENABLED:'true',TZ:'UTC'};
      if(input.hostname)Object.assign(environment,{N8N_HOST:input.hostname,N8N_PROTOCOL:'http',N8N_SECURE_COOKIE:'false',WEBHOOK_URL:`http://${input.hostname}/`});
      definition={services:{app:{...runtime,mem_limit:'1g',image:template.images[0],environment,volumes:['data:/home/node/.n8n'],expose:[port]}},volumes:{data:{}}};break;
    }
    case 'uptime-kuma':
      port=3001;definition={services:{app:{...runtime,image:template.images[0],volumes:['data:/app/data'],expose:[port]}},volumes:{data:{}}};break;
    case 'grafana':
      port=3000;definition={services:{app:{...runtime,image:template.images[0],environment:{GF_SECURITY_ADMIN_USER:'admin',GF_SECURITY_ADMIN_PASSWORD:secret(),GF_USERS_ALLOW_SIGN_UP:'false'},volumes:['data:/var/lib/grafana'],expose:[port]}},volumes:{data:{}}};break;
    case 'minio':
      port=9001;definition={services:{app:{...runtime,image:template.images[0],environment:{MINIO_ROOT_USER:`servus${randomBytes(8).toString('hex')}`,MINIO_ROOT_PASSWORD:secret()},command:['server','/data','--console-address',':9001'],volumes:['data:/data'],expose:[9000,9001]}},volumes:{data:{}}};break;
    case 'umami': {
      port=3000;
      const dbPass=secret(),appSecret=secret();
      definition={services:{app:{...runtime,image:template.images[0],environment:{DATABASE_URL:`postgresql://umami:${dbPass}@database:5432/umami`,DATABASE_TYPE:'postgresql',APP_SECRET:appSecret},networks:['private'],depends_on:['database'],expose:[3000]},database:{...runtime,image:template.images[1],environment:{POSTGRES_DB:'umami',POSTGRES_USER:'umami',POSTGRES_PASSWORD:dbPass},volumes:['database:/var/lib/postgresql/data'],networks:['private']}},volumes:{database:{}},networks:{private:{internal:true}}};
      break;
    }
    case 'pocketbase':
      port=8090;definition={services:{app:{...runtime,image:template.images[0],volumes:['data:/pb_data'],expose:[8090]}},volumes:{data:{}}};break;
    case 'vaultwarden':
      port=80;definition={services:{app:{...runtime,image:template.images[0],environment:{SIGNUPS_ALLOWED:'true',WEBSOCKET_ENABLED:'true',...(input.hostname?{DOMAIN:`https://${input.hostname}`}:{})},volumes:['data:/data'],expose:[80]}},volumes:{data:{}}};break;
    case 'gitea':
      port=3000;definition={services:{app:{...runtime,image:template.images[0],environment:{USER_UID:'1000',USER_GID:'1000'},volumes:['data:/var/lib/gitea'],expose:[3000]}},volumes:{data:{}}};break;
    case 'metabase':
      port=3000;definition={services:{app:{...runtime,mem_limit:'1g',image:template.images[0],environment:{MB_DB_FILE:'/metabase-data/metabase.db'},volumes:['data:/metabase-data'],expose:[3000]}},volumes:{data:{}}};break;
  }
  const yaml=stringify(definition);parseComposeDefinition(yaml);
  return {source:{type:'inline',yaml},domains:[...(input.hostname?[{hostname:input.hostname,service:'app',port,https:false}]:[]),...(input.apiHostname?[{hostname:input.apiHostname,service:'app',port:9000,https:false}]:[])]};
}

interface TemplateOptions {
  session:(request:FastifyRequest,mutation?:boolean)=>{user:User};
  projectAccess:(user:User,projectId:string,write?:boolean)=>unknown;
  createWorkload:ReturnType<typeof registerCompose>['createWorkload'];
}
export function registerTemplates(app:FastifyInstance,options:TemplateOptions) {
  app.get('/api/v1/templates',async request=>{options.session(request);return {templates:APPLICATION_TEMPLATES};});
  app.post<{Params:{id:string;templateId:string}}>('/api/v1/projects/:id/templates/:templateId',async(request,reply)=>{
    const {user}=options.session(request,true);options.projectAccess(user,request.params.id,true);
    const template=APPLICATION_TEMPLATES.find(template=>template.id===request.params.templateId);
    if(!template)throw new AppError('TEMPLATE_NOT_FOUND','Application template not found.',404);
    const input=templateInputSchema.parse(request.body),key=z.string().min(1).max(128).parse(request.headers['idempotency-key']);
    const requestHash=createHash('sha256').update(JSON.stringify({operation:'template.create',projectId:request.params.id,templateId:template.id,templateVersion:template.version,input})).digest('hex');
    const result=options.createWorkload({projectId:request.params.id,user,name:input.name,configuration:templateConfiguration(template.id,input),key,requestHash});
    return reply.code(202).send(result);
  });
}
