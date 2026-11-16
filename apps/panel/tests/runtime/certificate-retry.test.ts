import { expect, it } from 'vitest';
import type Docker from 'dockerode';
import { planCertificateRetry } from '../../src/agent/certificate-retry.js';
import { httpsRouteLabels } from '../../src/agent/https-routing.js';

const id='64150ff3-fc4c-4c33-b79a-4821482be3c1',host='app.example.com',now=Date.parse('2026-11-16T00:00:00Z');
function service():Docker.ServiceSpec {return {Name:`panel-app-${id}`,Labels:{'panel.owner':'self-hosted-panel','panel.service':id,...httpsRouteLabels(id,0,host,80)},TaskTemplate:{ContainerSpec:{Image:'example@sha256:'+'a'.repeat(64)}},Mode:{Replicated:{Replicas:1}}};}
it('requests a provider refresh without changing application tasks or unrelated labels',()=>{
  const before=service(),copy=structuredClone(before),after=planCertificateRetry(before,id,host,now),key=`traefik.http.routers.${id.replaceAll('-','')}-0-https.tls.domains[0].main`;
  expect(before).toEqual(copy);expect(after.TaskTemplate).toEqual(before.TaskTemplate);
  expect(after.Labels?.[key]).toBe(host);
  expect(after.Labels?.['panel.acme-retry-0']).toBe(new Date(now).toISOString());
  expect(()=>planCertificateRetry(after,id,host,now+60_000)).toThrow(/15 minutes/);
  const again=planCertificateRetry(after,id,host,now+16*60_000);
  expect(again.Labels?.[key]).toBeUndefined();
});
it('rejects wrong ownership, mismatched routes and custom TLS domains',()=>{
  const foreign=service();foreign.Labels!['panel.owner']='other';expect(()=>planCertificateRetry(foreign,id,host,now)).toThrow();
  expect(()=>planCertificateRetry(service(),id,'other.example.com',now)).toThrow();
  const custom=service();custom.Labels![`traefik.http.routers.${id.replaceAll('-','')}-0-https.tls.domains[0].sans`]='other.example.com';
  expect(()=>planCertificateRetry(custom,id,host,now)).toThrow();
  const invalid=service();invalid.Labels!['panel.acme-retry-0']='bad';expect(()=>planCertificateRetry(invalid,id,host,now)).toThrow();
});
