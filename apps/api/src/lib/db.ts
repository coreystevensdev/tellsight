import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config.js';
import * as schema from '../db/schema.js';

export const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
});

export const adminClient = postgres(env.DATABASE_ADMIN_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
});

export const db = drizzle(queryClient, { schema });
export const dbAdmin = drizzle(adminClient, { schema });

/** Transaction client type — use for query functions that optionally accept a tx */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
