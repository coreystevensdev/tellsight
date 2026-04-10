import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_ADMIN_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CLAUDE_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-5-20250929'),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_ID: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  APP_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().default(3001),
});

export type Env = z.infer<typeof envSchema>;

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.format();
    const missing = Object.entries(formatted)
      .filter(([key]) => key !== '_errors')
      .map(([key, val]) => `  ${key}: ${(val as { _errors: string[] })._errors.join(', ')}`)
      .join('\n');
    throw new Error(`Missing or invalid environment variables:\n${missing}`);
  }
  return result.data;
}

export const env = loadConfig();
