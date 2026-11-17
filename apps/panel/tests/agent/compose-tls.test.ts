import {describe,it,expect,vi} from 'vitest';
import type Docker from 'dockerode';
import {randomUUID} from 'node:crypto';
import {assertComposeHttpsIngress,composeCertificateStatus,configuredComposeHttps} from '../../src/agent/compose-tls.js';
import {compileComposeDefinition,parseComposeDefinition} from '../../src/agent/compose-configuration.js';
import {composeProviderArguments} from '../../src/agent/compose-ingress.js';

function fixture(){
  const workloadId=randomUUID(),projectId=randomUUID(),hostname='compose.example.test',yaml='services: {web: {image: nginx}}';
  const configuration={source:{type:'inline' as const,yaml},domains:[{hostname,service:'web',port:80,https:true}]};
  const labels=compileComposeDefinition(parseComposeDefinition(yaml),configuration,workloadId,projectId).definition.services.web.labels;
  const spec={Labels:{'panel.owner':'self-hosted-panel','panel.https':'servus-acme-v1'},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Args:[...composeProviderArguments,'--entrypoints.web.address=:8080','--entrypoints.websecure.address=:8443','--certificatesresolvers.servus.acme.storage=/letsencrypt/acme.json','--certificatesresolvers.servus.acme.httpchallenge.entrypoint=web'],Mounts:[{Type:'volume',Source:'servus-acme',Target:'/letsencrypt'}]}},EndpointSpec:{Ports:[{Protocol:'tcp',PublishedPort:80,TargetPort:8080,PublishMode:'host'},{Protocol:'tcp',PublishedPort:443,TargetPort:8443,PublishMode:'host'}]}};
  const docker={getService:()=>({inspect:async()=>({Spec:spec}),logs:async()=>Buffer.alloc(0)}),getNetwork:()=>({inspect:async()=>({Labels:{'panel.owner':'self-hosted-panel'},Driver:'overlay',Attachable:true})}),getVolume:()=>({inspect:async()=>({Driver:'local',Labels:{'panel.owner':'self-hosted-panel','panel.purpose':'acme'}})}),listContainers:vi.fn(async()=>[{State:'running',Labels:{...labels,'com.docker.compose.service':'web'}}])} as unknown as Docker;
  return{docker,spec,configuration,workloadId,projectId,hostname,labels};
}
describe('Compose managed HTTPS verification',()=>{
  it('requires owned ACME ingress and the constrained Docker provider',async()=>{
    const f=fixture();await expect(assertComposeHttpsIngress(f.docker)).resolves.toBeUndefined();
    f.spec.TaskTemplate.ContainerSpec.Args=f.spec.TaskTemplate.ContainerSpec.Args.filter(arg=>!arg.startsWith('--providers.docker.constraints'));
    await expect(assertComposeHttpsIngress(f.docker)).rejects.toMatchObject({code:'HTTPS_NOT_CONFIGURED'});
  });
  it('does not treat a stored certificate as public verification and returns metadata only',async()=>{
    const f=fixture(),certificate={status:'active' as const,notBefore:'2026-01-01T00:00:00.000Z',expiresAt:'2027-01-01T00:00:00.000Z',fingerprint:Array(32).fill('AA').join(':')},verify=vi.fn(async()=>false);
    const result=await composeCertificateStatus(f.docker,f.workloadId,f.projectId,f.configuration,f.hostname,{inspectCertificate:async()=>certificate,verifyEndpoints:verify});
    expect(result).toMatchObject({status:'active',publicVerified:false,hostname:f.hostname});expect(verify).toHaveBeenCalledWith(f.hostname,certificate.fingerprint);
    const success=await composeCertificateStatus(f.docker,f.workloadId,f.projectId,f.configuration,f.hostname,{inspectCertificate:async()=>certificate,verifyEndpoints:async()=>true});expect(success.publicVerified).toBe(true);
  });
  it('rejects routes belonging to another project before reading certificates',async()=>{
    const f=fixture(),inspect=vi.fn();vi.mocked(f.docker.listContainers).mockResolvedValue([{State:'running',Labels:{...f.labels,'panel.project':randomUUID(),'com.docker.compose.service':'web'}}] as never);
    await expect(composeCertificateStatus(f.docker,f.workloadId,f.projectId,f.configuration,f.hostname,{inspectCertificate:inspect})).rejects.toMatchObject({code:'CERTIFICATE_DOMAIN'});expect(inspect).not.toHaveBeenCalled();
  });
  it('rejects missing, mismatched and unpublished TLS routes',async()=>{
    const f=fixture();expect(()=>configuredComposeHttps(f.configuration,'foreign.example.test')).toThrow();expect(()=>configuredComposeHttps(f.configuration,'compose.localhost')).toThrow();
    delete f.labels[`traefik.http.routers.compose-${f.workloadId.replaceAll('-','')}-0-https.tls.certresolver`];
    vi.mocked(f.docker.listContainers).mockResolvedValue([{State:'running',Labels:{...f.labels,'com.docker.compose.service':'web'}}] as never);
    await expect(composeCertificateStatus(f.docker,f.workloadId,f.projectId,f.configuration,f.hostname)).rejects.toMatchObject({code:'CERTIFICATE_DOMAIN'});
  });
});
