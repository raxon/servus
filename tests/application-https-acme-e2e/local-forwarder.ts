// Exercises the loopback relay only on the disposable HTTPS test Swarm.
import Docker from 'dockerode';
import { strict as assert } from 'node:assert';
import { ensureLocalTlsForwarder, verifyLocalTlsForwarder, LOCAL_TLS_FORWARDER } from '../../apps/panel/src/agent/https-local-forwarder.js';
if(process.env.SERVUS_DISPOSABLE_HTTPS_TEST!=='1')throw new Error('Disposable test environment must be explicitly selected.');
const docker=new Docker({socketPath:process.env.HOME+'/.colima/servus-https-e2e/docker.sock'});
assert.equal((await docker.info()).Name,'colima-servus-https-e2e');
assert.equal((await docker.listContainers({all:true,filters:{name:[`^/${LOCAL_TLS_FORWARDER}$`]}})).length,0);
const network=await docker.getNetwork('panel-ingress').inspect();
assert.equal(network.Labels?.['panel.owner'],'self-hosted-panel');
const image=(await docker.getImage('node:24-bookworm-slim').inspect()).Id;
let forwarder:Docker.Container|undefined,probe:Docker.Container|undefined;
try {
  await ensureLocalTlsForwarder(docker,image);
  forwarder=docker.getContainer(LOCAL_TLS_FORWARDER);
  assert.equal(await verifyLocalTlsForwarder(forwarder,network.Id,image),true);
  await forwarder.stop();
  await ensureLocalTlsForwarder(docker,image);
  assert.equal(await verifyLocalTlsForwarder(forwarder,network.Id,image),true);
  const script="const h=require('node:https');const r=h.get({host:'127.0.0.1',port:18443,servername:'servus-e2e.invalid',headers:{Host:'servus-e2e.invalid'},rejectUnauthorized:false},s=>{const c=s.socket.getPeerCertificate();console.log(JSON.stringify({status:s.statusCode,san:c.subjectaltname}));s.resume();s.on('end',()=>process.exit(s.statusCode===200&&c.subjectaltname?.split(', ').includes('DNS:servus-e2e.invalid')?0:1));});r.on('error',e=>{console.error(e.message);process.exit(1)});r.setTimeout(5000,()=>r.destroy())";
  probe=await docker.createContainer({Image:image,Entrypoint:['node'],Cmd:['-e',script],HostConfig:{NetworkMode:'host'}});
  await probe.start();
  const status=(await probe.wait()).StatusCode;
  if(status!==0)console.error((await probe.logs({stdout:true,stderr:true})).toString());
  assert.equal(status,0,'HTTPS request through the relay must reach the intended application certificate and service');
  console.log('Loopback TLS relay forwarded the expected certificate and HTTP response.');
} finally {
  if(probe)await probe.remove({force:true});
  if(forwarder)await forwarder.remove({force:true});
}
