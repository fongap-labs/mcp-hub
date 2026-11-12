import type {Env} from './types.ts';

// MFA must be enforced by the Cloudflare Access application before this
// explicit rollout mode is selected. An invalid mode fails closed.
export function cloudflareMfaOnly(env: Pick<Env,'MCP_AUTH_MODE'>): boolean {
  const mode = env.MCP_AUTH_MODE || 'access-totp';
  if (mode !== 'access-totp' && mode !== 'cloudflare-mfa') {
    throw new Error('Invalid MCP_AUTH_MODE');
  }
  return mode === 'cloudflare-mfa';
}
