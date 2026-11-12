import type {Env} from './types.ts';
import {cookie,unb64u} from './util.ts';

interface AccessClaims { iss?: string; aud?: string|string[]; exp?: number; nbf?: number; sub?: string; email?: string; }
interface JwtHeader { alg?: string; kid?: string; }
type AccessJwk = JsonWebKey & { kid?: string };
interface JwkSet { keys?: AccessJwk[]; }
const cache = new Map<string,{expires:number;keys:AccessJwk[]}>();

function accessConfig(env: Env): {issuer:string;audiences:string[]} | null {
  const issuer=(env.MCP_ACCESS_ISSUER||'').replace(/\/$/,'');
  const audiences=(env.MCP_ACCESS_AUD||'').split(',').map(s=>s.trim()).filter(Boolean);
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || audiences.length===0 || audiences.some(s=>s.length>256)) return null;
  return {issuer,audiences};
}

async function loadKeys(issuer: string): Promise<AccessJwk[]> {
  const existing=cache.get(issuer);
  if (existing && existing.expires>Date.now()) return existing.keys;
  const response=await fetch(issuer+'/cdn-cgi/access/certs',{redirect:'error',signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error('Cloudflare Access certificates unavailable');
  const payload=await response.json() as JwkSet;
  if (!Array.isArray(payload.keys) || payload.keys.length===0 || payload.keys.length>30) throw new Error('Invalid Access certificates');
  const keys=payload.keys.filter(key=>key.kty==='RSA' && typeof key.kid==='string' && key.n && key.e);
  if (!keys.length) throw new Error('No valid Access signing key');
  cache.set(issuer,{expires:Date.now()+300000,keys});
  return keys;
}

// Fail closed if Access is missing or misconfigured. Never trust an unsigned assertion.
export async function accessIdentity(request: Request,env: Env): Promise<string|null> {
  try {
    const config=accessConfig(env);
    // Access normally injects the assertion header. For browser requests it
    // may instead forward the application-scoped CF_Authorization cookie.
    // Never fall back if a header is present but invalid: this prevents an
    // ambiguous/malformed assertion from being silently overridden.
    const assertion=request.headers.get('Cf-Access-Jwt-Assertion');
    const token=assertion!==null?assertion:cookie(request,'CF_Authorization');
    if (!config || !token || token.length>16000) return null;
    const parts=token.split('.');
    if (parts.length!==3 || parts.some(s=>!s)) return null;
    const header=JSON.parse(new TextDecoder().decode(unb64u(parts[0]!))) as JwtHeader;
    const claims=JSON.parse(new TextDecoder().decode(unb64u(parts[1]!))) as AccessClaims;
    const ts=Math.floor(Date.now()/1000);
    const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
    if (header.alg!=='RS256'||!header.kid||claims.iss!==config.issuer||!audiences.some(a=>typeof a==='string'&&config.audiences.includes(a)) ||
      typeof claims.exp!=='number'||!Number.isSafeInteger(claims.exp)||claims.exp<=ts|| (claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>ts)) ||
      typeof claims.sub!=='string'||claims.sub.length<1||claims.sub.length>256) return null;
    const keys=await loadKeys(config.issuer);
    const jwk=keys.find(k=>k.kid===header.kid);
    if (!jwk) return null;
    const publicKey=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const signature=unb64u(parts[2]!);
    const input=new TextEncoder().encode(parts[0]+'.'+parts[1]);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,signature,input)?claims.sub:null;
  } catch { return null; }
}
