#!/usr/bin/env node
// Sums executed tests across vitest JSON reports, or a Playwright one with --playwright.
//
// This replaced `vitest list`, which stopped being a usable count under vitest 5:
// it lists an it.each as its unexpanded "%s" template rather than once per case,
// which cut the collected total by 487 while the same tests still ran.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const playwright = args[0] === '--playwright';
const files = playwright ? args.slice(1) : args;

if (files.length === 0) {
  console.error('usage: count-from-reports.mjs [--playwright] <report.json>...');
  process.exit(1);
}

let total = 0;
for (const file of files) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const n = playwright
    ? ['expected', 'unexpected', 'flaky', 'skipped'].reduce((sum, k) => sum + (report.stats?.[k] ?? 0), 0)
    : report.numTotalTests;

  // A report that parses but carries no count would silently contribute 0 and
  // shrink the badge, which is the same failure the old collection guard caught.
  if (typeof n !== 'number' || Number.isNaN(n)) {
    console.error(`${file}: no test count in report`);
    process.exit(1);
  }
  if (n === 0) {
    console.error(`${file}: reported 0 tests, which means the run did not happen`);
    process.exit(1);
  }
  total += n;
}
console.log(total);
