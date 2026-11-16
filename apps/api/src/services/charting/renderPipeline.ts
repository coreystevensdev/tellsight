import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement, act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

import { RunwayEmailChart } from './charts/RunwayEmailChart.js';
import type { RunwayChartPoint } from './charts/RunwayEmailChart.js';
import { CashFlowEmailChart } from './charts/CashFlowEmailChart.js';
import type { CashFlowChartPoint } from './charts/CashFlowEmailChart.js';
import { MarginEmailChart } from './charts/MarginEmailChart.js';
import type { MarginChartPoint } from './charts/MarginEmailChart.js';

// Imports no logger, on purpose. The render worker loads this module, and
// `lib/logger` pulls in `config.ts`, which Zod-validates the whole environment
// at module load and throws. A thread whose only job is turning numbers into a
// PNG should not need a valid DATABASE_URL to boot. Reporting is the parent's.

// react-dom/client reads document/window/navigator off globalThis, so React
// won't complain about act() being used outside a configured test runner.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const __dirname = dirname(fileURLToPath(import.meta.url));

// node:22-slim carries no fonts and no fontconfig, so loadSystemFonts resolved
// nothing in the deployed image and every chart rendered with its axis labels
// missing: byte-identical to passing loadSystemFonts false. It looked right in
// dev and in CI because both have system fonts. Shipping the file is also what
// makes the three environments render the same bytes.
const CHART_FONT = resolve(__dirname, 'fonts', 'JetBrainsMono-Regular.ttf');
const CHART_FONT_FAMILY = 'JetBrains Mono';

const RENDER_WIDTH = 1200; // 2x the 600px email display width, for retina
const RENDER_HEIGHT = 600;
const MAX_PNG_BYTES = 80 * 1024;
const SHARP_QUALITY_PRIMARY = 80;
const SHARP_QUALITY_RETRY = 50;

export interface RunwayChartData {
  cashOnHand: number;
  monthlyNet: number;
  runwayMonths: number;
}

export interface CashFlowChartData {
  recentMonths: { month: string; revenue: number; expenses: number }[];
}

export interface MarginChartData {
  recentMarginPercent: number;
  priorMarginPercent: number;
  direction: 'expanding' | 'shrinking' | 'stable';
}

export type ChartRenderInput =
  | { chartKind: 'runway'; data: RunwayChartData }
  | { chartKind: 'cash-flow'; data: CashFlowChartData }
  | { chartKind: 'margin'; data: MarginChartData };

// Alert payloads carry one point-in-time stat, not the historical series the
// dashboard's runway chart draws from. monthlyNet is negative (the rule only
// fires while burning), so this projects a straight decline to zero rather
// than drawing a "historical" segment we don't have data for.
export function buildRunwayPoints(data: RunwayChartData): RunwayChartPoint[] {
  const months = Math.max(1, Math.ceil(data.runwayMonths));
  const points: RunwayChartPoint[] = [];
  for (let m = 0; m <= months; m++) {
    points.push({
      label: m === 0 ? 'Today' : `Month ${m}`,
      balance: Math.max(0, data.cashOnHand + data.monthlyNet * m),
    });
  }
  return points;
}

export function buildCashFlowPoints(data: CashFlowChartData): CashFlowChartPoint[] {
  return data.recentMonths.map((m) => ({ month: m.month, revenue: m.revenue, expenses: m.expenses }));
}

export function buildMarginPoints(data: MarginChartData): MarginChartPoint[] {
  return [
    { label: 'Prior period', marginPercent: data.priorMarginPercent },
    { label: 'Recent period', marginPercent: data.recentMarginPercent },
  ];
}

function buildChartElement(input: ChartRenderInput, width: number, height: number): ReactElement {
  switch (input.chartKind) {
    case 'runway':
      return createElement(RunwayEmailChart, { width, height, points: buildRunwayPoints(input.data) });
    case 'cash-flow':
      return createElement(CashFlowEmailChart, { width, height, points: buildCashFlowPoints(input.data) });
    case 'margin':
      return createElement(MarginEmailChart, {
        width,
        height,
        points: buildMarginPoints(input.data),
        direction: input.data.direction,
      });
  }
}

async function renderSvgString(element: ReactElement): Promise<string> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true });
  g.HTMLElement = dom.window.HTMLElement;
  g.SVGElement = dom.window.SVGElement;

  try {
    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);
    await act(async () => {
      root.render(element);
    });

    // Legend icons are <svg class="recharts-surface"> too and precede the chart
    // in document order, so both querySelector('svg') and a class selector
    // return a 14px icon on any chart carrying a <Legend>. The surface is the
    // biggest one: icons are iconSize square.
    const svg = [...container.querySelectorAll('svg')].reduce<Element | null>((biggest, el) => {
      const area = Number(el.getAttribute('width')) * Number(el.getAttribute('height'));
      const best = biggest
        ? Number(biggest.getAttribute('width')) * Number(biggest.getAttribute('height'))
        : -1;
      return area > best ? el : biggest;
    }, null);
    if (!svg) return '';

    let html = svg.outerHTML;
    // jsdom's outerHTML omits the xmlns the HTML5 SVG integration point
    // implies; Resvg parses SVG as a standalone document and needs it explicit.
    if (!html.includes('xmlns=')) {
      html = html.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    }

    // Wrapped in its own act() so React flushes unmount-triggered cleanup
    // work before the shim comes down; unwrapped, a scheduler callback can
    // still be pending when `window` gets deleted below and throw.
    await act(async () => {
      root.unmount();
    });
    return html;
  } finally {
    delete g.window;
    delete g.document;
    delete g.navigator;
    delete g.HTMLElement;
    delete g.SVGElement;
  }
}

function svgToPng(svg: string, width: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: false,
      fontFiles: [CHART_FONT],
      defaultFontFamily: CHART_FONT_FAMILY,
    },
  });
  return resvg.render().asPng();
}

async function optimizePng(png: Buffer, quality: number): Promise<Buffer> {
  return sharp(png).png({ quality, compressionLevel: 9 }).toBuffer();
}

export type RenderOutcome =
  | { ok: true; png: Buffer }
  | {
      ok: false;
      stage: 'svg' | 'empty' | 'raster' | 'optimize' | 'oversize' | 'timeout' | 'worker';
      message: string;
      fields: Record<string, unknown>;
    };

export function failed(
  stage: Extract<RenderOutcome, { ok: false }>['stage'],
  message: string,
  fields: Record<string, unknown> = {},
): RenderOutcome {
  return { ok: false, stage, message, fields };
}

/**
 * The pipeline itself: SVG, raster, optimize. Returns which stage gave up
 * rather than logging, so a caller can report it and a test can assert it
 * without pinning the wording of a log line.
 *
 * Exported for tests. Callers want renderChart, which adds the lane and the
 * timings.
 */
export async function renderToPng(
  params: ChartRenderInput & { width?: number; height?: number },
): Promise<RenderOutcome> {
  const width = params.width ?? RENDER_WIDTH;
  const height = params.height ?? RENDER_HEIGHT;

  let svg: string;
  try {
    svg = await renderSvgString(buildChartElement(params, width, height));
  } catch (err) {
    return failed('svg', 'Chart render threw before producing SVG, sending text-only', { err });
  }
  if (!svg) {
    return failed('empty', 'Chart render produced no SVG content, sending text-only');
  }

  let png: Buffer;
  try {
    png = svgToPng(svg, width);
  } catch (err) {
    return failed('raster', 'Resvg failed to parse chart SVG, sending text-only', { err });
  }

  let optimized: Buffer;
  try {
    optimized = await optimizePng(png, SHARP_QUALITY_PRIMARY);
    if (optimized.length > MAX_PNG_BYTES) {
      optimized = await optimizePng(png, SHARP_QUALITY_RETRY);
    }
  } catch (err) {
    return failed('optimize', 'Sharp failed to optimize the chart PNG, sending text-only', { err });
  }
  if (optimized.length > MAX_PNG_BYTES) {
    return failed(
      'oversize',
      'Chart PNG still exceeds the size budget after a lower-quality retry, sending text-only',
      { bytes: optimized.length, maxBytes: MAX_PNG_BYTES },
    );
  }

  return { ok: true, png: optimized };
}

