import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { validateHostApiOrigin, type HostDomainOptions } from './host-domain.js';

const settingsSchema=z.object({apiOrigin:z.string().max(2048).optional(),automatic:z.boolean().optional()}).strict();

function readManagedSettings():unknown {
  let fd:number;
  try {fd=openSync('/run/servus-lifecycle/host-domains.json',constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}
  try {
    const info=fstatSync(fd);
    if(!info.isFile() || info.uid!==0 || info.nlink!==1 || (info.mode&0o022)!==0 || info.size>4096)throw new Error('Host domain settings are not trusted.');
    return JSON.parse(readFileSync(fd,'utf8'));
  } finally {closeSync(fd);}
}

/** Keep the Compose contract compatible with the installed host validator. */
export function hostDomainOptions(env:NodeJS.ProcessEnv,managed:boolean,readSettings:()=>unknown=readManagedSettings):HostDomainOptions|undefined {
  const settings=settingsSchema.parse(managed?readSettings():{});
  const origin=env.PANEL_HOST_DOMAINS_API_URL??settings.apiOrigin??'https://api.servus.run';
  const automatic=env.PANEL_HOST_DOMAINS_AUTOMATIC;
  if(automatic!==undefined && !['true','false'].includes(automatic))throw new Error('Invalid automatic host domain setting.');
  return origin?{apiOrigin:validateHostApiOrigin(origin),automatic:automatic===undefined?(settings.automatic??(managed&&env.NODE_ENV==='production')):automatic==='true'}:undefined;
}
