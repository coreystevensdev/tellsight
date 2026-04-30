/**
 * README asset generator: hero banner, browser-framed feature screenshots.
 *
 * Run: pnpm screenshots
 * Requires: docker compose up running on localhost:3000
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'docs', 'screenshots');
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const VIEWPORT = { width: 1280, height: 900 };
const SETTLE_MS = 1200;

// ---------------------------------------------------------------------------
// Browser frame template (macOS-style window chrome)
// ---------------------------------------------------------------------------

function browserFrameHtml(screenshotBase64: string, url: string, darkMode: boolean): string {
  const bg = darkMode ? '#1a1a2e' : '#f5f5f7';
  const titleBarBg = darkMode
    ? 'linear-gradient(180deg, #2d2d3f, #252537)'
    : 'linear-gradient(180deg, #e8e6e8, #d4d2d4)';
  const titleColor = darkMode ? '#a0a0b0' : '#4d4d4d';
  const shadow = darkMode
    ? '0 25px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)'
    : '0 25px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.04)';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:60px 80px; background:${bg}; display:flex; justify-content:center; align-items:flex-start;">
  <div style="border-radius:12px; overflow:hidden; box-shadow:${shadow}; max-width:1280px; width:100%;">
    <div style="background:${titleBarBg}; height:44px; display:flex; align-items:center; padding:0 16px; position:relative;">
      <div style="display:flex; gap:8px;">
        <div style="width:12px; height:12px; border-radius:50%; background:#ff5f57; box-shadow:inset 0 -1px 2px rgba(0,0,0,0.15);"></div>
        <div style="width:12px; height:12px; border-radius:50%; background:#febc2e; box-shadow:inset 0 -1px 2px rgba(0,0,0,0.15);"></div>
        <div style="width:12px; height:12px; border-radius:50%; background:#28c840; box-shadow:inset 0 -1px 2px rgba(0,0,0,0.15);"></div>
      </div>
      <div style="position:absolute; left:50%; transform:translateX(-50%); font-family:-apple-system,BlinkMacSystemFont,sans-serif; font-size:13px; color:${titleColor};">
        ${url}
      </div>
    </div>
    <img src="data:image/png;base64,${screenshotBase64}" style="display:block; width:100%;">
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Hero banner template
// ---------------------------------------------------------------------------

function heroBannerHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
</style>
</head>
<body style="margin:0; padding:0;">
<div style="
  width:1280px; height:360px;
  background: linear-gradient(135deg, #0c1222 0%, #162036 35%, #1a1a3e 60%, #0f172a 100%);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  position:relative; overflow:hidden; font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
">
  <!-- Grid pattern overlay -->
  <div style="
    position:absolute; inset:0; opacity:0.04;
    background-image: linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px);
    background-size: 40px 40px;
  "></div>

  <!-- Gradient glow -->
  <div style="
    position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
    width:600px; height:300px; border-radius:50%;
    background:radial-gradient(ellipse, rgba(56,139,253,0.12) 0%, transparent 70%);
  "></div>

  <!-- Logo mark -->
  <div style="
    display:flex; align-items:center; gap:14px; margin-bottom:16px; position:relative;
  ">
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <rect width="40" height="40" rx="10" fill="rgba(56,139,253,0.15)"/>
      <rect x="8" y="22" width="6" height="12" rx="2" fill="#388bfd"/>
      <rect x="17" y="14" width="6" height="20" rx="2" fill="#58a6ff"/>
      <rect x="26" y="8" width="6" height="26" rx="2" fill="#79c0ff"/>
    </svg>
    <span style="font-size:36px; font-weight:800; color:#e6edf3; letter-spacing:-0.5px;">
      Tellsight
    </span>
  </div>

  <!-- Tagline -->
  <p style="
    font-size:18px; color:#8b949e; font-weight:400; max-width:560px;
    text-align:center; line-height:1.5; position:relative;
  ">
    AI-powered analytics that explains business data in plain English
  </p>

  <!-- Tech badges -->
  <div style="
    display:flex; gap:8px; margin-top:28px; flex-wrap:wrap;
    justify-content:center; position:relative;
  ">
    <span style="background:rgba(56,139,253,0.12); color:#58a6ff; padding:5px 14px; border-radius:20px; font-size:12px; font-weight:500; border:1px solid rgba(56,139,253,0.2);">Next.js 16</span>
    <span style="background:rgba(56,139,253,0.12); color:#58a6ff; padding:5px 14px; border-radius:20px; font-size:12px; font-weight:500; border:1px solid rgba(56,139,253,0.2);">Express 5</span>
    <span style="background:rgba(56,139,253,0.12); color:#58a6ff; padding:5px 14px; border-radius:20px; font-size:12px; font-weight:500; border:1px solid rgba(56,139,253,0.2);">PostgreSQL 18</span>
    <span style="background:rgba(56,139,253,0.12); color:#58a6ff; padding:5px 14px; border-radius:20px; font-size:12px; font-weight:500; border:1px solid rgba(56,139,253,0.2);">Claude API</span>
    <span style="background:rgba(56,139,253,0.12); color:#58a6ff; padding:5px 14px; border-radius:20px; font-size:12px; font-weight:500; border:1px solid rgba(56,139,253,0.2);">Stripe</span>
    <span style="background:rgba(56,139,253,0.12); color:#58a6ff; padding:5px 14px; border-radius:20px; font-size:12px; font-weight:500; border:1px solid rgba(56,139,253,0.2);">SSE Streaming</span>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForCharts(page: Page) {
  await page.waitForFunction(
    () => document.querySelectorAll('figure svg').length >= 2,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(SETTLE_MS);
}

async function waitForAiSummary(page: Page) {
  await page.waitForFunction(
    () => !!document.querySelector('div[role="region"][aria-label="AI business summary"]'),
    { timeout: 30_000 },
  );
  await waitForCharts(page);
}

async function setDarkMode(page: Page) {
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
}

async function rawScreenshot(browser: Browser, url: string, opts: {
  darkMode?: boolean;
  viewport?: { width: number; height: number };
  prepare?: (page: Page) => Promise<void>;
  waitFor?: (page: Page) => Promise<void>;
}): Promise<Buffer> {
  const vp = opts.viewport ?? VIEWPORT;
  const context = await browser.newContext({ viewport: vp });
  const page = await context.newPage();

  if (opts.darkMode) await setDarkMode(page);

  await page.goto(url, { waitUntil: 'networkidle' });

  if (opts.waitFor) await opts.waitFor(page);
  if (opts.prepare) await opts.prepare(page);

  await page.waitForTimeout(300);
  const buf = await page.screenshot();
  await context.close();
  return buf;
}

async function wrapInFrame(browser: Browser, raw: Buffer, url: string, name: string, darkMode: boolean) {
  const base64 = raw.toString('base64');
  const html = browserFrameHtml(base64, url, darkMode);

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });

  // clip to the actual content (frame + padding)
  const wrapper = page.locator('body > div');
  const box = await wrapper.boundingBox();

  const outPath = resolve(OUT_DIR, `${name}.png`);
  if (box) {
    const pad = 60;
    await page.screenshot({
      path: outPath,
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: box.width + pad * 2,
        height: box.height + pad * 2,
      },
    });
  } else {
    await page.screenshot({ path: outPath });
  }

  console.log(`  ${name}.png`);
  await context.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  console.log('Generating README assets...\n');

  const browser = await chromium.launch();

  // -- 1. Hero banner --
  console.log('[1/4] Hero banner');
  const bannerCtx = await browser.newContext({
    viewport: { width: 1280, height: 360 },
  });
  const bannerPage = await bannerCtx.newPage();
  await bannerPage.setContent(heroBannerHtml(), { waitUntil: 'networkidle' });
  await bannerPage.waitForTimeout(500);
  await bannerPage.screenshot({
    path: resolve(OUT_DIR, 'banner.png'),
    clip: { x: 0, y: 0, width: 1280, height: 360 },
  });
  console.log('  banner.png');
  await bannerCtx.close();

  // -- 2. Dashboard with KPIs + charts (light) --
  console.log('[2/4] Dashboard with KPIs + charts (light)');
  const chartsRaw = await rawScreenshot(browser, `${BASE_URL}/dashboard`, {
    waitFor: waitForCharts,
    prepare: async (page) => {
      // AI summary is now below charts, hide it so hero focuses on KPIs + charts
      await page.evaluate(() => {
        const aiRegion = document.querySelector('div[role="region"][aria-label="AI business summary"]');
        const wrapper = aiRegion?.closest('.mt-6');
        if (wrapper) (wrapper as HTMLElement).style.display = 'none';
      });
    },
  });
  await wrapInFrame(browser, chartsRaw, 'localhost:3000/dashboard', 'feature-charts', false);

  // -- 3. Dashboard with AI summary (dark) --
  console.log('[3/4] Dashboard with AI summary (dark)');
  const aiRaw = await rawScreenshot(browser, `${BASE_URL}/dashboard`, {
    darkMode: true,
    viewport: { width: 1280, height: 1600 },
    waitFor: waitForAiSummary,
  });
  await wrapInFrame(browser, aiRaw, 'localhost:3000/dashboard', 'feature-ai', true);

  // -- 4. Dashboard charts (dark, alternate view) --
  console.log('[4/4] Dashboard charts (dark)');
  const chartsDarkRaw = await rawScreenshot(browser, `${BASE_URL}/dashboard`, {
    darkMode: true,
    waitFor: waitForCharts,
    prepare: async (page) => {
      await page.evaluate(() => {
        const aiRegion = document.querySelector('div[role="region"][aria-label="AI business summary"]');
        const wrapper = aiRegion?.closest('.mt-6');
        if (wrapper) (wrapper as HTMLElement).style.display = 'none';
      });
    },
  });
  await wrapInFrame(browser, chartsDarkRaw, 'localhost:3000/dashboard', 'feature-charts-dark', true);

  await browser.close();

  // keep legacy filenames for backward compat with existing README references
  // (hero-light.png and hero-dark.png will be replaced by the new assets)

  console.log('\nDone. Assets saved to docs/screenshots/');
}

main().catch((err) => {
  console.error('Screenshot generation failed:', err);
  process.exit(1);
});
