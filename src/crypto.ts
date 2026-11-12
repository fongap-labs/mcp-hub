import {b64,unb64,encoder,decoder} from './util.ts';
import {asObject, type Env, type DbRow} from './types.ts';

// Browser RSA ingestion and D1 encryption use independent keys.
async function aesKey(env: Env,keyId: string,usage: KeyUsage): Promise<CryptoKey> {
  const ring=asObject(JSON.parse(env.MCP_KEYRING_JSON) as unknown);
  if(!Object.hasOwn(ring,keyId)) throw new Error('Encryption key unavailable');
  const raw=unb64(ring[keyId]); if(raw.byteLength!==32) throw new Error('Invalid key length');
  return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,[usage]);
}
export async function seal(env: Env, owner: string, token: string): Promise<{key_id:string;iv:string;ciphertext:string}> {
  const keyId=env.MCP_ACTIVE_ID; if(!/^[\w-]{1,32}$/.test(keyId||'')) throw new Error('Invalid active key id');
  const key=await aesKey(env,keyId,'encrypt'); const iv=crypto.getRandomValues(new Uint8Array(12));
  const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('github-owner:'+owner.toLowerCase())},key,encoder.encode(token));
  return {key_id:keyId,iv:b64(iv),ciphertext:b64(new Uint8Array(bytes))};
}
export async function unseal(env: Env, row: Pick<DbRow,'key_id'|'iv'|'ciphertext'|'owner'>): Promise<string> {
  const key=await aesKey(env,row.key_id,'decrypt');
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(row.iv),additionalData:encoder.encode('github-owner:'+row.owner.toLowerCase())},key,unb64(row.ciphertext));
  return decoder.decode(bytes);
}
interface IngestJwk extends JsonWebKey { kty: string; n: string; e: string; d: string; alg?: string }
export function ingestionPublicJwk(env: Env): JsonWebKey {
  const key=asObject(JSON.parse(env.MCP_INGEST_JWK) as unknown);
  if(key.kty!=='RSA'||key.alg && key.alg!=='RSA-OAEP-256'||!key.n||!key.e||!key.d) throw new Error('Invalid ingestion key');
  return {kty:'RSA',n:String(key.n),e:String(key.e),alg:'RSA-OAEP-256',ext:true,key_ops:['encrypt']};
}
/** Validate the original RSA ingestion private JWK and its derived public key
 * without decrypting tokens or exposing private key data. */
export async function verifiedIngestionPublicJwk(env: Env): Promise<JsonWebKey> {
  const publicJwk=ingestionPublicJwk(env);
  const privateJwk=JSON.parse(env.MCP_INGEST_JWK) as JsonWebKey;
  await crypto.subtle.importKey('jwk',privateJwk,
    {name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
  await crypto.subtle.importKey('jwk',publicJwk,
    {name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  return publicJwk;
}

/** GitHub account creation needs both the *existing* RSA ingestion key and
 * an importable AES-GCM keyring entry for its active ID. Deploy health must
 * fail closed when either secret is missing or malformed. */
export async function runtimeCryptoReady(env: Env): Promise<boolean> {
  try {
    if (!env.MCP_ACTIVE_ID || !/^[A-Za-z0-9_-]{1,32}$/.test(env.MCP_ACTIVE_ID)) return false;
    await aesKey(env,env.MCP_ACTIVE_ID,'encrypt');
    await verifiedIngestionPublicJwk(env);
    return true;
  } catch { return false; }
}

export async function decryptIngested(env: Env, payload: unknown): Promise<string> {
  const data=asObject(payload);
  const {wrappedKey,iv,ciphertext}=data;
  if(typeof wrappedKey!=='string'||typeof iv!=='string'||typeof ciphertext!=='string') throw new Error('Invalid encrypted payload');
  if(wrappedKey.length>2048 || ciphertext.length>8192) throw new Error('Encrypted token too large');
  const privateJwk=JSON.parse(env.MCP_INGEST_JWK) as JsonWebKey;
  const priv=await crypto.subtle.importKey('jwk',privateJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
  const raw=await crypto.subtle.decrypt({name:'RSA-OAEP'},priv,unb64(wrappedKey));
  if(raw.byteLength!==32) throw new Error('Invalid wrapped key');
  const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
  const nonce=unb64(iv); if(nonce.byteLength!==12) throw new Error('Invalid IV');
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},key,unb64(ciphertext));
  const token=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!token || token.length>4096 || /[\r\n\0\t ]/.test(token)) throw new Error('Invalid token format');
  return token;
}
