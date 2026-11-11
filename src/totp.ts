import type {Env} from './types.ts';
import {equals,now,sha} from './util.ts';

const BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function secretBytes(value: string): Uint8Array {
  const source=value.toUpperCase();
  if (!/^[A-Z2-7]{32,128}$/.test(source)) throw new Error('Invalid TOTP secret');
  const bytes:number[]=[];let buffer=0,bits=0;
  for(const char of source) {
    buffer=(buffer<<5)|BASE32.indexOf(char);
    bits+=5;
    if(bits>=8){bits-=8;bytes.push((buffer>>bits)&255);}
    buffer &= (1<<bits)-1;
  }
  if(bytes.length<20) throw new Error('TOTP secret too short');
  return new Uint8Array(bytes);
}

export async function totpAt(secret: string,counter: number): Promise<string> {
  if(!Number.isSafeInteger(counter)||counter<0) throw new Error('Invalid TOTP counter');
  const key=await crypto.subtle.importKey('raw',secretBytes(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const bytes=new Uint8Array(8);const view=new DataView(bytes.buffer);
  view.setUint32(0,Math.floor(counter/0x100000000));
  view.setUint32(4,counter>>>0);
  const hmac=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes));
  const offset=(hmac[hmac.length-1]??0)&15;
  const value=((((hmac[offset]??0)&127)<<24)|((hmac[offset+1]??0)<<16)|((hmac[offset+2]??0)<<8)|(hmac[offset+3]??0))>>>0;
  return String(value%1000000).padStart(6,'0');
}

// One-time use is global across admin login and OAuth consent.
export async function verifyTotp(env: Env,request: Request,code: string): Promise<boolean> {
  const ts=now();
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  const bucket=await sha('totp:'+ip+':'+Math.floor(ts/600));
  const attempts=await env.MCP_DB.prepare(
    'INSERT INTO rate_limits(bucket,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 RETURNING hits'
  ).bind(bucket,(Math.floor(ts/600)+2)*600).first();
  if (!attempts || attempts.hits>5 || !/^[0-9]{6}$/.test(code||'')) return false;
  if (!env.MCP_TOTP_SECRET) return false;
  const step=Math.floor(ts/30);
  for(const candidate of [step,step-1,step+1]) {
    if(candidate<0 || !(await equals(await totpAt(env.MCP_TOTP_SECRET,candidate),code))) continue;
    const consumed=await env.MCP_DB.prepare(
      'UPDATE admin_totp_state SET last_step=? WHERE id=1 AND last_step<? RETURNING last_step'
    ).bind(candidate,candidate).first();
    return Boolean(consumed);
  }
  return false;
}
