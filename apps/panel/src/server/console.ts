import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { Service, User } from '../shared/types.js';
import { agentConfig } from '../agent/config.js';
import type { agentRequest } from '../agent/client.js';
import { AppError } from './errors.js';
import { hashToken, type Store } from './store.js';
import type { MaintenanceGate } from './maintenance.js';

interface ConsoleOptions {
  store:Store;allowedOrigins:Set<string>;agentConnection?:{socketPath:string;token:string};runtimeRequest:typeof agentRequest;
  serviceAccess:(req:FastifyRequest,id:string,write?:boolean,includeDeleted?:boolean)=>{auth:{user:User;csrfToken:string};service:Service};
  maintenance?:MaintenanceGate;onUpgrade?:(req:FastifyRequest)=>void;onReadOnlyStream?:(req:FastifyRequest)=>void;
}
interface Ticket {serviceId:string;containerId:string;shell:string;sessionToken:string;expiresAt:number}
const consoleInput=z.object({containerId:z.string().regex(/^[a-f0-9]{12,64}$/),shell:z.enum(['/bin/sh','/bin/bash']).default('/bin/sh')}).strict();
const consoleAuthentication=z.object({type:z.literal('authenticate'),ticket:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const terminalInput=z.discriminatedUnion('type',[
  z.object({type:z.literal('input'),data:z.string().max(32768)}).strict(),
  z.object({type:z.literal('resize'),cols:z.number().int().min(1).max(500),rows:z.number().int().min(1).max(300)}).strict(),
]);

export function registerConsole(app:FastifyInstance,options:ConsoleOptions) {
  const {store,serviceAccess}=options,tickets=new Map<string,Ticket>(),cleanup=new Set<()=>void>();
  const stopStreams=()=>{for(const close of [...cleanup])close();tickets.clear();};
  const unregisterDrain=options.maintenance?.registerCloser(stopStreams);
  let pendingConnections=0;
  const prefix='/api/v1/services/:id';
  app.post<{Params:{id:string}}>(`${prefix}/console-ticket`,async req=>{
    const {auth}=serviceAccess(req,req.params.id,true);
    const input=consoleInput.parse(req.body);
    const containers=await options.runtimeRequest<import('../shared/types.js').ContainerInfo[]>(`/services/${req.params.id}/containers`);
    if(!containers.some(container=>container.id===input.containerId))throw new AppError('CONTAINER_NOT_FOUND','Container does not belong to this service',404);
    for(const [key,ticket]of tickets)if(ticket.expiresAt<Date.now())tickets.delete(key);
    if(tickets.size>=1000)throw new AppError('CONSOLE_LIMIT','Too many pending console grants',429);
    const ticket=randomBytes(32).toString('hex');
    tickets.set(hashToken(ticket),{serviceId:req.params.id,...input,sessionToken:req.cookies.panel_session!,expiresAt:Date.now()+30000});
    store.recordAudit(auth.user.id,'console.grant',req.params.id);
    return {ticket};
  });
  app.get<{Params:{id:string}}>(`${prefix}/console`,{
    websocket:true,
    preValidation:async req=>{
      if(!req.headers.origin||!options.allowedOrigins.has(req.headers.origin))throw new AppError('ORIGIN_DENIED','This console origin is not allowed',403);
      if(req.raw.url?.includes('?'))throw new AppError('INVALID_CONSOLE','Console URL must not contain query parameters',400);
      if(!req.cookies.panel_session||!store.getSession(req.cookies.panel_session))throw new AppError('UNAUTHORIZED','Sign in to continue',401);
    },
  },(socket,req)=>{
    options.onUpgrade?.(req);
    if(options.maintenance?.isDraining){socket.close(1012,'Service is temporarily unavailable');return;}
    if(pendingConnections>=100){socket.close(1013,'Too many pending console connections');return;}
    pendingConnections++;
    let phase:'authentication'|'connecting'|'ready'='authentication',pendingSlot=true,closed=false,ticket:Ticket|undefined,upstream:WebSocket|undefined;
    let checkSession:ReturnType<typeof setInterval>|undefined;
    const releasePending=()=>{if(pendingSlot){pendingSlot=false;pendingConnections--;}};
    const timeout=setTimeout(()=>{socket.close(1008,'Console connection timed out');close();},5000);
    timeout.unref();
    const close=()=>{
      if(closed)return;closed=true;clearTimeout(timeout);releasePending();if(checkSession)clearInterval(checkSession);cleanup.delete(close);
      if(socket.readyState===WebSocket.OPEN)socket.close(1000,'Console ended');
      if(upstream?.readyState===WebSocket.OPEN)upstream.close();else if(upstream?.readyState===WebSocket.CONNECTING)upstream.terminate();
    };
    const hasAccess=()=>{
      if(!ticket)return false;
      const current=store.getSession(ticket.sessionToken),service=store.getService(ticket.serviceId);
      return !!current && !!service && store.canAccess(current.user,service.projectId,true);
    };
    cleanup.add(close);
    socket.on('error',close);socket.on('close',close);
    socket.on('message',(data,isBinary)=>{
      try {
      if(closed)return;
      if(isBinary){socket.close(1008,'Send terminal commands as JSON');return;}
      const payload=Array.isArray(data)?Buffer.concat(data):data instanceof ArrayBuffer?Buffer.from(data):data;
      if(phase!=='ready'&&payload.length>256){socket.close(1008,'Invalid console authentication');return;}
      let parsed:unknown;
      try{parsed=JSON.parse(payload.toString('utf8'));}catch{socket.close(1008,'Invalid terminal command');return;}
      if(phase==='connecting'){socket.close(1008,'Console is not ready');return;}
      if(phase==='authentication'){
        const credentials=consoleAuthentication.safeParse(parsed);
        if(!credentials.success){socket.close(1008,'Console authentication required');return;}
        const key=hashToken(credentials.data.ticket);
        ticket=tickets.get(key);tickets.delete(key);
        if(!ticket||ticket.expiresAt<=Date.now()||ticket.serviceId!==req.params.id||!req.cookies.panel_session||hashToken(ticket.sessionToken)!==hashToken(req.cookies.panel_session)){
          socket.close(1008,'Console grant is missing or expired');return;
        }
        const auth=store.getSession(req.cookies.panel_session),service=store.getService(req.params.id);
        if(!auth||!service||!store.canAccess(auth.user,service.projectId,true)){socket.close(1008,'Console grant is unavailable');return;}
        phase='connecting';
        try {
          const config=options.agentConnection??agentConfig();
          const query=new URLSearchParams({containerId:ticket.containerId,shell:ticket.shell});
          upstream=new WebSocket(`ws://localhost/services/${ticket.serviceId}/console?${query}`,{
            createConnection:()=>connect(config.socketPath),headers:{authorization:`Bearer ${config.token}`},handshakeTimeout:5000,maxPayload:65536,
          });
        } catch { socket.close(1011,'Console is unavailable');return; }
        const activeTicket=ticket;
        checkSession=setInterval(()=>{
          try {
            if(closed)return;
            if(!hasAccess())close();
          } catch {if(socket.readyState===WebSocket.OPEN)socket.close(1011,'Console is unavailable');close();}
        },1000);
        const upstreamFailed=()=>{if(socket.readyState===WebSocket.OPEN)socket.close(1011,'Console is unavailable');close();};
        upstream.on('error',upstreamFailed);upstream.on('close',code=>{if(phase==='ready'&&code===1000)close();else upstreamFailed();});
        upstream.on('open',()=>{
          try {
            if(closed)return;
            const current=store.getSession(activeTicket.sessionToken),service=store.getService(activeTicket.serviceId);
            if(!current||!service||!store.canAccess(current.user,service.projectId,true)){socket.close(1008,'Console grant is unavailable');close();return;}
            if(closed||socket.readyState!==WebSocket.OPEN){close();return;}
            phase='ready';clearTimeout(timeout);releasePending();socket.send(JSON.stringify({type:'ready'}),error=>{if(error)close();});
          } catch {upstreamFailed();}
        });
        upstream.on('message',(chunk,binary)=>{
          try {
            if(closed)return;
            if(!hasAccess()){close();return;}
            if(socket.readyState===WebSocket.OPEN)socket.send(chunk,{binary});
          } catch {upstreamFailed();}
        });
        return;
      }
      const valid=terminalInput.safeParse(parsed);if(!valid.success){socket.close(1008,'Invalid terminal command');return;}
      if(!hasAccess()){close();return;}
      const encoded=JSON.stringify(valid.data);
      if(upstream?.readyState===WebSocket.OPEN)upstream.send(encoded);
      else socket.close(1008,'Console is not ready');
      } catch {if(socket.readyState===WebSocket.OPEN)socket.close(1011,'Console is unavailable');close();}
    });
  });

  app.get<{Params:{id:string};Querystring:{since?:string}}>(`${prefix}/logs/stream`,async(req,reply)=>{
    if(options.maintenance?.isDraining)throw new AppError('MAINTENANCE','Service is temporarily unavailable',503);
    serviceAccess(req,req.params.id);
    let cursor=req.query.since??(typeof req.headers['last-event-id']==='string'?req.headers['last-event-id']:undefined);
    if(cursor)z.string().max(50).regex(/^[0-9TZ:.+\-]+$/).parse(cursor);
    options.onReadOnlyStream?.(req);
    reply.hijack();reply.raw.setHeader('Content-Type','text/event-stream');reply.raw.setHeader('Cache-Control','no-cache');reply.raw.setHeader('Connection','keep-alive');reply.raw.flushHeaders();
    let ended=false,busy=false;const seen=new Set<string>();
    const close=()=>{if(ended)return;ended=true;clearInterval(interval);cleanup.delete(close);reply.raw.end();};
    const poll=async()=>{
      if(ended||busy)return;
      const finish=options.maintenance?.beginWork();
      try {
      const auth=store.getSession(req.cookies.panel_session!);
      const service=store.getService(req.params.id);
      if(!auth||!service||!store.canAccess(auth.user,service.projectId)){close();return;}
      busy=true;
      const before=new Date(Date.now()-1000).toISOString();
      try{
        const result=await options.runtimeRequest<import('../shared/types.js').ServiceLogs>(`/services/${req.params.id}/logs?tail=200${cursor?`&since=${encodeURIComponent(cursor)}`:''}`);
        if(ended)return;
        const current=store.getSession(req.cookies.panel_session!),currentService=store.getService(req.params.id);
        if(!current||!currentService||!store.canAccess(current.user,currentService.projectId)){close();return;}
        const lines=result.lines.filter(line=>!seen.has(line));
        for(const line of lines){seen.add(line);if(seen.size>1000)seen.delete(seen.values().next().value!);}
        const last=result.lines.at(-1)?.match(/^(\d{4}-\d\d-\d\dT[^ ]+Z)/)?.[1];cursor=last??before;
        if(lines.length)reply.raw.write(`id: ${cursor}\ndata: ${JSON.stringify({lines:store.vault.redact(lines.join('\n')).split('\n')})}\n\n`);
        else reply.raw.write(': heartbeat\n\n');
      }catch{if(!ended)reply.raw.write(`event: unavailable\ndata: ${JSON.stringify({message:'Runtime logs are temporarily unavailable'})}\n\n`);}
      finally{busy=false;}
      } finally {finish?.();}
    };
    const interval=setInterval(()=>void poll(),1000);cleanup.add(close);reply.raw.on('close',close);void poll();
  });
  app.addHook('preClose',async()=>{stopStreams();unregisterDrain?.();});
}
