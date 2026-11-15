import { createHash, KeyObject } from 'node:crypto';

/** Invalid inputs never include key material or upstream values in errors. */
export class AcmeInputError extends Error {
  constructor() { super('Invalid ACME challenge or account public key.'); this.name='AcmeInputError'; }
}

const base64url = /^[A-Za-z0-9_-]+$/;
function canonical(value: unknown): value is string {
  return typeof value==='string' && value.length>0 && base64url.test(value) && Buffer.from(value,'base64url').toString('base64url')===value;
}

/** RFC 7638 SHA-256 thumbprint using required public JWK members only. */
export function accountKeyThumbprint(key: KeyObject): string {
  if (!(key instanceof KeyObject) || key.type!=='public') throw new AcmeInputError();
  try {
    const jwk=key.export({format:'jwk'});
    let required:Record<string,string>;
    if (key.asymmetricKeyType==='rsa' && jwk.kty==='RSA' && canonical(jwk.e) && canonical(jwk.n) && (key.asymmetricKeyDetails?.modulusLength ?? 0)>=2048) {
      required={e:jwk.e,kty:'RSA',n:jwk.n};
    } else if (key.asymmetricKeyType==='ec' && jwk.kty==='EC' && (jwk.crv==='P-256'||jwk.crv==='P-384') && canonical(jwk.x) && canonical(jwk.y)) {
      const coordinateSize=jwk.crv==='P-256'?32:48;
      if(Buffer.from(jwk.x,'base64url').length!==coordinateSize || Buffer.from(jwk.y,'base64url').length!==coordinateSize)throw new Error();
      required={crv:jwk.crv,kty:'EC',x:jwk.x,y:jwk.y};
    } else throw new Error();
    return createHash('sha256').update(JSON.stringify(required),'utf8').digest('base64url');
  } catch { throw new AcmeInputError(); }
}

/** RFC 8555 DNS-01 value. This does not request or validate a certificate. */
export function dns01Value(token: string, accountPublicKey: KeyObject): string {
  if (!canonical(token) || token.length>128 || Buffer.from(token,'base64url').length<16) throw new AcmeInputError();
  const authorization=`${token}.${accountKeyThumbprint(accountPublicKey)}`;
  return createHash('sha256').update(authorization,'ascii').digest('base64url');
}
