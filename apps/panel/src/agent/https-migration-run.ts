import { DockerRuntime, INGRESS_SERVICE, OWNER } from './runtime.js';
import { planHttpsIngressMigration, supportsManagedHttps } from './https-routing.js';
import { localAgentImage, hostTcpPortAvailable } from './host-port-probe.js';
import { dockerIngressMigrationDriver } from './https-migration-docker.js';
import { applyHttpsMigration } from './https-migration.js';
import type { HttpsMigrationJournal } from './https-migration-journal.js';
import { ensureLocalTlsForwarder } from './https-local-forwarder.js';

/** Migrate only the stock owned ingress, on the local manager, with port 443 free. */
export async function migrateManagedHttps(runtime:DockerRuntime,journal:HttpsMigrationJournal,assertQuiescent:()=>void,probe={localAgentImage,hostTcpPortAvailable},access:'direct'|'external'='direct'):Promise<void> {
  const settings=runtime.vault.httpsIngress();
  if(!settings)throw new Error('Save the certificate contact settings first.');
  if(runtime.ingressPort!==80)throw new Error('Automatic HTTPS requires HTTP ingress on port 80.');
  const info=await runtime.docker.info(),node=info.Swarm?.NodeID;
  if(!info.Swarm?.ControlAvailable||!node||!/^[a-z0-9]{25}$/.test(node))throw new Error('Automatic HTTPS requires a local Swarm manager.');
  const driver=dockerIngressMigrationDriver(runtime.docker,INGRESS_SERVICE);
  const current=await driver.inspect();
  if(supportsManagedHttps(current.spec))throw new Error('Managed HTTPS ingress is already configured.');
  const network=await runtime.docker.getNetwork('panel-ingress').inspect(),networks=current.spec.TaskTemplate?.Networks??[];
  if(network.Labels?.['panel.owner']!==OWNER || network.Driver!=='overlay' || network.Attachable!==true || networks.length!==1 || networks[0]?.Target!==network.Id)throw new Error('The managed ingress network cannot be verified.');
  const target=planHttpsIngressMigration(current.spec,node,settings,access);
  await driver.waitHealthy(current.spec);
  const image=await probe.localAgentImage(runtime.docker);
  if(access==='direct' && !await probe.hostTcpPortAvailable(runtime.docker,image,443))throw new Error('Port 443 is already in use. It must be available before enabling automatic HTTPS.');
  let volume;
  try {volume=await runtime.docker.getVolume('servus-acme').inspect();}
  catch(error) {
    if((error as {statusCode?:number})?.statusCode!==404)throw error;
    await runtime.docker.createVolume({Name:'servus-acme',Labels:{'panel.owner':OWNER,'panel.purpose':'acme'}});
    volume=await runtime.docker.getVolume('servus-acme').inspect();
  }
  if(volume.Driver!=='local'||volume.Labels?.['panel.owner']!==OWNER||volume.Labels?.['panel.purpose']!=='acme')throw new Error('Certificate storage belongs to another installation or uses an unsupported driver.');
  assertQuiescent();
  if(access==='external')await ensureLocalTlsForwarder(runtime.docker,image);
  assertQuiescent();
  await applyHttpsMigration(journal,driver,current.spec,target,current.version);
}
