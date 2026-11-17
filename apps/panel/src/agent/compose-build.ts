import type Docker from 'dockerode';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {ComposeDefinition} from './compose-configuration.js';
import type {ComposeApplyRequest} from '../shared/compose.js';

export interface ComposeBuiltImage {id:string;tag:string;operationId:string;inputHash:string}
export type ComposeBuiltImages=Record<string,ComposeBuiltImage>;
export const composeBuildIds=(images:ComposeBuiltImages={})=>Object.fromEntries(Object.entries(images).map(([name,image])=>[name,image.id]));
type Run=(command:string,args:string[],cwd:string,operationId?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number)=>Promise<string>;

/** Resolve bounded paths before a CLI can read them. Symlinks are unsupported. */
export function composeBuildPath(root:string,base:string,value:string,kind:'file'|'directory'):string {
  const canonical=realpathSync(root),baseFromRoot=relative(resolve(root),resolve(base));
  // macOS aliases /var to /private/var. Rebase only the trusted root alias;
  // symlinks inside the checkout still remain visible to lstat below.
  const rebasedBase=baseFromRoot!=='..'&&!baseFromRoot.startsWith('..'+sep)&&!isAbsolute(baseFromRoot)?resolve(canonical,baseFromRoot):resolve(base);
  const path=resolve(rebasedBase,value),inside=relative(canonical,path);
  if(inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside)||inside.split(sep).includes('.git'))throw new Error('Compose build paths must remain inside the pinned checkout, outside .git.');
  let current=canonical;
  for(const part of inside.split(sep).filter(Boolean)){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('Compose build paths cannot contain symlinks.');}
  const stat=lstatSync(path);
  if(realpathSync(path)!==path||(kind==='file'?!stat.isFile():!stat.isDirectory()))throw new Error(`Compose build ${kind} cannot be verified.`);
  return path;
}

/** Copy only checkout files, never the agent cwd, Git metadata or linked targets. */
export function stageComposeBuildContext(source:string,destination:string) {
  let bytes=0,files=0;
  const copy=(from:string,to:string,depth:number)=>{
    if(depth>64||++files>20000)throw new Error('Compose build context exceeds its file or depth limit.');
    const stat=lstatSync(from);
    if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw new Error('Compose build contexts cannot contain symlinks or special files.');
    if(stat.isDirectory()) {mkdirSync(to,{recursive:true,mode:0o700});for(const name of readdirSync(from)){if(name!=='.git')copy(join(from,name),join(to,name),depth+1);}return;}
    bytes+=stat.size;if(bytes>128*1024*1024)throw new Error('Compose build context exceeds 128 MiB.');
    copyFileSync(from,to);
  };
  copy(source,destination,0);
}

function imageLabels(request:ComposeApplyRequest,name:string,image:Pick<ComposeBuiltImage,'operationId'|'inputHash'>) {
  return {'panel.owner':'self-hosted-panel','panel.compose-build':'true','panel.workload':request.workloadId,'panel.project':request.projectId,'panel.compose.service':name,'panel.operation':image.operationId,'panel.compose.build-input':image.inputHash};
}
async function inspectOwnedImage(docker:Docker,request:ComposeApplyRequest,name:string,image:ComposeBuiltImage) {
  if(!/^sha256:[a-f0-9]{64}$/.test(image.id)||image.tag!==`servus-compose-build:${image.operationId}-${name}`||!/^[a-f0-9]{64}$/.test(image.inputHash))throw new Error('The Compose build checkpoint is invalid.');
  const [byId,byTag]=await Promise.all([docker.getImage(image.id).inspect(),docker.getImage(image.tag).inspect()]);
  if(byId.Id!==image.id||byTag.Id!==image.id||Object.entries(imageLabels(request,name,image)).some(([key,value])=>byId.Config.Labels?.[key]!==value))throw new Error('The immutable Compose build image or its retained tag cannot be verified.');
}
export async function verifyComposeBuiltImages(docker:Docker,request:ComposeApplyRequest,definition:ComposeDefinition,images:ComposeBuiltImages={}) {
  for(const[name,item]of Object.entries(definition.services))if(item.build){const image=Object.hasOwn(images,name)?images[name]:undefined;if(!image)throw new Error('The Compose build image checkpoint is missing.');await inspectOwnedImage(docker,request,name,image);}
}

export async function buildComposeImages(options:{docker:Docker;request:ComposeApplyRequest;definition:ComposeDefinition;checkout?:string;commit?:string;directory:string;dockerSocket:string;images:ComposeBuiltImages;run:Run;checkpoint:()=>void;startedAt:string}):Promise<string> {
  const {request,definition,docker,images,run}=options;let logs='';
  const deadline=Date.parse(options.startedAt)+10*60_000;
  if(!Number.isFinite(deadline)||Date.parse(options.startedAt)>Date.now()+30_000)throw new Error('The Compose build deadline cannot be verified.');
  const privateConfig=join(options.directory,'build-docker-config');mkdirSync(privateConfig,{mode:0o700});
  writeFileSync(join(privateConfig,'config.json'),JSON.stringify({cliPluginsExtraDirs:['/usr/local/lib/docker/cli-plugins','/usr/libexec/docker/cli-plugins','/usr/lib/docker/cli-plugins','/opt/homebrew/lib/docker/cli-plugins']}),{mode:0o600});
  for(const[name,item]of Object.entries(definition.services)) {
    if(!item.build)continue;
    if(Object.hasOwn(images,name)){await inspectOwnedImage(docker,request,name,images[name]!);continue;}
    const build=typeof item.build==='string'?{context:item.build}:item.build;
    const inputHash=createHash('sha256').update(JSON.stringify({build,commit:options.commit??null,source:request.configuration.source})).digest('hex');
    const tag=`servus-compose-build:${request.operationId}-${name}`,identity={operationId:request.operationId,inputHash};
    try {
      const existing=await docker.getImage(tag).inspect(),checkpoint={id:existing.Id,tag,...identity};
      await inspectOwnedImage(docker,request,name,checkpoint);images[name]=checkpoint;options.checkpoint();continue;
    } catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error('Compose builds exceeded their 10 minute deadline.');
    const directory=join(options.directory,`build-${name}`),context=join(directory,'context');mkdirSync(directory,{mode:0o700});
    let contents:string,dockerfileIgnore:string|undefined;
    if(request.configuration.source.type==='git') {
      if(!options.checkout||!options.commit||!/^[a-f0-9]{40,64}$/.test(options.commit))throw new Error('A pinned Git checkout is required for Compose builds.');
      const base=dirname(composeBuildPath(options.checkout,options.checkout,request.configuration.source.path,'file'));
      const originalContext=composeBuildPath(options.checkout,base,build.context,'directory');
      if(build.dockerfile_inline)contents=build.dockerfile_inline;
      else {const file=composeBuildPath(options.checkout,originalContext,build.dockerfile??'Dockerfile','file');if(lstatSync(file).size>1024*1024)throw new Error('The Compose Dockerfile exceeds 1 MiB.');contents=readFileSync(file,'utf8');
        if(existsSync(file+'.dockerignore')){const ignore=composeBuildPath(options.checkout,originalContext,(build.dockerfile??'Dockerfile')+'.dockerignore','file');if(lstatSync(ignore).size>1024*1024)throw new Error('The Dockerfile ignore file exceeds 1 MiB.');dockerfileIgnore=readFileSync(ignore,'utf8');}}
      stageComposeBuildContext(originalContext,context);
    } else {
      if(!build.dockerfile_inline||!['.','./'].includes(build.context))throw new Error('Inline builds require dockerfile_inline with an empty context.');
      contents=build.dockerfile_inline;mkdirSync(context,{mode:0o700});
    }
    const file=join(directory,'Dockerfile');writeFileSync(file,contents,{mode:0o600});
    if(dockerfileIgnore!==undefined)writeFileSync(file+'.dockerignore',dockerfileIgnore,{mode:0o600});
    const args=['--host',`unix://${options.dockerSocket}`,'buildx','build','--builder','default','--load','--progress=plain','--file',file,'--tag',tag];
    for(const[key,value]of Object.entries(imageLabels(request,name,identity)))args.push('--label',`${key}=${value}`);
    if(options.commit)args.push('--label',`panel.source.commit=${options.commit}`);
    for(const[key,value]of Object.entries(build.args??{}))args.push('--build-arg',`${key}=${String(value)}`);
    if(build.target)args.push('--target',build.target);
    args.push(context);
    logs+=(await run('docker',args,directory,request.operationId,{DOCKER_CONFIG:privateConfig,DOCKER_BUILDKIT:'1'},Math.min(300_000,remaining))).slice(-16000);
    const resolved=await docker.getImage(tag).inspect(),checkpoint={id:resolved.Id,tag,...identity};
    await inspectOwnedImage(docker,request,name,checkpoint);images[name]=checkpoint;options.checkpoint();
  }
  return logs.slice(-16000);
}
