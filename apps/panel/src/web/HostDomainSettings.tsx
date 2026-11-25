import { useQuery } from '@tanstack/react-query';
import { Globe2 } from 'lucide-react';
import type { HostDomainStatus } from '../shared/host-domain.js';
import { api } from './api.js';
import { FeatureError } from './feature-ui.js';

export function useHostDomain() {
  return useQuery({queryKey:['host-domain'],queryFn:()=>api<HostDomainStatus>('/host-domain'),retry:false,refetchInterval:query=>query.state.data?.busy || (query.state.data?.enabled&&!query.state.data.ready)?3000:60_000});
}

export function HostDomainSettings() {
  const query=useHostDomain();
  const value=query.data;
  return <section id="host-domain" className="surface details-card central-settings">
    <div className="card-heading"><Globe2 size={19} aria-hidden="true"/><h3>Servus domain</h3></div>
    {query.isPending?<p>Loading domain settings...</p>:query.error?<FeatureError error={query.error}/>:value?<>
      <div className="detail-row"><span>Status</span><strong role="status">{value.busy?'Synchronizing':value.ready?'Ready':value.enabled?'Configuring':value.available?'Pending':'Unavailable'}</strong></div>
      {value.hostname?<div className="detail-row host-domain-address"><span>Panel address</span>{value.ready?<a className="mono" href={`https://${value.hostname}`} target="_blank" rel="noreferrer">{value.hostname}</a>:<strong className="mono">{value.hostname}</strong>}</div>:null}
      {value.ip?<div className="detail-row"><span>Server IP</span><strong className="mono">{value.ip}</strong></div>:null}
      {value.hostname?<div className="detail-row"><span>DNS</span><strong>{value.dnsStatus==='ready'?'Configured':'Pending'}</strong></div>:null}
      {value.certificateExpiresAt?<div className="detail-row"><span>Certificate expires</span><strong>{new Date(value.certificateExpiresAt).toLocaleString()}</strong></div>:null}
      {value.lastSyncAt?<p className="feature-helper">Last synchronized {new Date(value.lastSyncAt).toLocaleString()}.</p>:null}
      {value.lastError?<p className="error-notice" role="status">{value.lastError}</p>:null}
    </>:null}
  </section>;
}
