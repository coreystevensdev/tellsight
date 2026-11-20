import { readFileSync } from 'node:fs';

// Derive the deployment contract from the runtime guards without importing
// config.ts, which validates the process environment on import.
export function connectorEnvByGuard(): Map<string, string[]> {
  const config = readFileSync(new URL('../apps/api/src/config.ts', import.meta.url), 'utf8');
  const byGuard = new Map<string, string[]>();
  const guardPattern = /export function (is\w+Configured)\(cfg: Env\): boolean \{([\s\S]*?)\n\}/g;
  for (const match of config.matchAll(guardPattern)) {
    const vars = [...match[2]!.matchAll(/cfg\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
    byGuard.set(match[1]!, [...new Set(vars)]);
  }
  if (byGuard.size === 0 || [...byGuard.values()].some((vars) => vars.length === 0)) {
    throw new Error('Could not derive connector environment requirements from config.ts');
  }
  return byGuard;
}
