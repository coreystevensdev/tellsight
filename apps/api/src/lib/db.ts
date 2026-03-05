import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config.js';
import * as schema from '../db/schema.js';

const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {}, // pg spams NOTICE on migrations, not useful
});

export const db = drizzle(queryClient, { schema });

/** Transaction client type — use for query functions that optionally accept a tx */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
