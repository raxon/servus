import { canonicalDnsName } from './acme/dns01.js';

/** Add a distinct HTTPS router without changing the existing HTTP router. */
export function httpsRouteLabels(serviceId:string, index:number, hostname:string, port:number,centralCertificate=false, pathPrefix?:string):Record<string,string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serviceId) || !Number.isSafeInteger(index) || index < 0 || index > 19 || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTPS route identity.');
  const canonical=canonicalDnsName(hostname);
  if(canonical!==hostname || canonical.endsWith('.localhost'))throw new Error('HTTPS hostname must be public and canonical.');
  const route=`${serviceId.replaceAll('-','')}-${index}`;
  const secure=`${route}-https`;
  const hasPath=Boolean(pathPrefix && pathPrefix !== '/');
  const rule=hasPath ? `Host(\`${canonical}\`) && PathPrefix(\`${pathPrefix}\`)` : `Host(\`${canonical}\`)`;
  return {
    [`traefik.http.routers.${secure}.rule`]:rule,
    [`traefik.http.routers.${secure}.entrypoints`]:'websecure',
    [`traefik.http.routers.${secure}.service`]:route,
    [`traefik.http.routers.${secure}.tls`]:'true',
    ...(hasPath ? {[`traefik.http.routers.${secure}.priority`]:String(1000 + pathPrefix!.length)} : {}),
    ...(!centralCertificate?{[`traefik.http.routers.${secure}.tls.certresolver`]:'servus'}:{}),
    [`traefik.http.services.${route}.loadbalancer.server.port`]:String(port),
  };
}

export function httpsRedirectLabels(serviceId:string,index:number,hostname:string,port:number):Record<string,string> {
  // Use the same identity and hostname validation as the HTTPS router.
  httpsRouteLabels(serviceId,index,hostname,port);
  const route=`${serviceId.replaceAll('-','')}-${index}`;
  return {
    [`traefik.http.middlewares.${route}-redirect.redirectscheme.scheme`]:'https',
    [`traefik.http.middlewares.${route}-redirect.redirectscheme.permanent`]:'true',
    [`traefik.http.routers.${route}.middlewares`]:`${route}-redirect`,
  };
}

/** Refuse to create HTTPS routes against an unrelated or incomplete ingress. */
export function supportsManagedHttps(spec: import('dockerode').ServiceSpec): boolean {
  const task=spec.TaskTemplate;
  const container=task && 'ContainerSpec' in task ? task.ContainerSpec : undefined;
  const args=new Set(container?.Args ?? []);
  const ports=spec.EndpointSpec?.Ports ?? [];
  const mounts=container?.Mounts ?? [];
  const external=spec.Labels?.['panel.https-access']==='loopback-forwarder-v1';
  const securePort=external
    ? !ports.some(port=>port.PublishedPort===443 || port.TargetPort===8443)
    : !spec.Labels?.['panel.https-access'] && ports.some(port=>port.Protocol==='tcp' && port.PublishedPort===443 && port.TargetPort===8443 && port.PublishMode==='host');
  return spec.Labels?.['panel.owner']==='self-hosted-panel' && spec.Labels?.['panel.https']==='servus-acme-v1' &&
    spec.Mode?.Replicated?.Replicas===1 &&
    args.has('--entrypoints.web.address=:8080') && args.has('--entrypoints.websecure.address=:8443') &&
    args.has('--certificatesresolvers.servus.acme.storage=/letsencrypt/acme.json') &&
    args.has('--certificatesresolvers.servus.acme.httpchallenge.entrypoint=web') &&
    securePort &&
    mounts.some(mount=>mount.Type==='volume' && mount.Source==='servus-acme' && mount.Target==='/letsencrypt' && !mount.ReadOnly);
}

export function httpsIngressOptions(env:NodeJS.ProcessEnv): {email:string;staging:boolean} | null {
  if(env.PANEL_HTTPS_ENABLED === undefined || env.PANEL_HTTPS_ENABLED === 'false')return null;
  if(env.PANEL_HTTPS_ENABLED !== 'true')throw new Error('Invalid HTTPS ingress setting.');
  const email=env.PANEL_HTTPS_EMAIL ?? '';
  if(email.length>254 || !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email))throw new Error('A valid ACME contact email is required.');
  if(env.PANEL_HTTPS_STAGING !== undefined && !['true','false'].includes(env.PANEL_HTTPS_STAGING))throw new Error('Invalid ACME staging setting.');
  return {email,staging:env.PANEL_HTTPS_STAGING==='true'};
}

/** Build a migration target without mutating the live ingress or its current HTTP routes. */
export function planHttpsIngressMigration(spec:import('dockerode').ServiceSpec,nodeId:string,settings:{email:string;staging:boolean},access:'direct'|'external'='direct'):import('dockerode').ServiceSpec {
  if(access!=='direct' && access!=='external')throw new Error('Invalid HTTPS ingress access mode.');
  const options=httpsIngressOptions({PANEL_HTTPS_ENABLED:'true',PANEL_HTTPS_EMAIL:settings.email,PANEL_HTTPS_STAGING:String(settings.staging)});
  if(!options || !/^[a-z0-9]{25}$/.test(nodeId))throw new Error('A stable Swarm manager and valid ACME settings are required.');
  if(supportsManagedHttps(spec))throw new Error('Managed HTTPS ingress is already configured.');
  const task=spec.TaskTemplate,container=task && 'ContainerSpec' in task ? task.ContainerSpec : undefined;
  const args=container?.Args ?? [],ports=spec.EndpointSpec?.Ports ?? [],mounts=container?.Mounts ?? [];
  const required=['--providers.swarm.endpoint=unix:///var/run/docker.sock','--providers.swarm.exposedbydefault=false','--providers.swarm.network=panel-ingress','--entrypoints.web.address=:8080','--api.dashboard=false','--log.level=WARN'];
  const nodeConstraints=task?.Placement?.Constraints ?? [];
  if(spec.Labels?.['panel.owner']!=='self-hosted-panel' || spec.Labels?.['panel.https'] || spec.Labels?.['panel.https-access'] || spec.Mode?.Replicated?.Replicas!==1 || !container?.Image ||
     args.length!==required.length || required.some(arg=>!args.includes(arg)) ||
     ports.length!==1 || ports[0]?.Protocol!=='tcp' || ports[0]?.PublishedPort!==80 || ports[0]?.TargetPort!==8080 || ports[0]?.PublishMode!=='host' ||
     mounts.length!==1 || mounts[0]?.Type!=='bind' || mounts[0]?.Source!=='/var/run/docker.sock' || mounts[0]?.Target!=='/var/run/docker.sock' || mounts[0]?.ReadOnly!==true ||
     nodeConstraints.length!==1 || !['node.role==manager',`node.id==${nodeId}`].includes(nodeConstraints[0]!)) {
    throw new Error('Existing ingress differs from the supported HTTP configuration; automatic migration is not safe.');
  }
  const target=structuredClone(spec);
  if(!target.TaskTemplate || !('ContainerSpec' in target.TaskTemplate) || !target.TaskTemplate.ContainerSpec)throw new Error('Invalid ingress task.');
  target.Labels={...target.Labels,'panel.https':'servus-acme-v1',...(access==='external'?{'panel.https-access':'loopback-forwarder-v1'}:{})};
  target.TaskTemplate.Placement={...target.TaskTemplate.Placement,Constraints:[`node.id==${nodeId}`]};
  target.TaskTemplate.ContainerSpec.Args=[...args,'--entrypoints.websecure.address=:8443',`--certificatesresolvers.servus.acme.email=${options.email}`,'--certificatesresolvers.servus.acme.storage=/letsencrypt/acme.json','--certificatesresolvers.servus.acme.httpchallenge.entrypoint=web',...(options.staging?['--certificatesresolvers.servus.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory']:[])];
  // Swarm omits the false default on inspection; use its canonical form so
  // recovery can identify exactly the configuration that was applied.
  target.TaskTemplate.ContainerSpec.Mounts=[...mounts,{Type:'volume',Source:'servus-acme',Target:'/letsencrypt'}];
  target.EndpointSpec={...target.EndpointSpec,Ports:access==='external'?[...ports]:[...ports,{Protocol:'tcp',PublishedPort:443,TargetPort:8443,PublishMode:'host'}]};
  // Docker materializes this default in inspected specs; recording it keeps the
  // recovery comparison exact after a successful service update.
  target.UpdateConfig={...target.UpdateConfig,Order:'stop-first',FailureAction:'rollback',Parallelism:1,MaxFailureRatio:target.UpdateConfig?.MaxFailureRatio ?? 0};
  return target;
}
