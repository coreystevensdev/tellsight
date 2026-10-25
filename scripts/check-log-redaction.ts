// Fails when a route carrying a secret in its path is not excluded from the
// Caddy access log.
//
// Access logging writes the request URI to CloudWatch. The query string is
// stripped wholesale by the filter in deploy-aws.yml, so a token in a query
// parameter is safe by construction. A token in the path is not: the only thing
// keeping it out of the log is the @bearertoken matcher, which is a hand
// written list of prefixes.
//
// That list was wrong the day it was written. It said /invites/* and /shares/*
// while the real routes are /invite/[token] and /share/[token], and it missed
// every /api/ variant, so it matched nothing it was meant to match. Nothing
// would have reported that, which is what this script is for.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(here, '../apps/web/app');
const WORKFLOW = join(here, '../.github/workflows/deploy-aws.yml');

// A directory named [token] means the segment is a bearer token in the URL.
// [id] is excluded: those are row ids, not secrets, and /api/proposals/[id]
// sits behind auth.
const SECRET_SEGMENT = '[token]';

function routesWithSecretSegment(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const route = `${prefix}/${entry}`;
    if (entry === SECRET_SEGMENT) {
      out.push(prefix);
      continue;
    }
    out.push(...routesWithSecretSegment(full, route));
  }
  return out;
}

function matcherPrefixes(): string[] {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const line = yaml.split('\n').find((l) => l.includes('@bearertoken path '));
  if (!line) throw new Error('no @bearertoken matcher in deploy-aws.yml');
  return line
    .slice(line.indexOf('@bearertoken path ') + '@bearertoken path '.length)
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/\*$/, ''));
}

const routes = routesWithSecretSegment(APP_DIR).sort();
const prefixes = matcherPrefixes();

const uncovered = routes.filter((r) => !prefixes.some((p) => `${r}/`.startsWith(p)));

for (const r of routes) {
  if (!uncovered.includes(r)) console.info(`OK: ${r}/[token] is skipped`);
}

if (uncovered.length > 0) {
  console.error(`\nFAIL: ${uncovered.length} route(s) put a token in the path and are logged\n`);
  for (const r of uncovered) console.error(`  ${r}/[token]`);
  console.error(`
Caddy writes the request path to CloudWatch, so these tokens are readable by
anyone with logs:FilterLogEvents. Add the prefix to the @bearertoken matcher in
.github/workflows/deploy-aws.yml, apply the Caddyfile to the instance, and
reload caddy.
`);
  process.exit(1);
}

console.info(`\nPASS: all ${routes.length} token-bearing routes are excluded from the access log`);
