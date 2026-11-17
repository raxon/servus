import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { Header, Pax, type ReadEntry } from 'tar';
import { inspectVolumeArchive, volumeManifestsMatch } from '../../src/agent/volume-archive.js';

function entry(path:string,body='',options:{type?:ReadEntry['type'];linkpath?:string;mode?:number}={}) {
  const data=Buffer.from(body),header=new Header({path,mode:options.mode??0o640,uid:1000,gid:1000,size:data.length,mtime:new Date('2026-11-17T01:00:00Z'),type:options.type??'File',linkpath:options.linkpath});header.encode();
  return Buffer.concat([header.block!,data,Buffer.alloc((512-data.length%512)%512)]);
}
const archive=(...entries:Buffer[])=>Buffer.concat([...entries,Buffer.alloc(1024)]);
it('checks file content, numeric ownership, modes, Unicode and confined symbolic links',async()=>{
  const data=archive(entry('./','',{type:'Directory',mode:0o750}),entry('./Zażółć.txt','hello'),entry('./link','',{type:'SymbolicLink',linkpath:'Zażółć.txt'}));
  const result=await inspectVolumeArchive(Readable.from([data.subarray(0,100),data.subarray(100)]));
  expect(result.entries.map(entry=>entry.path)).toEqual(['','link','Zażółć.txt']);expect(result.entries.find(entry=>entry.path==='Zażółć.txt')).toMatchObject({mode:0o640,uid:1000,gid:1000,size:5,sha256:'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'});
  expect(volumeManifestsMatch(result,result)).toBe(true);
});
it.each(['../escape','/absolute','a/../escape','a\\escape','C:/escape','a//b'])('rejects unsafe archive path %s',async path=>{
  await expect(inspectVolumeArchive(Readable.from([archive(entry(path,'data'))]))).rejects.toThrow();
});
it('rejects PAX path traversal and PAX link traversal before extraction',async()=>{
  await expect(inspectVolumeArchive(Readable.from([archive(new Pax({path:'../escape'}).encode(),entry('safe','data'))]))).rejects.toThrow();
  await expect(inspectVolumeArchive(Readable.from([archive(new Pax({linkpath:'../escape'}).encode(),entry('safe','',{type:'SymbolicLink',linkpath:'safe'}))]))).rejects.toThrow();
});
it.each(['../outside','/etc/passwd','a/../../outside','C:/outside'])('rejects escaping symbolic target %s',async linkpath=>{
  await expect(inspectVolumeArchive(Readable.from([archive(entry('link','',{type:'SymbolicLink',linkpath}))]))).rejects.toThrow();
});
it('rejects duplicate paths, Unicode-equivalent paths, hardlinks and special permission bits',async()=>{
  for(const data of [archive(entry('same','a'),entry('./same','b')),archive(entry('é','a'),entry('e\u0301','b')),archive(entry('hard','',{type:'Link',linkpath:'file'})),archive(entry('setuid','a',{mode:0o4755}))])await expect(inspectVolumeArchive(Readable.from([data]))).rejects.toThrow();
});
it('rejects writing entries through symbolic links regardless of entry order',async()=>{
  for(const data of [archive(entry('dir','',{type:'SymbolicLink',linkpath:'target'}),entry('dir/file','bad')),archive(entry('dir/file','bad'),entry('dir','',{type:'SymbolicLink',linkpath:'target'}))])await expect(inspectVolumeArchive(Readable.from([data]))).rejects.toThrow('symbolic link');
});
it('rejects compressed, truncated and empty archives',async()=>{
  const data=archive(entry('file','content'));
  for(const value of [gzipSync(data),data.subarray(0,600),Buffer.alloc(0),Buffer.alloc(1024)])await expect(inspectVolumeArchive(Readable.from([value]))).rejects.toThrow();
});
