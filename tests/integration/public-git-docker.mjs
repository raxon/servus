// Verify public Git DNS pinning and a real build in the deployed image.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSource } from '/app/dist/agent/build.js';
import { SecretVault } from '/app/dist/shared/secrets.js';

const root=process.env.SERVUS_FIXTURE_DIR;
if(!root||!/^\/tmp\/servus-public-git-[a-f0-9]{32}$/.test(root))throw new Error('A disposable fixture directory is required');
delete process.env.PANEL_GIT_HTTP_HOSTS;delete process.env.PANEL_GIT_TEST_CA;
const data=join(root,'data');mkdirSync(data,{mode:0o700});
const id=randomUUID(),operationId=randomUUID();
const service={id,projectId:randomUUID(),name:'fixture',image:'unused',hostname:'fixture.localhost',port:80,replicas:1,revision:1,deployedRevision:null,state:'pending',createdAt:'now',updatedAt:'now',lastError:null,
  source:{type:'git',repository:'https://github.com/docker-library/hello-world.git',branch:'master',context:'amd64',dockerfile:'Dockerfile'}};
const image=`panel-build:${operationId}`;
try {
  const result=await buildSource(service,operationId,data,'/var/run/docker.sock',new SecretVault(data));
  assert.equal(result.image,image);assert.match(result.sourceCommit,/^[a-f0-9]{40,64}$/);
  const inspect=JSON.parse(execFileSync('docker',['image','inspect',image],{encoding:'utf8'}))[0];
  assert.equal(inspect.Config.Labels['panel.source.commit'],result.sourceCommit);
  assert.equal(inspect.Config.Labels['panel.service'],id);
  console.log('PASS public GitHub clone with verified DNS and real Docker build');
} finally {
  let inspected;
  try {inspected=JSON.parse(execFileSync('docker',['image','inspect',image],{encoding:'utf8',stdio:['ignore','pipe','ignore']}))[0];}
  catch(error) {if(error.status!==1)throw error;}
  if(inspected){assert.equal(inspected.Config.Labels['panel.service'],id);execFileSync('docker',['image','rm',image],{stdio:'ignore'});}
}
