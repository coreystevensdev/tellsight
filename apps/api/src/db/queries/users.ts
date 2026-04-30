import { eq } from 'drizzle-orm';
import { db } from '../../lib/db.js';
import { users } from '../schema.js';

/** Cross-org lookup, users table has no org_id (intentional exception for auth flows) */
export async function findUserByEmail(email: string) {
  return db.query.users.findFirst({
    where: eq(users.email, email),
  });
}

/** Cross-org lookup, users table has no org_id (intentional exception for auth flows) */
export async function findUserByGoogleId(googleId: string) {
  return db.query.users.findFirst({
    where: eq(users.googleId, googleId),
  });
}

/** Cross-org lookup, users table has no org_id (intentional exception for auth flows) */
export async function findUserById(userId: number) {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
  });
}

export async function createUser(data: {
  email: string;
  name: string;
  googleId: string;
  avatarUrl?: string;
}) {
  const [user] = await db
    .insert(users)
    .values({
      email: data.email,
      name: data.name,
      googleId: data.googleId,
      avatarUrl: data.avatarUrl ?? null,
    })
    .returning();
  if (!user) throw new Error('Insert failed to return user');
  return user;
}

export async function updateUser(
  userId: number,
  data: Partial<{ name: string; avatarUrl: string }>,
) {
  const [user] = await db
    .update(users)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return user;
}
