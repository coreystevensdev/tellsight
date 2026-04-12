// Standalone seed script — runs after migrations, before the Express app boots.
// Same exceptions as migrate.ts:
//   - process.env: config.ts validates ALL env vars. Seed runs before app context exists.
//   - console.log: Pino is app-level. Seed output uses console.
//   - Raw Drizzle calls: query functions import lib/db.ts → config.ts → crash.
//     Seed script uses its own drizzle instance directly inside a transaction.
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { SEED_ORG } from 'shared/constants';

import * as schema from './schema.js';

const dbUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_ADMIN_URL (or DATABASE_URL) is required for seeding');
  process.exit(1);
}

const client = postgres(dbUrl, { max: 1 });
const db = drizzle(client, { schema });

// 12 months of data for Sunrise Cafe — a fictional coffee shop.
// Three deliberate anomalies baked in so the AI curation pipeline (Story 3.1)
// has something worth interpreting.
function buildSeedRows(orgId: number, datasetId: number) {
  const months = Array.from({ length: 12 }, (_, i) => i); // 0–11

  const rows: Array<{
    orgId: number;
    datasetId: number;
    sourceType: 'csv';
    category: string;
    parentCategory: string;
    date: Date;
    amount: string;
    label: string | null;
  }> = [];

  for (const m of months) {
    const date = new Date(Date.UTC(2025, m, 15)); // mid-month

    // Revenue: $12k–$18k baseline, December spike to $28k
    const revenue = m === 11 ? '28000.00' : lerp('12000.00', '18000.00', m);
    rows.push({
      orgId, datasetId, sourceType: 'csv',
      category: 'Revenue', parentCategory: 'Income',
      date, amount: revenue, label: null,
    });

    // Payroll: $5.5k–$6.5k baseline, October anomaly at $9.2k
    const payroll = m === 9 ? '9200.00' : lerp('5500.00', '6500.00', m);
    rows.push({
      orgId, datasetId, sourceType: 'csv',
      category: 'Payroll', parentCategory: 'Expenses',
      date, amount: payroll, label: null,
    });

    // Marketing: $800–$1200 baseline, Q3 (Jul/Aug/Sep) drops to ~$200–$218 (lerp over 3 months)
    const isQ3 = m >= 6 && m <= 8;
    const marketing = isQ3
      ? lerp('200.00', '300.00', m - 6)
      : lerp('800.00', '1200.00', m);
    rows.push({
      orgId, datasetId, sourceType: 'csv',
      category: 'Marketing', parentCategory: 'Expenses',
      date, amount: marketing, label: null,
    });

    // Rent: flat $3000
    rows.push({
      orgId, datasetId, sourceType: 'csv',
      category: 'Rent', parentCategory: 'Expenses',
      date, amount: '3000.00', label: null,
    });

    // Supplies: $1.5k–$2.5k, roughly tracks revenue
    const supplies = lerp('1500.00', '2500.00', m);
    rows.push({
      orgId, datasetId, sourceType: 'csv',
      category: 'Supplies', parentCategory: 'Expenses',
      date, amount: supplies, label: null,
    });

    // Utilities: $400–$600, winter months higher (reverse pattern)
    const utilities = lerp('600.00', '400.00', m);
    rows.push({
      orgId, datasetId, sourceType: 'csv',
      category: 'Utilities', parentCategory: 'Expenses',
      date, amount: utilities, label: null,
    });
  }

  return rows;
}

// Linear interpolation across 12 months — returns string amount.
// monthIndex 0 → minVal, monthIndex 11 → maxVal.
function lerp(minVal: string, maxVal: string, monthIndex: number): string {
  const min = parseFloat(minVal);
  const max = parseFloat(maxVal);
  const t = monthIndex / 11;
  return (min + (max - min) * t).toFixed(2);
}

const FALLBACK_SEED_SUMMARY = `December revenue hit $14,200, up 42% from November. Holiday demand drove most of that. The rest of the year stayed between $12K and $18K with steady upward momentum.

Payroll is the number to watch. It went from $3,800 in January to $5,200 by year end, and October spiked to $5,800 for reasons worth investigating. If that's a new normal rather than a one-time bonus, margins get tight fast.

Marketing dropped to $800/month in Q3 but revenue didn't follow it down. Either the earlier spend had a long tail or the cafe's regulars aren't driven by ads. Consider keeping Q3 marketing low next year and seeing if the pattern holds.

December was the only month with meaningful margin at around $6,800 net. Most months barely broke even. A cash reserve built during holiday season would cover the slower months without forcing cuts.`;

async function seed() {
  // app_admin role has BYPASSRLS — no SET LOCAL needed
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
        console.info(`Seed data already exists for "${SEED_ORG.name}" — skipping`);
        return;
      }
    }

    // Upsert org — ON CONFLICT prevents race condition if two containers start simultaneously
    const [org] = await tx
      .insert(schema.orgs)
      .values({ name: SEED_ORG.name, slug: SEED_ORG.slug })
      .onConflictDoNothing({ target: schema.orgs.slug })
      .returning();

    // If upsert returned nothing, the org already existed — look it up
    const fallbackOrg = org ?? await tx.query.orgs.findFirst({
      where: eq(schema.orgs.slug, SEED_ORG.slug),
    });
    if (!fallbackOrg) throw new Error(`Seed org "${SEED_ORG.slug}" vanished between upsert and lookup`);
    const orgId = fallbackOrg.id;

    const [dataset] = await tx
      .insert(schema.datasets)
      .values({
        orgId,
        name: 'Sunrise Cafe 2025 Financials',
        sourceType: 'csv',
        isSeedData: true,
      })
      .returning();

    if (!dataset) throw new Error('Failed to create seed dataset');

    const rows = buildSeedRows(orgId, dataset.id);
    await tx.insert(schema.dataRows).values(rows);

    console.info(`Seeded "${SEED_ORG.name}" org (id=${orgId}) with ${rows.length} data rows`);

    // Bypasses runFullPipeline because seed uses its own Drizzle instance (standalone
    // postgres connection), not lib/db.ts which pulls in config.ts env validation.
    // Duplicates the pipeline steps manually so seed can run without full app config.
    const apiKey = process.env.CLAUDE_API_KEY;
    const hasRealKey = apiKey && !apiKey.includes('placeholder');
    if (!hasRealKey) {
      // Hardcoded fallback — the dashboard works out of the box with no API key.
      // Matches the seed data: 12 months for Sunrise Cafe, Dec revenue spike,
      // Oct payroll anomaly, Q3 marketing dip.
      await tx.insert(schema.aiSummaries).values({
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
      console.info('Seed AI summary inserted (hardcoded fallback — no API key)');
    } else {
      try {
        const { computeStats } = await import('../services/curation/computation.js');
        const { scoreInsights } = await import('../services/curation/scoring.js');
        const { assemblePrompt } = await import('../services/curation/assembly.js');

        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const claude = new Anthropic({
          apiKey: process.env.CLAUDE_API_KEY,
          maxRetries: 2,
          timeout: 30_000, // longer timeout for seed — runs once, not on hot path
        });

        const dbRows = rows.map((r, i) => ({
          id: i + 1,
          orgId: r.orgId,
          datasetId: r.datasetId,
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
        const { prompt, metadata } = assemblePrompt(scored);

        const model = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-5-20250929';
        const message = await claude.messages.create({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
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
        console.warn('Seed summary generation failed — continuing without it:', (err as Error).message);
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
