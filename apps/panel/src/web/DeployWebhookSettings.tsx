import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Service } from '../shared/types.js';
import { api } from './api.js';
import { FeatureError } from './feature-ui.js';

export function DeployWebhookSettings({service,canWrite}:{service:Service;canWrite:boolean}) {
  const id=useId(),client=useQueryClient(),[reveal,setReveal]=useState<{serviceId:string;path:string;secret:string}|null>(null);
  const path=`/services/${service.id}/deploy-webhook`,key=['deploy-webhook',service.id];
  const status=useQuery({queryKey:key,queryFn:()=>api<{enabled:boolean;rotatedAt:string|null}>(path),enabled:canWrite&&service.source?.type==='git',retry:false});
  const rotate=useMutation({gcTime:0,mutationFn:(serviceId:string)=>api<{path:string;secret:string}>(`/services/${serviceId}/deploy-webhook`,{method:'POST',body:{}}),onMutate:()=>setReveal(null),onSuccess:(value,serviceId)=>{setReveal({...value,serviceId});void client.invalidateQueries({queryKey:['deploy-webhook',serviceId]});}});
  const disable=useMutation({mutationFn:(serviceId:string)=>api(`/services/${serviceId}/deploy-webhook`,{method:'DELETE'}),onSuccess:(_value,serviceId)=>{setReveal(null);rotate.reset();void client.invalidateQueries({queryKey:['deploy-webhook',serviceId]});}});
  const busy=rotate.isPending||disable.isPending;
  const visibleReveal=reveal?.serviceId===service.id?reveal:null;
  if(!canWrite||service.source?.type!=='git')return null;
  return <section className="surface details-card" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>Deployment webhook</h2>
    <p>A valid webhook queues the saved Git configuration. GitHub push events must have a valid signature and match the configured branch.</p>
    <p role="status">{status.isPending?'Checking webhook...':status.error?'Webhook status unavailable':status.data?.enabled?'Webhook enabled':'Webhook disabled'}</p>
    <button className="button" type="button" disabled={busy||status.isPending||!!status.error} onClick={()=>rotate.mutate(service.id)}>{status.data?.enabled?'Rotate webhook secret':'Enable webhook'}</button>{' '}
    {status.data?.enabled?<button className="button" type="button" disabled={busy} onClick={()=>disable.mutate(service.id)}>Disable webhook</button>:null}
    {status.error?<button className="button" type="button" onClick={()=>void status.refetch()}>Retry webhook status</button>:null}
    {visibleReveal?<div role="status"><p>Copy these values now. Rotating the secret invalidates the previous URL and GitHub secret.</p><label>Payload URL<textarea name="webhook-url" readOnly value={`${window.location.origin}${visibleReveal.path}`} rows={3} onFocus={event=>event.currentTarget.select()}/></label><label>GitHub secret<textarea name="webhook-secret" readOnly value={visibleReveal.secret} rows={2} onFocus={event=>event.currentTarget.select()}/></label><p>In GitHub, add a webhook with this URL, JSON content type, the secret above and push events. For other CI systems, POST an empty JSON object with an Idempotency-Key header. Anyone with the payload URL can trigger that CI deployment.</p><button className="button" type="button" onClick={()=>{setReveal(null);rotate.reset();}}>Hide webhook credentials</button></div>:null}
    <FeatureError error={status.error||rotate.error||disable.error}/>
  </section>;
}
