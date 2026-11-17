import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import type { Action, DomainConfig, Service } from '../shared/types.js';
import { api, errorMessage } from './api.js';
import { applicationUrl } from './application-url.js';

type Operation = 'start' | 'stop' | 'restart';
const pending = (action:Action) => action.status === 'queued' || action.status === 'running';

/** A per-service action menu; the lightweight details fallback works without Popover. */
export function DashboardActions({service,canWrite,ingressPort}:{service:Service;canWrite:boolean;ingressPort:number}) {
  const client=useQueryClient(),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),enterOnOpen=useRef(false);
  const [open,setOpen]=useState(false),[notice,setNotice]=useState(''),[watch,setWatch]=useState(false);
  const popoverSupported=typeof HTMLElement!=='undefined' && 'popover' in HTMLElement.prototype;
  const invokerSupported=typeof HTMLButtonElement!=='undefined' && 'commandForElement' in HTMLButtonElement.prototype;
  const focusgroupSupported=typeof HTMLElement!=='undefined' && 'focusGroup' in HTMLElement.prototype;
  const menuId=`service-actions-${service.id}`,triggerId=`service-actions-trigger-${service.id}`;
  const status=useQuery({queryKey:['service-actions',service.id],queryFn:()=>api<Action[]>(`/services/${service.id}/actions`),enabled:open||watch,
    refetchInterval:query=>(watch||open) && query.state.data?.some(pending) ? 1500 : false,staleTime:0});
  const changes=useQuery({queryKey:['configuration-changes',service.id,service.revision,service.deployedRevision],
    queryFn:()=>api<{status:'not_deployed'|'unavailable'|'available';deployedPrimaryDomain?:DomainConfig|null}>(`/services/${service.id}/configuration-changes`),
    enabled:open && service.deployedRevision!==null && service.revision!==service.deployedRevision});
  const action=useMutation({mutationFn:(operation:Operation)=>api<Action>(`/services/${service.id}/${operation}`,{method:'POST',body:{},idempotent:true}),
    onSuccess:(result,operation)=>{client.setQueryData<Action[]>(['service-actions',service.id],old=>[result,...(old??[]).filter(item=>item.id!==result.id)]);setWatch(true);setNotice(`${operation[0]!.toUpperCase()+operation.slice(1)} queued.`);void client.invalidateQueries({queryKey:['services',service.projectId]});},
    onError:error=>setNotice(errorMessage(error))});
  const busy=action.isPending || status.isPending || status.isFetching || status.isError || !!status.data?.some(pending) || service.state==='deploying' || service.state==='pending';
  const domains=service.domains??[{hostname:service.hostname,port:service.port,primary:true}];
  const primary=service.deployedRevision===null ? null : service.revision!==service.deployedRevision
    ? changes.data?.status==='available' ? changes.data.deployedPrimaryDomain : null
    : domains.find(item=>item.primary)??domains[0];
  const appUrl=service.kind && service.kind!=='app' ? null : applicationUrl(primary,ingressPort);
  const items=()=>Array.from(menu.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)')??[]);
  const position=()=>{
    if(!menu.current||!trigger.current || (popoverSupported && CSS.supports('position-area: block-end')))return;
    const button=trigger.current.getBoundingClientRect(),popup=menu.current.getBoundingClientRect(),gap=6;
    const left=Math.max(8,Math.min(window.innerWidth-popup.width-8,button.right-popup.width));
    const below=button.bottom+gap,top=below+popup.height<=window.innerHeight-8?below:Math.max(8,button.top-popup.height-gap);
    Object.assign(menu.current.style,{left:`${left}px`,top:`${top}px`});
  };
  const close=(restore=false)=>{
    if(restore)trigger.current?.focus({preventScroll:true});
    if(popoverSupported && menu.current?.matches(':popover-open'))menu.current.hidePopover();
    else if(!popoverSupported)setOpen(false);
  };
  useEffect(()=>{
    const el=menu.current;if(!el||!popoverSupported)return;
    const toggle=(event:Event)=>{const active=(event as ToggleEvent).newState==='open';setOpen(active);if(active)requestAnimationFrame(()=>{position();if(enterOnOpen.current){enterOnOpen.current=false;items()[0]?.focus();}});};
    el.addEventListener('toggle',toggle);return()=>el.removeEventListener('toggle',toggle);
  },[popoverSupported]);
  useEffect(()=>{
    if(!open)return;
    if(!popoverSupported)requestAnimationFrame(()=>{position();if(enterOnOpen.current){enterOnOpen.current=false;items()[0]?.focus();}});
    const focus=(event:FocusEvent)=>{if(event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target))close();};
    const pointer=(event:PointerEvent)=>{if(!popoverSupported && event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target))close();};
    const reposition=()=>position();document.addEventListener('focusin',focus);document.addEventListener('pointerdown',pointer);window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true);
    return()=>{document.removeEventListener('focusin',focus);document.removeEventListener('pointerdown',pointer);window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true);};
  },[open,popoverSupported]);
  const openFallback=()=>{if(popoverSupported && menu.current){if(menu.current.matches(':popover-open'))menu.current.hidePopover();else {try{menu.current.showPopover({source:trigger.current??undefined});}catch{menu.current.showPopover();}}}else setOpen(value=>!value);};
  const activate=(operation:Operation)=>{if(busy)return;setNotice('');action.mutate(operation);close(true);};
  const buttonProps=popoverSupported?({commandfor:menuId,command:'toggle-popover'} as Record<string,string>):{};
  // Some Chromium builds expose focusGroup and move focus, but do not expose
  // inferred menu roles in the accessibility tree. Keep explicit roles there.
  const groupProps=({'focusgroup':'menu nomemory',role:'menu'} as Record<string,string>);
  const itemRole={role:'menuitem'};
  return <><div className="dashboard-action-area">
    <button ref={trigger} id={triggerId} className="dashboard-action-trigger" type="button" aria-label={`Actions for ${service.name}`} aria-haspopup="menu" aria-expanded={open}
      {...buttonProps} onPointerDown={event=>event.preventDefault()} onClick={event=>{enterOnOpen.current=event.detail===0;if(!popoverSupported||!invokerSupported){event.preventDefault();openFallback();}}}
      onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();if(open)items()[0]?.focus();else {enterOnOpen.current=true;trigger.current?.click();}}}}><MoreHorizontal size={19} aria-hidden="true" /></button>
    <div ref={menu} id={menuId} className="dashboard-action-popover" {...(popoverSupported?{popover:'auto'}:{hidden:!open})}>
      <div {...groupProps} aria-labelledby={triggerId} onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key) && (!focusgroupSupported||event.key==='Home'||event.key==='End')){
          const values=items(),index=values.indexOf(document.activeElement as HTMLElement);if(!values.length)return;
          const next=event.key==='Home'?0:event.key==='End'?values.length-1:(index+(event.key==='ArrowUp'?-1:1)+values.length)%values.length;
          event.preventDefault();values[next]?.focus();
        }
      }}>
        {appUrl ? <a {...itemRole} href={appUrl} target="_blank" rel="noreferrer" onClick={()=>close(true)}>Open app</a> : null}
        <a {...itemRole} href={`/services/${service.id}?tab=logs`} onClick={()=>close()}>Logs</a>
        <a {...itemRole} href={`/services/${service.id}?tab=deployments`} onClick={()=>close()}>Deployments</a>
        {service.lastError ? <a {...itemRole} href={`/services/${service.id}?tab=deployments`} onClick={()=>close()}>Error details</a> : null}
        {canWrite ? <><hr />{service.state==='stopped' ? <button {...itemRole} type="button" disabled={busy||service.deployedRevision===null} onClick={()=>activate('start')}>Start</button> : <button {...itemRole} type="button" disabled={busy||service.deployedRevision===null} onClick={()=>activate('restart')}>Restart</button>}
          {service.state==='running' ? <button {...itemRole} type="button" disabled={busy} onClick={()=>activate('stop')}>Stop</button> : null}</> : null}
        {canWrite && status.isError ? <p>Could not check active operations. <button type="button" onClick={()=>void status.refetch()}>Try again</button></p> : null}
      </div>
    </div>
  </div><p className="dashboard-action-notice" role="status">{notice}</p></>;
}
