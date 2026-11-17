// Inspect the actual Pebble-issued certificate in the disposable HTTPS Swarm.
import Docker from 'dockerode';
import { strict as assert } from 'node:assert';
import { inspectManagedCertificate } from '../../apps/panel/src/agent/managed-certificate.js';
import { inspectAcmeFailure } from '../../apps/panel/src/agent/managed-certificate-events.js';
if(process.env.SERVUS_DISPOSABLE_HTTPS_TEST!=='1')throw new Error('Disposable test environment must be explicitly selected.');
const docker=new Docker({socketPath:process.env.HOME+'/.colima/servus-https-e2e/docker.sock'});
assert.equal((await docker.info()).Name,'colima-servus-https-e2e');
const image=(await docker.getImage('node:24-bookworm-slim').inspect()).Id,resolver=async()=>image;
const cert=await inspectManagedCertificate(docker,'servus-e2e.invalid',resolver);
assert.equal(cert.status,'active');
assert.deepEqual(await inspectManagedCertificate(docker,'other.invalid',resolver),{status:'not_found'});
assert.deepEqual(Object.keys(cert).sort(),['expiresAt','fingerprint','notBefore','status']);
const events=await inspectAcmeFailure(docker,'servus-e2e.invalid');
assert.equal(events.available,true);
if(events.failure)assert.deepEqual(Object.keys(events.failure).sort(),['category','observedAt','operation']);
assert.equal((await inspectAcmeFailure(docker,'other.invalid')).failure,undefined);
console.log('Managed certificate metadata returned without ACME account or private key.');
