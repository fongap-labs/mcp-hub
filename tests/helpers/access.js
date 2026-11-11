import {webcrypto} from 'node:crypto';
import {b64u} from '../../src/util.ts';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

export const accessIssuer='https://test-team.cloudflareaccess.com';
export const accessAud='test-audience';

export async function accessFixture() {
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);
  jwk.kid='test-signing-key';
  const encoded=value=>b64u(new TextEncoder().encode(JSON.stringify(value)));
  const head=encoded({alg:'RS256',kid:jwk.kid,typ:'JWT'});
  const payload=encoded({iss:accessIssuer,aud:[accessAud],sub:'admin-identity',email:'admin@example.test',exp:Math.floor(Date.now()/1000)+1800});
  const input=head+'.'+payload;
  const signature=b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input))));
  return {assertion:input+'.'+signature,jwks:{keys:[jwk]}};
}
