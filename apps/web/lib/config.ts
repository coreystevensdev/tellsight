import { z } from 'zod';

const envSchema = z.object({
  API_INTERNAL_URL: z.string().url().default('http://api:3001'),
  JWT_SECRET: z.string().min(32).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // deploy-aws.yml writes one .env that both containers load, so the web server
  // reads the same value the API validates. Server-side only: the billing page
  // is a server component and passes the boolean down.
  STRIPE_TEST_MODE_IN_PRODUCTION: z.enum(['true', 'false']).default('false'),
});

export const webEnv = envSchema.parse({
  API_INTERNAL_URL: process.env.API_INTERNAL_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV,
  STRIPE_TEST_MODE_IN_PRODUCTION: process.env.STRIPE_TEST_MODE_IN_PRODUCTION,
});
