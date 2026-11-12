// Independent multi-connection mark. It does not reproduce any GitHub logo.
export const BRAND_NAME = 'MCP Hub';
export const BRAND_SOURCE = 'Fongap Labs';
export const BRAND_VERSION = 'v0.1.0';
export const BRAND_NOTE = `${BRAND_SOURCE} · 通用 MCP 网关 · 模块化服务接入`;
export const BRAND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="MCP Hub independent mark">
  <rect width="64" height="64" rx="16" fill="#286F78"/>
  <path d="M20 20h24M20 44h24M20 20v24M44 20v24" stroke="#D6F2EE" stroke-width="3.2" stroke-linecap="round" opacity=".7"/>
  <path d="M20 20l24 24M44 20L20 44" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" opacity=".75"/>
  <circle cx="20" cy="20" r="6" fill="#FFFFFF"/>
  <circle cx="44" cy="20" r="6" fill="#FFFFFF"/>
  <circle cx="20" cy="44" r="6" fill="#FFFFFF"/>
  <circle cx="44" cy="44" r="6" fill="#FFFFFF"/>
  <circle cx="32" cy="32" r="5" fill="#C1E9DF" stroke="#286F78" stroke-width="2"/>
</svg>`;
export const BRAND_HEAD = '<link rel="icon" href="/brand/icon.svg" type="image/svg+xml">';
export const BRAND_HEADER = `<div class="brand"><div class="brand-icon" aria-hidden="true">${BRAND_ICON}</div><div><h1>${BRAND_NAME}</h1><p class="brand-subtitle">${BRAND_NOTE} <span class="version">${BRAND_VERSION}</span></p></div></div>`;
