import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Four numbers the README stated from memory, each owned by a file that can be
// read. They had all drifted: five k6 thresholds against three declared, an
// error rate of 0.5% against rate<0.01, thirteen named gaps against fourteen
// bullets, circuit_breaker_state against a gauge called circuit_breaker_open,
// and 99% availability against docs/slo.md's 99.5%.
//
// Same shape as the readme-*-sync guards beside this file: find the claim, find
// the owner, assert they agree, and fail loudly if the claim moved so a reword
// cannot silently skip the check.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8');

describe('README claims that a file owns', () => {
  const readme = read('README.md');

  it('k6 threshold count matches what the script declares', () => {
    const script = read('k6', 'load-test.js');
    const block = script.match(/thresholds:\s*\{([\s\S]*?)^\s{0,4}\},/m)?.[1];
    expect(block, 'no thresholds block in k6/load-test.js; update this matcher').toBeDefined();

    const declared = [...(block ?? '').matchAll(/^\s*([a-z_]+):\s*\[/gm)].map((m) => m[1]);
    const claimed = readme.match(/enforces (\w+) thresholds/)?.[1];
    expect(claimed, 'README no longer states a k6 threshold count').toBeDefined();

    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    expect(
      words[claimed ?? ''],
      `README says "${claimed}" thresholds; load-test.js declares ${declared.length} (${declared.join(', ')})`,
    ).toBe(declared.length);
  });

  it('k6 error-rate claim matches the declared rate', () => {
    const script = read('k6', 'load-test.js');
    const rate = script.match(/http_req_failed:\s*\['rate<([\d.]+)'\]/)?.[1];
    expect(rate, 'http_req_failed threshold not found in load-test.js').toBeDefined();

    const stated = readme.match(/error rate < ([\d.]+)%/)?.[1];
    expect(stated, 'README no longer states an error rate').toBeDefined();
    expect(
      Number(stated),
      `README says ${stated}%, load-test.js enforces rate<${rate} which is ${Number(rate) * 100}%`,
    ).toBe(Number(rate) * 100);
  });

  it('named-gap count matches the Known Limitations bullets', () => {
    const section = readme.split(/^## Known limitations/im)[1];
    expect(section, 'no Known limitations section found').toBeDefined();
    const bullets = ((section ?? '').split(/^## /m)[0] ?? '').match(/^- \*\*/gm)?.length ?? 0;

    const words: Record<string, number> = {
      ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    };
    const claimed = readme.match(/is (\w+) named gaps/)?.[1];
    expect(claimed, 'README no longer states a named-gap count').toBeDefined();
    expect(words[claimed ?? ''], `README says "${claimed}", section has ${bullets} bullets`).toBe(bullets);
  });

  it('circuit breaker gauge is named as the code registers it', () => {
    const metrics = read('apps', 'api', 'src', 'lib', 'metrics.ts');
    const registered = metrics.match(/name:\s*'(circuit_breaker_\w+)'/)?.[1];
    expect(registered, 'no circuit_breaker gauge found in metrics.ts').toBeDefined();
    expect(
      readme.includes(registered ?? ''),
      `README does not mention ${registered}, the name metrics.ts registers`,
    ).toBe(true);
  });

  it('availability target matches docs/slo.md', () => {
    const slo = read('docs', 'slo.md');
    const owned = slo.match(/API availability\s*\|\s*([\d.]+)%/)?.[1];
    expect(owned, 'no API availability row in docs/slo.md').toBeDefined();

    const stated = readme.match(/([\d.]+)% monthly availability/)?.[1];
    expect(stated, 'README no longer states a monthly availability target').toBeDefined();
    expect(stated, `README says ${stated}%, docs/slo.md says ${owned}%`).toBe(owned);
  });
});
