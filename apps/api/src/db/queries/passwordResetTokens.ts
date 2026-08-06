import { eq } from 'drizzle-orm';
import { db, type DbTransaction } from '../../lib/db.js';
import { passwordResetTokens } from '../schema.js';

export async function createToken(
  userId: number,
  tokenHash: string,
  expiresAt: Date,
  client: typeof db | DbTransaction = db,
) {
  const [token] = await client
    .insert(passwordResetTokens)
    .values({ userId, tokenHash, expiresAt })
    .returning();
  if (!token) throw new Error('Insert failed to return password reset token');
  return token;
}

export async function findByTokenHash(
  tokenHash: string,
  client: typeof db | DbTransaction = db,
) {
  return client.query.passwordResetTokens.findFirst({
    where: eq(passwordResetTokens.tokenHash, tokenHash),
  });
}

export async function markUsed(
  id: number,
  client: typeof db | DbTransaction = db,
) {
  const [token] = await client
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, id))
    .returning();
  return token;
}
