// Fails when a production dependency carries a high or critical advisory that
// nobody has looked at.
//
// The reason this is a script and not `pnpm audit --audit-level high` in a CI
// step: most of what an audit reports in a monorepo is not reachable from the
// deployed artifact, so a bare threshold goes red on noise, gets muted within a
// week, and then reports nothing forever. The list below is the difference. An
// advisory leaves this gate one of two ways, fixed or written down with a
// reason, and anything else fails the build.
//
// Fixing is the default and usually a pnpm override. body-parser, multer and
// dompurify were all closed that way on 2026-10-25. Acknowledge only when the
// fix does not exist yet or is genuinely not applicable, and say which.

import { execFileSync } from 'node:child_process';

type Advisory = {
  module_name: string;
  severity: string;
  title: string;
  patched_versions?: string;
  findings?: Array<{ paths?: string[] }>;
};

const BLOCKING = new Set(['high', 'critical']);

type Acknowledgement = {
  module: string;
  reviewed: string;
  reason: string;
  // What would make this stop being acceptable. An acknowledgement with no
  // revisit condition is just a permanent mute with extra steps.
  revisit: string;
};

const ACKNOWLEDGED: Acknowledgement[] = [
  {
    module: 'vite',
    reviewed: '2026-10-25',
    reason:
      'Not in the deployed artifact. `pnpm why vite` resolves it through vitest only, a devDependency, and the advisories are all Vite dev server issues (server.fs.deny bypass, arbitrary file read via the dev server). Nothing runs `vite dev` in this project; the web app builds with Next. An override to >=7.3.7 was tried and did not resolve, because vitest pins a narrower range.',
    revisit: 'vite becoming a real dependency of apps/web, or an advisory that is not dev-server-scoped.',
  },
  {
    module: 'zod',
    reviewed: '2026-10-25',
    reason:
      'The fix exists only in zod 4.6.6 and this repo is pinned to 3.x. That pin is a measured decision recorded in CLAUDE.md, not drift: moving to 4.x was tried on 2026-09-14 and produced 4 type errors and 2 test failures. The advisory is memory exhaustion while validating oversized input, which is a denial of service rather than a disclosure, and the reachable path is bounded by the body-parser size limit and the auth rate limiter in front of it.',
    revisit: 'the zod 4 migration landing, a 3.x backport being published, or any report of the API being OOM-killed.',
  },
];

function audit(): Advisory[] {
  let raw: string;
  try {
    raw = execFileSync('pnpm', ['audit', '--prod', '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // pnpm exits non-zero whenever it finds anything at all, so a non-zero exit
    // is the normal case here and the output is still on stdout.
    const out = (err as { stdout?: string }).stdout;
    if (!out) throw err;
    raw = out;
  }

  const parsed = JSON.parse(raw) as { advisories?: Record<string, Advisory> };
  return Object.values(parsed.advisories ?? {});
}

const blocking = audit().filter((a) => BLOCKING.has(a.severity));
const acknowledged = new Map(ACKNOWLEDGED.map((a) => [a.module, a]));

const unacknowledged = blocking.filter((a) => !acknowledged.has(a.module_name));
const covered = [...new Set(blocking.map((a) => a.module_name))].filter((m) => acknowledged.has(m));

for (const module of covered) {
  const ack = acknowledged.get(module)!;
  console.log(`OK (acknowledged ${ack.reviewed}): ${module}`);
}

// An acknowledgement for something the audit no longer reports is stale, and a
// stale entry is how a list like this stops describing reality.
const reported = new Set(blocking.map((a) => a.module_name));
const obsolete = ACKNOWLEDGED.filter((a) => !reported.has(a.module));
for (const ack of obsolete) {
  console.log(`STALE: ${ack.module} is acknowledged but no longer reported. Remove the entry.`);
}

if (unacknowledged.length > 0) {
  console.error(`\nFAIL: ${unacknowledged.length} unacknowledged high/critical advisories\n`);
  for (const a of unacknowledged) {
    const via = a.findings?.[0]?.paths?.[0] ?? 'unknown path';
    console.error(`  [${a.severity}] ${a.module_name}: ${a.title}`);
    console.error(`     patched in: ${a.patched_versions ?? 'unknown'}`);
    console.error(`     via: ${via}\n`);
  }
  console.error('Fix it with a pnpm override, or add an entry to ACKNOWLEDGED in this file');
  console.error('with a reason and a revisit condition.');
  process.exit(1);
}

console.log(`\nPASS: no unacknowledged high or critical advisories in production dependencies`);
