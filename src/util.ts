/** Shared HTTP primitives: untrusted request input is returned as unknown. */
import { asObject, type DataObject } from './types.ts';

export const now = (): number => Math.floor(Date.now() / 1000);
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...extra }
  });
}
export function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {status, headers: {
    'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
    'X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra
  }});
}
const HTML_ESCAPES: Record<string, string> = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
export function escapeHtml(s: unknown): string { return String(s).replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c); }
export function b64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
export function unb64(s: unknown): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length > 16384 || s.length % 4 === 1) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
export function b64u(bytes: Uint8Array): string { return b64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
export function unb64u(s: unknown): Uint8Array<ArrayBuffer> { if(typeof s !== 'string' || !/^[\w-]+$/.test(s) || s.length > 16384) throw new Error('Invalid encoding'); return unb64(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)); }
export function randomId(): string { return b64u(crypto.getRandomValues(new Uint8Array(32))); }
export async function sha(s: string): Promise<string> { return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(s)))); }
export async function equals(a: unknown,b: unknown): Promise<boolean> {
  const [da,db] = await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(String(a))),crypto.subtle.digest('SHA-256',encoder.encode(String(b)))]);
  const x=new Uint8Array(da), y=new Uint8Array(db); let diff=0;
  for (let i=0;i<x.length;i++) diff|=(x[i] ?? 0)^(y[i] ?? 0); return diff===0;
}
export function cookie(request: Request, name: string): string {
  const raw=request.headers.get('Cookie')||'';
  for (const item of raw.split(';')) { const [k,...v]=item.trim().split('='); if(k===name) return v.join('='); }
  return '';
}
export function originOk(request: Request): boolean { const origin=request.headers.get('Origin'); return !!origin && origin===new URL(request.url).origin; }
export async function bodyJson(request: Request, max=16384): Promise<DataObject> {
  const len=Number(request.headers.get('Content-Length')||0);
  if (len>max) throw new Error('Body too large');
  const raw=await request.text(); if(encoder.encode(raw).byteLength>max) throw new Error('Body too large');
  return asObject(JSON.parse(raw) as unknown);
}
export async function form(request: Request,max=8192): Promise<URLSearchParams> {
  const raw=await request.text(); if(encoder.encode(raw).byteLength>max) throw new Error('Body too large');
  return new URLSearchParams(raw);
}
export const ownerPattern = /^(?!-)[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
export const repoPattern = /^[\w.-]{1,100}$/;
export function validOwner(s: unknown): s is string {return typeof s==='string'&&ownerPattern.test(s)&&s.length<=39;}
export function validRepo(s: unknown): s is string {return typeof s==='string'&&repoPattern.test(s)&&s!=='.'&&s!=='..';}
export function deny(status=403): Response { return json({error: status===401?'Unauthorized':'Forbidden'},status); }
