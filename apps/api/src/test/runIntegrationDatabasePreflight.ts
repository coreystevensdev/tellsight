import { checkIntegrationDatabase } from './integrationDatabasePreflight.js';

try {
  await checkIntegrationDatabase();
  console.log('Integration database preflight passed');
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`Integration database preflight failed: ${message}`);
  process.exitCode = 1;
}
