import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe2 } from 'lucide-react';
import type { HostDomainStatus } from '../shared/host-domain.js';
import { api } from './api.js';
import { FeatureError } from './feature-ui.js';

export function useHostDomain() {
  return useQuery({queryKey:['host-domain'],queryFn:()=>api<HostDomainStatus>('/host-domain'),retry:false,refetchInterval:query=>query.state.data?.busy || (query.state.data?.enabled&&!query.state.data.ready)?3000:60_000});
}

export function HostDomainSettings() {
  const query=useHostDomain(),client=useQueryClient();
  const sync=useMutation({mutationFn:()=>api<HostDomainStatus>('/host-domain/sync',{method:'POST',body:{}}),onSuccess:result=>{client.setQueryData(['host-domain'],result);void client.invalidateQueries({queryKey:['runtime']});}});
  const value=query.data;
  const busy=sync.isPending || value?.busy;
  return <section id="host-domain" className="surface details-card central-settings">
    <div className="card-heading"><Globe2 size={19} aria-hidden="true"/><h2>Servus domain</h2></div>
    <p>Use a Servus address for this panel and automatic HTTPS addresses for new applications.</p>
    {query.isPending?<p>Loading domain settings...</p>:query.error?<FeatureError error={query.error}/>:value?<>
      <p role="status" aria-atomic="true">{busy?'Synchronizing the host domain and certificate...':value.ready?'The panel domain and HTTPS connection have been verified.':value.enabled?'The domain is being configured. Synchronization will retry automatically.':value.available?'Register this installation to receive its Servus domain.':'Automatic host domains are not enabled on this installation.'}</p>
      {value.hostname?<div className="detail-row host-domain-address"><span>Panel address</span>{value.ready?<a className="mono" href={`https://${value.hostname}`} target="_blank" rel="noreferrer">{value.hostname}</a>:<strong className="mono">{value.hostname}</strong>}</div>:null}
      {value.ip?<div className="detail-row"><span>Server IP</span><strong className="mono">{value.ip}</strong></div>:null}
      {value.hostname?<div className="detail-row"><span>DNS</span><strong>{value.dnsStatus==='ready'?'Configured':'Pending'}</strong></div>:null}
      {value.certificateExpiresAt?<div className="detail-row"><span>Certificate expires</span><strong>{new Date(value.certificateExpiresAt).toLocaleString()}</strong></div>:null}
      {value.staging?<p className="feature-helper">This installation uses a staging certificate. Browsers will not trust it.</p>:null}
      {value.lastSyncAt?<p className="feature-helper">Last synchronized {new Date(value.lastSyncAt).toLocaleString()}.</p>:null}
      {value.lastError?<p className="error-notice" role="status">{value.lastError}</p>:null}
      <FeatureError error={sync.error}/>
      {value.available?<button className="button button-primary" type="button" disabled={busy} onClick={()=>sync.mutate()}>{busy?'Synchronizing...':value.enabled?'Refresh IP and configuration':'Register Servus domain'}</button>:null}
    </>:null}
  </section>;
}
