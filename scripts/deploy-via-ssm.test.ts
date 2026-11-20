import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectorEnvByGuard } from './connector-env.js';

const DEPLOY_SCRIPT = resolve(import.meta.dirname, 'deploy-via-ssm.py');

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  EC2_INSTANCE_ID: 'i-test123',
  HEAD_SHA: '0123456789abcdef0123456789abcdef01234567',
  PRODUCTION_DOMAIN: 'tellsight.example.com',
  DATABASE_URL: 'postgres://app:password@db.example.com/app',
  DATABASE_ADMIN_URL: 'postgres://admin:password@db.example.com/app',
  CLAUDE_API_KEY: 'claude-key',
  CLAUDE_MODEL: '',
  CLAUDE_MODEL_TOOLS: '',
  STRIPE_SECRET_KEY: 'stripe-key',
  STRIPE_WEBHOOK_SECRET: 'stripe-webhook-secret',
  STRIPE_PRICE_ID: 'price_123',
  STRIPE_TEST_MODE_IN_PRODUCTION: '',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  JWT_SECRET: 'jwt-secret',
  EMAIL_FROM_ADDRESS: 'hello@example.com',
  EMAIL_FROM_NAME: 'TellSight',
  EMAIL_MAILING_ADDRESS: '123 Main Street',
  RESEND_API_KEY: 'resend-key',
  RESEND_WEBHOOK_SECRET: 'resend-webhook-secret',
  METRICS_TOKEN: 'metrics-token',
  QUICKBOOKS_ENVIRONMENT: '',
  SQUARE_ENVIRONMENT: '',
  QUICKBOOKS_CLIENT_ID: '',
  QUICKBOOKS_CLIENT_SECRET: '',
  QUICKBOOKS_REDIRECT_URI: '',
  SHOPIFY_CLIENT_ID: '',
  SHOPIFY_CLIENT_SECRET: '',
  SHOPIFY_REDIRECT_URI: '',
  SQUARE_CLIENT_ID: '',
  SQUARE_CLIENT_SECRET: '',
  SQUARE_REDIRECT_URI: '',
  PLAID_ENVIRONMENT: '',
  PLAID_CLIENT_ID: '',
  PLAID_SECRET: '',
  ENCRYPTION_KEY: '',
  ECR_API_REPO: '123456789012.dkr.ecr.us-east-1.amazonaws.com/tellsight-api',
  ECR_WEB_REPO: '123456789012.dkr.ecr.us-east-1.amazonaws.com/tellsight-web',
};

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[][];
}

let sandbox = '';
let callLog = '';

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tellsight-deploy-test-'));
  callLog = join(sandbox, 'aws-calls.jsonl');

  const fakeAws = join(sandbox, 'aws');
  writeFileSync(
    fakeAws,
    `#!/usr/bin/env python3
import json, os, sys

args = sys.argv[1:]
with open(os.environ["AWS_CALL_LOG"], "a", encoding="utf8") as log:
    log.write(json.dumps(args) + "\\n")

if args[:2] == ["ssm", "send-command"]:
    if os.environ.get("AWS_SEND_FAIL") == "1":
        print("send failed", file=sys.stderr)
        sys.exit(2)
    print(json.dumps({"Command": {"CommandId": "cmd-test123"}}))
elif args[:2] == ["ssm", "get-command-invocation"]:
    status = os.environ.get("AWS_POLL_STATUS", "Success")
    print(json.dumps({
        "Status": status,
        "StandardOutputContent": "deployment landed",
        "StandardErrorContent": "remote deployment failed",
    }))
else:
    print("unexpected aws invocation", file=sys.stderr)
    sys.exit(3)
`,
  );
  chmodSync(fakeAws, 0o755);

  // deploy-via-ssm.py deliberately waits five seconds between SSM polls.
  // Python loads sitecustomize automatically, so this removes only that delay
  // in the isolated child without adding a production-only test switch.
  writeFileSync(
    join(sandbox, 'sitecustomize.py'),
    'import time\ntime.sleep = lambda _seconds: None\n',
  );
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runDeploy(overrides: NodeJS.ProcessEnv = {}): RunResult {
  writeFileSync(callLog, '');
  const env = {
    ...BASE_ENV,
    ...overrides,
    PATH: `${sandbox}:${BASE_ENV.PATH}`,
    PYTHONPATH: sandbox,
    AWS_CALL_LOG: callLog,
  };
  const result = spawnSync('python3', [DEPLOY_SCRIPT], { env, encoding: 'utf8' });
  const calls = existsSync(callLog)
    ? readFileSync(callLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function commandsFrom(calls: string[][]): string[] {
  const send = calls.find((call) => call[0] === 'ssm' && call[1] === 'send-command');
  expect(send).toBeDefined();
  const index = send!.indexOf('--parameters');
  expect(index).toBeGreaterThan(-1);
  return (JSON.parse(send![index + 1]!) as { commands: string[] }).commands;
}

function decodedWrite(commands: string[], target: string): string {
  const command = commands.find((candidate) => candidate.endsWith(`> ${target}`));
  expect(command).toBeDefined();
  const encoded = /^printf '%s' '([^']+)' \| base64 -d > /.exec(command!)?.[1];
  expect(encoded).toBeDefined();
  return Buffer.from(encoded!, 'base64').toString('utf8');
}

describe('production SSM deployment script', () => {
  // Execute the real allowlist and encoding; fakeAws captures the SSM payload.
  describe.each([...connectorEnvByGuard()])('%s environment delivery', (_guard, names) => {
    it('preserves every configured value in the submitted instance environment', () => {
      const values = Object.fromEntries(
        names.map((name) => [name, `test-${name} $literal; spaces & punctuation`]),
      );
      const result = runDeploy(values);
      expect(result.status, result.stderr).toBe(0);
      const lines = decodedWrite(commandsFrom(result.calls), '/opt/tellsight/.env').split('\n');
      for (const [name, value] of Object.entries(values)) {
        expect(lines.filter((line) => line.startsWith(`${name}=`))).toEqual([`${name}='${value}'`]);
      }
    });
    it.each(['absent', 'blank'])('omits %s settings from the instance environment', (kind) => {
      const values = Object.fromEntries(
        names.map((name) => [name, kind === 'blank' ? '' : undefined]),
      );
      const result = runDeploy(values);
      expect(result.status, result.stderr).toBe(0);
      const lines = decodedWrite(commandsFrom(result.calls), '/opt/tellsight/.env').split('\n');
      for (const name of names)
        expect(lines.some((line) => line.startsWith(`${name}=`))).toBe(false);
    });
  });
  it.each(['QUICKBOOKS_ENVIRONMENT', 'SQUARE_ENVIRONMENT', 'PLAID_ENVIRONMENT'])(
    'delivers the configured %s instead of its sandbox default',
    (name) => {
      const result = runDeploy({ [name]: 'production' });
      expect(result.status, result.stderr).toBe(0);
      const lines = decodedWrite(commandsFrom(result.calls), '/opt/tellsight/.env').split('\n');
      expect(lines.filter((line) => line.startsWith(`${name}=`))).toEqual([`${name}='production'`]);
    },
  );
  it('renders the production files and submits the guarded command sequence', () => {
    const result = runDeploy();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SSM command ID: cmd-test123');
    expect(result.stdout).toContain('Status: Success');
    expect(result.stdout).toContain('deployment landed');

    const commands = commandsFrom(result.calls);
    expect(commands[0]).toBe('set -e');
    expect(commands).toContain('docker image prune -af');
    expect(commands).toContain('cd /opt/tellsight && docker compose pull --quiet');
    expect(commands).toContain('docker compose up -d --remove-orphans');
    expect(commands.at(-1)).toBe(
      'docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile',
    );

    const envFile = decodedWrite(commands, '/opt/tellsight/.env');
    expect(envFile).toContain("BUILD_SHA='0123456'\n");
    expect(envFile).toContain("CLAUDE_MODEL='claude-sonnet-4-6'\n");
    expect(envFile).toContain("STRIPE_TEST_MODE_IN_PRODUCTION='false'\n");
    expect(envFile).toContain("QUICKBOOKS_ENVIRONMENT='sandbox'\n");
    expect(envFile).toContain("SQUARE_ENVIRONMENT='sandbox'\n");
    expect(envFile).toContain("PLAID_ENVIRONMENT='sandbox'\n");
    expect(envFile).not.toContain('QUICKBOOKS_CLIENT_ID=');
    expect(envFile).not.toContain('ENCRYPTION_KEY=');

    expect(decodedWrite(commands, '/opt/tellsight/docker-compose.override.yml')).toBe(
      'services:\n' +
        '  api:\n' +
        '    image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/tellsight-api:sha-0123456\n' +
        '  web:\n' +
        '    image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/tellsight-web:sha-0123456\n',
    );

    const caddyfile = decodedWrite(commands, '/opt/tellsight/Caddyfile');
    expect(caddyfile).toContain('request>uri regexp "[?].*" ""');
    expect(caddyfile).toContain('request>headers>Referer delete');
    expect(caddyfile).toContain('handle /webhooks/*');
    expect(caddyfile).toContain('handle /integrations/*');
    expect(caddyfile).toContain('@bearertoken path /invite/*');

    expect(commands.join('\n')).toContain('DISABLE_RATE_LIMIT=true');
    expect(commands.join('\n')).toContain('DISK_TOO_LOW:');
    expect(commands.join('\n')).toContain('DEPLOY DID NOT LAND: tellsight-$svc-1');

    expect(result.calls[1]).toContain('cmd-test123');
    expect(result.calls[1]).toContain('i-test123');
  });

  it('includes optional connector and model settings only when configured', () => {
    const result = runDeploy({
      CLAUDE_MODEL: 'claude-custom',
      CLAUDE_MODEL_TOOLS: 'claude-tools',
      QUICKBOOKS_CLIENT_ID: 'qb-client',
      QUICKBOOKS_CLIENT_SECRET: 'qb-secret',
      QUICKBOOKS_REDIRECT_URI: 'https://tellsight.example.com/integrations/quickbooks/callback',
      ENCRYPTION_KEY: 'a'.repeat(64),
    });

    expect(result.status).toBe(0);
    const envFile = decodedWrite(commandsFrom(result.calls), '/opt/tellsight/.env');
    expect(envFile).toContain("CLAUDE_MODEL='claude-custom'\n");
    expect(envFile).toContain("CLAUDE_MODEL_TOOLS='claude-tools'\n");
    expect(envFile).toContain("QUICKBOOKS_CLIENT_ID='qb-client'\n");
    expect(envFile).toContain("QUICKBOOKS_CLIENT_SECRET='qb-secret'\n");
    expect(envFile).toContain(`ENCRYPTION_KEY='${'a'.repeat(64)}'\n`);
  });

  // Shopify and Square shipped, deployed, and could never be turned on, because
  // their secrets were absent from this script until 2026-09-15: the keys had
  // nowhere to travel. Plaid was in exactly that state until this commit, so
  // this asserts the thing the deploy quietly got wrong twice before.
  it('carries the Plaid keys to the instance, which is the only path they have', () => {
    const result = runDeploy({
      PLAID_CLIENT_ID: 'plaid-client',
      PLAID_SECRET: 'plaid-secret',
      PLAID_ENVIRONMENT: 'production',
      ENCRYPTION_KEY: 'a'.repeat(64),
    });

    expect(result.status).toBe(0);
    const envFile = decodedWrite(commandsFrom(result.calls), '/opt/tellsight/.env');
    expect(envFile).toContain("PLAID_CLIENT_ID='plaid-client'\n");
    expect(envFile).toContain("PLAID_SECRET='plaid-secret'\n");
    expect(envFile).toContain("PLAID_ENVIRONMENT='production'\n");
  });

  // isPlaidConfigured gates the connector off when a key is missing, and
  // config.ts only skips validation when the key is absent entirely. A blank
  // line from an unset secret would fail z.string().min(1) and take the API
  // down rather than leaving the connector off.
  it('omits the Plaid keys entirely rather than writing blanks', () => {
    const result = runDeploy({});

    expect(result.status).toBe(0);
    const envFile = decodedWrite(commandsFrom(result.calls), '/opt/tellsight/.env');
    expect(envFile).not.toContain('PLAID_CLIENT_ID=');
    expect(envFile).not.toContain('PLAID_SECRET=');
  });

  it('refuses blank required values before contacting AWS', () => {
    const result = runDeploy({ METRICS_TOKEN: '' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'METRICS_TOKEN is empty. Set the repository secret; the deploy will not write a blank required value.',
    );
    expect(result.calls).toEqual([]);
  });

  it('refuses values that Docker Compose cannot represent safely', () => {
    const result = runDeploy({ EMAIL_FROM_NAME: "Tell'Sight" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'EMAIL_FROM_NAME contains a quote or newline, which docker compose cannot represent in an env_file',
    );
    expect(result.calls).toEqual([]);
  });

  it('surfaces local send failures and terminal remote failures', () => {
    const sendFailure = runDeploy({ AWS_SEND_FAIL: '1' });
    expect(sendFailure.status).toBe(1);
    expect(sendFailure.stderr).toContain('send failed');
    expect(sendFailure.calls).toHaveLength(1);

    const remoteFailure = runDeploy({ AWS_POLL_STATUS: 'Failed' });
    expect(remoteFailure.status).toBe(1);
    expect(remoteFailure.stderr).toContain('remote deployment failed');
    expect(remoteFailure.calls).toHaveLength(2);
  });
});
