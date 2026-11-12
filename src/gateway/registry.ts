import type { Env } from '../types.ts';
import type { McpModule, McpServer } from './types.ts';
import { githubModule } from '../services/github/index.ts';

export type { McpEndpointDefinition, McpModule, McpServer, McpTool } from './types.ts';

/** Register each service module once; its own endpoint list preserves OAuth resource boundaries. */
export const MCP_MODULES: readonly McpModule[] = Object.freeze([githubModule]);

export function registerMcpModules(modules: readonly McpModule[]): readonly McpServer[] {
  const moduleIds = new Set<string>();
  const endpointIds = new Set<string>();
  const paths = new Set<string>();
  const resourcePaths = new Set<string>();
  const metadataPaths = new Set<string>();
  const servers: McpServer[] = [];

  for (const module of modules) {
    if (!module.id || moduleIds.has(module.id)) throw new Error(`Duplicate or empty MCP module id: ${module.id}`);
    if (!module.description.trim() || !module.instructions.trim() || module.endpoints.length === 0) throw new Error(`Incomplete MCP module declaration: ${module.id}`);
    moduleIds.add(module.id);
    for (const endpoint of module.endpoints) {
      if (!endpoint.id || endpointIds.has(endpoint.id)) throw new Error(`Duplicate or empty MCP endpoint id: ${endpoint.id}`);
      if (!endpoint.path.startsWith('/') || endpoint.path.includes('?') || endpoint.path.includes('#')) throw new Error(`Invalid MCP endpoint path: ${endpoint.path}`);
      if (endpoint.resourcePath !== '' && (!endpoint.resourcePath.startsWith('/') || endpoint.resourcePath.includes('?') || endpoint.resourcePath.includes('#'))) throw new Error(`Invalid MCP resource path: ${endpoint.resourcePath}`);
      if (!endpoint.metadataPath.startsWith('/.well-known/')) throw new Error(`Invalid MCP metadata path: ${endpoint.metadataPath}`);
      const expectedResourcePath = endpoint.path === '/' ? '' : endpoint.path;
      if (endpoint.resourcePath !== expectedResourcePath) throw new Error(`MCP endpoint and OAuth Resource paths must match: ${endpoint.path}`);
      const expectedMetadataPath = `/.well-known/oauth-protected-resource${endpoint.resourcePath}`;
      if (endpoint.metadataPath !== expectedMetadataPath) throw new Error(`MCP metadata path does not match its OAuth Resource: ${endpoint.metadataPath}`);
      if (paths.has(endpoint.path)) throw new Error(`Duplicate MCP endpoint path: ${endpoint.path}`);
      if (resourcePaths.has(endpoint.resourcePath)) throw new Error(`Duplicate MCP resource path: ${endpoint.resourcePath}`);
      if (metadataPaths.has(endpoint.metadataPath)) throw new Error(`Duplicate MCP metadata path: ${endpoint.metadataPath}`);
      endpointIds.add(endpoint.id);
      paths.add(endpoint.path);
      resourcePaths.add(endpoint.resourcePath);
      metadataPaths.add(endpoint.metadataPath);
      servers.push(Object.freeze({ ...endpoint, module }));
    }
  }
  return Object.freeze(servers);
}

export const MCP_SERVERS: readonly McpServer[] = registerMcpModules(MCP_MODULES);

export function moduleForId(id: string): McpModule | undefined {
  return MCP_MODULES.find(module => module.id === id);
}

// Route service administration ONLY under /admin/<service> for explicitly
// registered modules. No legacy /<service>/admin path or redirect is exposed.
// Public MCP /<service> endpoints and OAuth resources are unaffected.
export function moduleForAdminPath(path: string): McpModule | undefined {
  const match = /^\/admin\/([a-z][a-z0-9-]*)\/?$/.exec(path);
  return match ? moduleForId(match[1]!) : undefined;
}

export function baseOrigin(env: Env): string {
  const url = new URL(env.MCP_PUBLIC_URL);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('MCP_PUBLIC_URL must use HTTPS');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('MCP_PUBLIC_URL must be an origin without a path');
  }
  return url.origin;
}

export function resourceForServer(env: Env, server: McpServer): string {
  return baseOrigin(env) + server.resourcePath;
}

/** Stable client policy key for a tool owned by a registered MCP module. */
export function toolPolicyId(moduleId: string, toolName: string): string {
  return `${encodeURIComponent(moduleId)}:${encodeURIComponent(toolName)}`;
}

export function serverForPath(path: string): McpServer | undefined {
  return MCP_SERVERS.find(server => server.path === path);
}

export function serverForMetadata(path: string): McpServer | undefined {
  return MCP_SERVERS.find(server => server.metadataPath === path);
}

export function serverForResource(env: Env, resource: string | null): McpServer | undefined {
  if (!resource) return undefined;
  return MCP_SERVERS.find(server => resourceForServer(env, server) === resource);
}
