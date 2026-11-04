// A CloudWatch metric filter watches for one exact log message. Rename that
// message in the application and the alarm goes quiet without going red: the
// code ships through deploy-aws on merge, the filter waits on a manual
// terraform apply. The digest alarm spent nine days matching "Digest worker job
// failed" after be4e7eb renamed it to "Digest worker job terminal failure".
//
// Reads `aws logs describe-metric-filters` JSON on stdin and asserts every
// message a deployed filter waits for is a message the code still logs,
// compared exactly rather than by substring: "Digest worker job failed" is a
// prefix of "Digest worker job failed, retry scheduled" and matching loosely
// would have called the broken filter healthy.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'apps/api/src';

function sources(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (e.endsWith('.ts') && !e.includes('.test.')) out.push(p);
  }
  return out;
}

// The Pino convention here is structured object first, message string second,
// so the message is the last string argument of the call.
const logged = new Set();
for (const file of sources(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/logger\.(?:info|warn|error|debug|fatal)\([\s\S]*?['"`]([^'"`]+)['"`],?\s*\)/g)) {
    logged.add(m[1]);
  }
}

const input = JSON.parse(readFileSync(0, 'utf8'));
const filters = input.metricFilters ?? [];
if (filters.length === 0) {
  console.error('No metric filters returned. Either none exist or the describe call failed.');
  process.exit(1);
}

let bad = 0;
for (const f of filters) {
  const wanted = [...(f.filterPattern ?? '').matchAll(/\$\.msg\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (wanted.length === 0) {
    console.log(`  ${f.filterName}: no $.msg literal, nothing to check`);
    continue;
  }
  for (const w of wanted) {
    if (logged.has(w)) {
      console.log(`  ok   ${f.filterName}: "${w}"`);
    } else {
      bad += 1;
      console.error(`  DRIFT ${f.filterName}: waits for "${w}", which nothing in ${SRC} logs.`);
    }
  }
}

console.log(`\n${logged.size} distinct log messages scanned, ${filters.length} filters checked.`);
if (bad > 0) {
  console.error(
    `\n${bad} filter message(s) no longer exist. Either the log message was renamed without\n` +
      `applying infra/terraform, or the filter pattern is wrong. Run terraform plan.`,
  );
  process.exit(1);
}
console.log('Every deployed filter matches a message the code still logs.');
