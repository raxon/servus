import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api } from './api.js';
import { FeatureError, FeatureModal } from './feature-ui.js';

type Settings={email:string;staging:boolean};
export function HttpsSettings({configured,access,recoveryRequired,busy}:{configured:boolean;access?:'direct'|'external';recoveryRequired:boolean;busy:boolean}) {
  const client=useQueryClient();
  const [draft,setDraft]=useState<Settings|null>(null);
  const [confirm,setConfirm]=useState<'migrate'|'migrate-external'|'recover'|null>(null);
  const cancelRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(confirm)cancelRef.current?.focus();},[confirm]);
  const query=useQuery({queryKey:['https-settings'],queryFn:()=>api<{settings:Settings|null}>('/settings/https'),retry:false});
  const save=useMutation({mutationFn:(body:Settings)=>api<{settings:Settings}>('/settings/https',{method:'PUT',body}),onSuccess:result=>{client.setQueryData(['https-settings'],result);setDraft(null);}});
  const change=useMutation({mutationFn:(action:'migrate'|'migrate-external'|'recover')=>api<{ok:true}>(`/settings/https/${action}`,{method:'POST',body:{confirm:true}}),onSuccess:()=>setConfirm(null),onSettled:()=>{void client.invalidateQueries({queryKey:['runtime']});}});
  const value=draft??query.data?.settings??{email:'',staging:false};
  return <section id="https-settings" className="surface details-card central-settings">
    <div className="card-heading"><ShieldCheck size={19} aria-hidden="true"/><h2>Application HTTPS</h2></div>
    <p>Configure the ACME contact for automatic certificates on application domains.</p>
    <p role="status">{recoveryRequired ? 'An earlier ingress change needs recovery before service changes can continue.' : configured ? 'Managed HTTPS ingress is configured. Saving settings does not change its active configuration.' : 'Save your settings, then choose direct access on port 443 or an existing TLS proxy.'}</p>
    {configured && access==='external' ? <p>External TLS forwarding must be configured separately: send application-domain TLS traffic to <code>127.0.0.1:18443</code> without terminating it. This panel cannot verify the external proxy configuration.</p> : null}
    {query.isPending ? <p>Loading HTTPS settings...</p> : query.error ? <FeatureError error={query.error}/> : <form aria-label="Application HTTPS settings" onSubmit={event=>{event.preventDefault();save.mutate(value);}}>
      <label>Certificate contact email<input type="email" name="acme-email" autoComplete="email" maxLength={254} required value={value.email} onChange={event=>{setDraft({...value,email:event.target.value});save.reset();}}/><small>Certificate authorities may use this address for expiry and account notices.</small></label>
      <fieldset className="https-environment"><legend>Certificate environment</legend>
        <label><input type="radio" name="acme-environment" checked={!value.staging} onChange={()=>{setDraft({...value,staging:false});save.reset();}}/> Production certificates</label>
        <label><input type="radio" name="acme-environment" checked={value.staging} onChange={()=>{setDraft({...value,staging:true});save.reset();}}/> Staging certificates for testing</label>
        <small>Staging certificates are not trusted by browsers.</small>
      </fieldset>
      <FeatureError error={save.error}/>{save.isSuccess ? <p role="status">HTTPS settings saved.</p> : null}
      <button type="submit" className="button button-primary" disabled={save.isPending}>{save.isPending?'Saving...':'Save HTTPS settings'}</button>
    </form>}
    {recoveryRequired ? <button type="button" className="button button-secondary" disabled={busy} onClick={()=>{change.reset();setConfirm('recover');}}>Recover ingress</button> : !configured && query.data?.settings ? <div className="https-actions"><button type="button" className="button button-secondary" disabled={!!draft || busy || save.isPending} onClick={()=>{change.reset();setConfirm('migrate');}}>Enable HTTPS ingress</button><button type="button" className="button button-secondary" disabled={!!draft || busy || save.isPending} onClick={()=>{change.reset();setConfirm('migrate-external');}}>Use an existing TLS proxy</button></div> : null}
    {change.isSuccess ? <p role="status">Ingress operation completed. Checking status...</p> : null}
    {confirm ? <FeatureModal title={confirm==='recover'?'Recover ingress?':'Enable HTTPS ingress?'} description={confirm==='recover'?'The previous proxy configuration will be restored if it can be verified safely.':confirm==='migrate-external'?'The managed proxy will briefly restart. Configure your existing proxy to forward TLS for application domains to 127.0.0.1:18443 without terminating it. Existing proxy configuration is not changed.':'The managed proxy will briefly restart. Existing HTTP routes are restored if the change fails.'} dismissible={!change.isPending} onClose={()=>setConfirm(null)}>
      <FeatureError error={change.error}/>
      <div className="modal-footer">
        <button ref={cancelRef} type="button" className="button button-secondary" autoFocus disabled={change.isPending} onClick={()=>setConfirm(null)}>Cancel</button>
        <button type="button" className="button button-primary" disabled={change.isPending} onClick={()=>change.mutate(confirm)}>{change.isPending?'Working...':confirm==='recover'?'Recover ingress':'Enable HTTPS'}</button>
      </div>
    </FeatureModal> : null}
  </section>;
}
