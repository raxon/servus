import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';

/** Release prose is informational and never changes the updater's verified candidate. */
export function registerReleaseNotes(app:FastifyInstance,options:{administrator:(request:FastifyRequest)=>unknown;fetch?:typeof fetch}) {
  app.get<{Params:{tag:string}}>('/api/v1/updates/release-notes/:tag',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async request=>{
    options.administrator(request);
    const tag=z.string().max(64).regex(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/).parse(request.params.tag);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);timer.unref();
    try {
      const response=await (options.fetch??fetch)(`https://api.github.com/repos/raxon/servus/releases/tags/${tag}`,{redirect:'error',signal:controller.signal,headers:{Accept:'application/vnd.github+json','User-Agent':'Servus','X-GitHub-Api-Version':'2022-11-28'}});
      if(response.status===404){await response.body?.cancel();options.administrator(request);return {tag,notes:null};}
      if(!response.ok||!response.body){await response.body?.cancel();throw new Error();}
      const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
      try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw new Error();}chunks.push(value);}}
      finally {reader.releaseLock();}
      const release=z.object({tag_name:z.literal(tag),draft:z.literal(false),body:z.string().max(100_000).nullable()}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      options.administrator(request);
      return {tag,notes:release.body};
    } catch(error) {
      if(error instanceof AppError)throw error;
      throw new AppError('RELEASE_NOTES_UNAVAILABLE','Release notes could not be loaded. Try again or review the release on GitHub.',503);
    } finally {clearTimeout(timer);}
  });
}
