// Standalone seed script, runs after migrations, before the Express app boots.
// Same exceptions as migrate.ts:
//   - process.env: config.ts validates ALL env vars. Seed runs before app context exists.
//   - console.log: Pino is app-level. Seed output uses console.
//   - Raw Drizzle calls: query functions import lib/db.ts → config.ts → crash.
//     Seed script uses its own drizzle instance directly inside a transaction.
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { SEED_ORG } from 'shared/constants';

const SEED_USER_EMAIL = 'demo@tellsight.local';

import * as schema from './schema.js';
import { buildSeedRows, SEED_DATASET_NAME } from './seedData.js';

const dbUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_ADMIN_URL (or DATABASE_URL) is required for seeding');
  process.exit(1);
}

const client = postgres(dbUrl, { max: 1 });
const db = drizzle(client, { schema });

const FALLBACK_SEED_SUMMARY = `Revenue grew 12% year-over-year, from $187K in 2024 to $210K in 2025. December remained the standout month both years, hitting $31K in 2025 versus $28K the year before. The growth is real but concentrated in seasonal peaks.

Payroll spiked to $9,200 in October 2025, about 45% above normal. That didn't happen in 2024, so it's not seasonal, worth investigating whether it's a one-time bonus or a staffing change that sticks. If it repeats, it eats most of the revenue gains.

Marketing got slashed to $200-$300/month during Q3 2025, down from $800-$1,200 the rest of the year. Revenue didn't dip, which suggests the cafe's regulars aren't ad-driven. The same period in 2024 kept full marketing spend with no revenue difference, strong signal to keep Q3 lean.

Margins are tighter than they look. After expenses, most months net $2K-$4K. The December spike papers over thin months. A cash reserve from holiday season would smooth out the year without forcing cuts.`;

/** The demo org shipped with no members at all, which is the orphaned state the
 *  account deletion path now refuses to create, and it meant the k6 load test was
 *  signing tokens for a user that was not in the database. That only passed
 *  because nothing looked. No password hash and no google id, so no auth path can
 *  sign in as it. */
type SeedTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function ensureSeedOwner(tx: SeedTx, orgId: number) {
  const [inserted] = await tx
    .insert(schema.users)
    .values({ email: SEED_USER_EMAIL, name: 'Sunrise Cafe Demo' })
    .onConflictDoNothing({ target: schema.users.email })
    .returning();

  const owner = inserted ?? await tx.query.users.findFirst({
    where: eq(schema.users.email, SEED_USER_EMAIL),
  });
  if (!owner) throw new Error('Seed owner vanished between upsert and lookup');

  await tx
    .insert(schema.userOrgs)
    .values({ orgId, userId: owner.id, role: 'owner' })
    .onConflictDoNothing();

  console.info(`Seed org owner is user ${owner.id} (org ${orgId})`);
}

async function seed() {
  // app_admin role has BYPASSRLS, no SET LOCAL needed
  await db.transaction(async (tx) => {
    // Idempotency: check if seed org + seed dataset already exist
    const existing = await tx.query.orgs.findFirst({
      where: eq(schema.orgs.slug, SEED_ORG.slug),
    });

    if (existing) {
      const seedDataset = await tx.query.datasets.findFirst({
        where: and(
          eq(schema.datasets.orgId, existing.id),
          eq(schema.datasets.isSeedData, true),
        ),
      });
      if (seedDataset) {
        // Per-resource, not all-or-nothing: the owner arrived after the data did,
        // so every environment already past this point would never get one.
        await ensureSeedOwner(tx, existing.id);
        console.info(`Seed data already exists for "${SEED_ORG.name}", skipping`);
        return;
      }
    }

    // Upsert org, ON CONFLICT prevents race condition if two containers start simultaneously
    const [org] = await tx
      .insert(schema.orgs)
      .values({ name: SEED_ORG.name, slug: SEED_ORG.slug })
      .onConflictDoNothing({ target: schema.orgs.slug })
      .returning();

    // If upsert returned nothing, the org already existed, look it up
    const fallbackOrg = org ?? await tx.query.orgs.findFirst({
      where: eq(schema.orgs.slug, SEED_ORG.slug),
    });
    if (!fallbackOrg) throw new Error(`Seed org "${SEED_ORG.slug}" vanished between upsert and lookup`);
    const orgId = fallbackOrg.id;

    const [dataset] = await tx
      .insert(schema.datasets)
      .values({
        orgId,
        name: SEED_DATASET_NAME,
        sourceType: 'csv',
        isSeedData: true,
      })
      .returning();

    if (!dataset) throw new Error('Failed to create seed dataset');

    await ensureSeedOwner(tx, orgId);

    const rows = buildSeedRows();
    await tx.insert(schema.dataRows).values(
      rows.map((r) => ({ ...r, orgId, datasetId: dataset.id })),
    );

    console.info(`Seeded "${SEED_ORG.name}" org (id=${orgId}) with ${rows.length} data rows`);

    // Bypasses runFullPipeline because seed uses its own Drizzle instance (standalone
    // postgres connection), not lib/db.ts which pulls in config.ts env validation.
    // Duplicates the pipeline steps manually so seed can run without full app config.
    const apiKey = process.env.CLAUDE_API_KEY;
    // Only catches the literal "placeholder". CI's key is a plausible-looking
    // dummy, so it reaches the live call and fails there instead, which is why
    // the catch below has to insert the fallback rather than shrug.
    const hasRealKey = apiKey && !apiKey.includes('placeholder');

    // Hardcoded fallback, the dashboard works out of the box with no API key.
    // Matches the seed data: 12 months for Sunrise Cafe, Dec revenue spike,
    // Oct payroll anomaly, Q3 marketing dip.
    const insertFallbackSummary = () =>
      tx.insert(schema.aiSummaries).values({
        orgId,
        datasetId: dataset.id,
        content: FALLBACK_SEED_SUMMARY,
        transparencyMetadata: {
          statsCount: 24,
          topCategories: ['Revenue', 'Payroll', 'Marketing'],
          computationTimeMs: 0,
          model: 'pre-generated',
          promptVersion: 'v1',
        },
        promptVersion: 'v1',
        isSeed: true,
      });

    if (!hasRealKey) {
      await insertFallbackSummary();
      console.info('Seed AI summary inserted (hardcoded fallback, no API key)');
    } else {
      try {
        const { computeStats } = await import('../services/curation/computation.js');
        const { scoreInsights } = await import('../services/curation/scoring.js');
        const { assemblePrompt } = await import('../services/curation/assembly.js');

        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const claude = new Anthropic({
          apiKey: process.env.CLAUDE_API_KEY,
          maxRetries: 2,
          timeout: 30_000, // longer timeout for seed, runs once, not on hot path
        });

        const dbRows = rows.map((r, i) => ({
          id: i + 1,
          orgId,
          datasetId: dataset.id,
          sourceType: r.sourceType as 'csv',
          category: r.category,
          parentCategory: r.parentCategory,
          date: r.date,
          amount: r.amount,
          label: r.label,
          metadata: null,
          createdAt: new Date(),
        }));

        const stats = computeStats(dbRows, { trendMinPoints: 3 });
        const scored = scoreInsights(stats);
        const { system, user, metadata } = assemblePrompt(scored, dataset.id);

        const model = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-5-20250929';
        const message = await claude.messages.create({
          model,
          max_tokens: 1024,
          ...(system && {
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          }),
          messages: [{ role: 'user', content: user }],
        });

        const content = message.content[0]?.type === 'text' ? message.content[0].text : '';

        await tx.insert(schema.aiSummaries).values({
          orgId,
          datasetId: dataset.id,
          content,
          transparencyMetadata: metadata,
          promptVersion: metadata.promptVersion,
          isSeed: true,
        });

        console.info(`Seed AI summary generated (${content.length} chars, ${message.usage.output_tokens} tokens)`);
      } catch (err) {
        // Leaving the org with no summary at all contradicts the promise above.
        // A dud key, a network blip or a rate limit should degrade to the canned
        // copy, not to an empty dashboard.
        console.warn('Seed summary generation failed, using the fallback:', (err as Error).message);
        await insertFallbackSummary();
      }
    }
  });
}

seed()
  .then(() => client.end())
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await client.end();
    process.exit(1);
  });
