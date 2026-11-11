#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// This wrapper deliberately requires the named secondary credentials and never
// falls back to a primary Cloudflare account, wrangler login, or a config file.
const account=process.env.CLOUDFLARE_ACCOUNT_ID_SECONDARY;
const token=process.env.CLOUDFLARE_API_TOKEN_SECONDARY;
if(!account||!token){
  const missing=[!account?'CLOUDFLARE_ACCOUNT_ID_SECONDARY':null,!token?'CLOUDFLARE_API_TOKEN_SECONDARY':null].filter(Boolean);
  console.error('Missing Cloudflare deployment environment variable(s): '+missing.join(', '));
  console.error('Set both variables in your local shell or trusted CI secret store. No fallback is permitted.');
  process.exit(2);
}
const arguments_=process.argv.slice(2);
if(!arguments_.length){
  console.error('Usage: node scripts/with-secondary-cloudflare.mjs <wrangler arguments>');
  process.exit(2);
}
const projectDir=fileURLToPath(new URL('../',import.meta.url));
const wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
if(!existsSync(wrangler)){
  console.error('Wrangler is not installed. Run npm install in the project directory.');
  process.exit(2);
}
const env={...process.env,CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token};
delete env.CLOUDFLARE_ACCOUNT_ID_SECONDARY;
delete env.CLOUDFLARE_API_TOKEN_SECONDARY;
// Avoid inheriting other Cloudflare API auth paths from the host environment.
delete env.CLOUDFLARE_API_KEY;
delete env.CLOUDFLARE_EMAIL;
// Worker runtime Secrets are managed in Cloudflare, not transferred by deployment.
// Prevent accidental inheritance or emission by Wrangler subcommands.
for (const name of ['MCP_ADMIN_KEY','MCP_APPROVAL_KEY','MCP_TOTP_SECRET','MCP_COOKIE_KEY','MCP_KEYRING_JSON','MCP_INGEST_JWK','MCP_RUNTIME_KEY']) delete env[name];
const result=spawnSync(process.execPath,[wrangler,...arguments_],{cwd:projectDir,env,stdio:'inherit',shell:false,windowsHide:true});
if(result.error){
  console.error('Wrangler failed to launch ('+result.error.code+'). No credentials printed.');
  process.exit(1);
}
process.exit(result.status??1);
