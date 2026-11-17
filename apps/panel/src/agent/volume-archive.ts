import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import { Parser } from 'tar';

export interface VolumeArchiveEntry {path:string;type:'File'|'Directory'|'SymbolicLink';size:number;mode:number;uid:number;gid:number;mtime:number;sha256:string|null;linkpath:string|null}
export interface VolumeArchiveManifest {version:1;entries:VolumeArchiveEntry[]}

function safePath(value:string):string {
  if(value.length>4096||/[\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||/^[a-z]:/i.test(value))throw new Error('The volume archive contains an unsafe path.');
  const path=value.replace(/^(?:\.\/)+/,'').replace(/\/+$/,'');
  if(path==='.'||path==='')return '';
  const parts=path.split('/');
  if(parts.length>64||parts.some(part=>!part||part==='.'||part==='..'))throw new Error('The volume archive contains an unsafe path.');
  return path;
}

/** Validate before extracting into a fresh volume. Parent-relative links are unsupported. */
export async function inspectVolumeArchive(input:Readable):Promise<VolumeArchiveManifest> {
  const entries:VolumeArchiveEntry[]=[],seen=new Set<string>();let total=0,raw=0,first=Buffer.alloc(0);
  const parser=new Parser({strict:true,maxMetaEntrySize:16*1024,noResume:true,onReadEntry(entry){
    try {
      if(!['File','Directory','SymbolicLink'].includes(entry.type)||entry.invalid||entry.unsupported)throw new Error('Volume archives support regular files, directories and confined relative symbolic links only.');
      const path=safePath(entry.path),canonical=path.normalize('NFC');
      if(!path&&entry.type!=='Directory'||seen.has(canonical)||entries.length>=50_000)throw new Error('The volume archive contains duplicate paths or too many entries.');
      seen.add(canonical);
      if(!Number.isSafeInteger(entry.size)||entry.size<0||(total+=entry.size)>2*1024*1024*1024||!Number.isInteger(entry.mode)||entry.mode!&~0o1777)throw new Error('The volume archive contains unsupported size or permissions.');
      if(!Number.isSafeInteger(entry.uid)||!Number.isSafeInteger(entry.gid)||entry.uid!<0||entry.gid!<0||entry.uid!>0x7fffffff||entry.gid!>0x7fffffff)throw new Error('The volume archive contains unsupported ownership.');
      const linkpath=entry.type==='SymbolicLink'?entry.linkpath??'':null;
      if(linkpath!==null&&(!linkpath||linkpath.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(linkpath)||linkpath.split('/').some(part=>part==='..')||/^[a-z]:/i.test(linkpath)))throw new Error('Symbolic links must use relative targets without parent traversal.');
      const item:VolumeArchiveEntry={path,type:entry.type as VolumeArchiveEntry['type'],size:entry.size,mode:entry.mode!,uid:entry.uid!,gid:entry.gid!,mtime:Math.floor((entry.mtime?.getTime()??0)/1000),sha256:null,linkpath};
      const hash=createHash('sha256');entry.on('data',(chunk:Buffer)=>hash.update(chunk));entry.on('end',()=>{if(item.type==='File')item.sha256=hash.digest('hex');});entries.push(item);entry.resume();
    } catch(error) {parser.abort(error as Error);}
  }});
  try {
    await new Promise<void>((resolve,reject)=>{
      parser.once('error',reject);parser.once('end',resolve);input.once('error',error=>parser.abort(error));
      input.on('data',(chunk:Buffer)=>{
        raw+=chunk.length;
        if(raw>2*1024*1024*1024){input.pause();parser.abort(new Error('Volume archive exceeds 2 GiB.'));return;}
        if(first.length<4){first=Buffer.concat([first,chunk.subarray(0,4-first.length)]);if(first[0]===0x1f&&first[1]===0x8b){input.pause();parser.abort(new Error('Compressed volume archives are unsupported.'));return;}}
        if(!parser.write(chunk))input.pause();
      });parser.on('drain',()=>input.resume());input.once('end',()=>parser.end());
    });
    const links=new Set(entries.filter(entry=>entry.type==='SymbolicLink').map(entry=>entry.path.normalize('NFC')));
    for(const entry of entries) {
      let parent=posix.dirname(entry.path);
      while(parent!=='.'&&parent!=='/') {if(links.has(parent.normalize('NFC')))throw new Error('Archive entries cannot be written through a symbolic link.');parent=posix.dirname(parent);}
    }
    if(!entries.length)throw new Error('The volume archive has no directory or file entries.');
    return {version:1,entries:entries.sort((a,b)=>a.path.localeCompare(b.path,'en'))};
  } finally {input.destroy();}
}

export function volumeManifestsMatch(expected:VolumeArchiveManifest,actual:VolumeArchiveManifest):boolean {
  // Alpine tar restores regular-file times; directory/link times are not portable.
  const normalize=(manifest:VolumeArchiveManifest)=>manifest.entries.map(entry=>entry.type==='File'?entry:{...entry,mtime:0});
  return JSON.stringify(normalize(expected))===JSON.stringify(normalize(actual));
}
