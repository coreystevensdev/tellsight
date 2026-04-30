const DEFAULT_JWT_SECRET = 'ci-test-secret-that-is-at-least-32-chars-long-for-validation';
const DEFAULT_ADMIN_URL = 'postgresql://app_admin:app@localhost:5432/analytics';

export const JWT_SECRET = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;

const resolvedAdminUrl = process.env.DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;

if (!resolvedAdminUrl.includes('localhost') && !resolvedAdminUrl.includes('127.0.0.1') && !resolvedAdminUrl.includes('db:')) {
  throw new Error(
    `DATABASE_ADMIN_URL points to "${resolvedAdminUrl}", E2E fixtures refuse to run against non-local databases. ` +
    'Set DATABASE_ADMIN_URL to a localhost or docker-compose URL.',
  );
}

export const DATABASE_ADMIN_URL = resolvedAdminUrl;
