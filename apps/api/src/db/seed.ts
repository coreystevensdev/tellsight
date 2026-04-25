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

// 12 months of demo data for Sunrise Cafe — a fictional coffee shop.
// Ends at the current month so date presets always show recent data.
// Anomalies baked in so the curation pipeline has something to interpret.
function buildSeedRows(orgId: number, datasetId: number) {
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

  const WEEKS_PER_MONTH = 4;
  const now = new Date();
  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth();

  // 12 months back from current month
  const startDate = new Date(Date.UTC(endYear, endMonth - 11, 1));
  const startYear = startDate.getUTCFullYear();
  const startMonth = startDate.getUTCMonth();

  for (let year = startYear; year <= endYear; year++) {
    const yoyGrowth = 1.0;
    const firstM = year === startYear ? startMonth : 0;
    const lastM = year === endYear ? endMonth : 11;
    const months = Array.from({ length: lastM - firstM + 1 }, (_, i) => firstM + i);

    for (const m of months) {
      // Revenue: $12k–$18k monthly baseline in 2024, +12% in 2025. December spike both years.
      const monthlyRevenue = m === 11 ? 28000 : parseFloat(lerp('12000.00', '18000.00', m));
      const monthlyPayroll = (year >= 2025 && m === 9) ? 9200 : parseFloat(lerp('5500.00', '6500.00', m));
      const isQ3Dip = year >= 2025 && m >= 6 && m <= 8;
      const monthlyMarketing = isQ3Dip
        ? parseFloat(lerp('200.00', '300.00', m - 6))
        : parseFloat(lerp('800.00', '1200.00', m));
      const monthlyRent = 3000;
      const monthlySupplies = parseFloat(lerp('1500.00', '2500.00', m));
      const monthlyUtilities = parseFloat(lerp('600.00', '400.00', m));

      for (let w = 0; w < WEEKS_PER_MONTH; w++) {
        const day = 1 + w * 7;
        const date = new Date(Date.UTC(year, m, day));
        const jitter = () => 0.9 + Math.random() * 0.2;

        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Revenue', parentCategory: 'Income',
          date, amount: ((monthlyRevenue / WEEKS_PER_MONTH) * yoyGrowth * jitter()).toFixed(2), label: null,
        });

        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Payroll', parentCategory: 'Expenses',
          date, amount: ((monthlyPayroll / WEEKS_PER_MONTH) * jitter()).toFixed(2), label: null,
        });

        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Marketing', parentCategory: 'Expenses',
          date, amount: ((monthlyMarketing / WEEKS_PER_MONTH) * jitter()).toFixed(2), label: null,
        });

        // Rent: paid once per month on the 1st
        if (w === 0) {
          rows.push({
            orgId, datasetId, sourceType: 'csv',
            category: 'Rent', parentCategory: 'Expenses',
            date, amount: monthlyRent.toFixed(2), label: null,
          });
        }

        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Supplies', parentCategory: 'Expenses',
          date, amount: ((monthlySupplies / WEEKS_PER_MONTH) * jitter()).toFixed(2), label: null,
        });

        rows.push({
          orgId, datasetId, sourceType: 'csv',
          category: 'Utilities', parentCategory: 'Expenses',
          date, amount: ((monthlyUtilities / WEEKS_PER_MONTH) * jitter()).toFixed(2), label: null,
        });
      }
    }
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

const FALLBACK_SEED_SUMMARY = `Revenue grew 12% year-over-year — from $187K in 2024 to $210K in 2025. December remained the standout month both years, hitting $31K in 2025 versus $28K the year before. The growth is real but concentrated in seasonal peaks.

Payroll spiked to $9,200 in October 2025, about 45% above normal. That didn't happen in 2024, so it's not seasonal — worth investigating whether it's a one-time bonus or a staffing change that sticks. If it repeats, it eats most of the revenue gains.

Marketing got slashed to $200–$300/month during Q3 2025, down from $800–$1,200 the rest of the year. Revenue didn't dip, which suggests the cafe's regulars aren't ad-driven. The same period in 2024 kept full marketing spend with no revenue difference — strong signal to keep Q3 lean.

Margins are tighter than they look. After expenses, most months net $2K–$4K. The December spike papers over thin months. A cash reserve from holiday season would smooth out the year without forcing cuts.`;

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
        name: 'Sunrise Cafe 2024–2025 Financials',
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
        const { system, user, metadata } = assemblePrompt(scored);

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
