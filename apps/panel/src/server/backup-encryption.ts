import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const magic=Buffer.from('SERVUS-BACKUP-1\n');
export const backupEncryptionOverhead=magic.length+12+16;

/** Authenticated envelope: version, random nonce, ciphertext, authentication tag. */
export function encryptDatabaseBackup(input:Readable,key:Buffer,id:string):Readable {
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(id,'ascii'));
  // Connecting with pipeline propagates failures and backpressure in both directions.
  void pipeline(input,cipher).catch(error=>cipher.destroy(error));
  return Readable.from((async function*(){
    yield Buffer.concat([magic,nonce]);
    for await(const chunk of cipher)yield chunk;
    yield cipher.getAuthTag();
  })());
}

/** Caller must stage the entire plaintext privately before exposing it to a client. */
export function decryptDatabaseBackup(input:Readable,key:Buffer,id:string):Readable {
  let pending=Buffer.alloc(0),decipher:DecipherGCM|undefined;
  const output=new Transform({transform(chunk:Buffer,_encoding,done){
    try {
      pending=Buffer.concat([pending,chunk]);
      if(!decipher){
        if(pending.length<magic.length+12)return done();
        if(!pending.subarray(0,magic.length).equals(magic))throw new Error('Invalid encrypted backup envelope.');
        decipher=createDecipheriv('aes-256-gcm',key,pending.subarray(magic.length,magic.length+12));
        decipher.setAAD(Buffer.from(id,'ascii'));pending=pending.subarray(magic.length+12);
      }
      if(pending.length>16){this.push(decipher.update(pending.subarray(0,-16)));pending=pending.subarray(-16);}
      done();
    }catch(error){done(error as Error);}
  },flush(done){
    try {
      if(!decipher||pending.length!==16)throw new Error('Incomplete encrypted backup.');
      decipher.setAuthTag(pending);this.push(decipher.final());done();
    }catch(error){done(error as Error);}
  }});
  void pipeline(input,output).catch(error=>output.destroy(error));
  return output;
}
