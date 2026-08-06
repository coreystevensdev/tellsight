import { z } from 'zod';
import { PASSWORD_MIN_LENGTH } from '../constants/index.js';

export const roleSchema = z.enum(['owner', 'member']);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);

export const userSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
  name: z.string().min(1).max(255),
  googleId: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  isPlatformAdmin: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const orgSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255),
  createdAt: z.coerce.date(),
});

export const userOrgSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  orgId: z.number().int(),
  role: roleSchema,
  joinedAt: z.coerce.date(),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  googleId: z.string().min(1),
  avatarUrl: z.string().url().optional(),
});

export const createOrgSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
});

export const jwtPayloadSchema = z.object({
  sub: z.string(),
  org_id: z.number().int(),
  role: roleSchema,
  isAdmin: z.boolean(),
  iat: z.number(),
  exp: z.number(),
});

export const googleCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  inviteToken: z.string().min(1).optional(),
});

export const createInviteSchema = z.object({
  expiresInDays: z.number().int().min(1).max(30).optional(),
});

export const inviteTokenParamSchema = z.object({
  token: z.string().min(1),
});

export const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  password: passwordSchema,
  inviteToken: z.string().min(1).optional(),
});

export const passwordLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const loginResponseSchema = z.object({
  user: z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string().email(),
    avatarUrl: z.string().url().nullable(),
  }),
  org: z.object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
  }),
  isNewUser: z.boolean(),
});
