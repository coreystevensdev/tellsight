import { createElement, act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

import { logger } from '../../lib/logger.js';
import { RunwayEmailChart } from './charts/RunwayEmailChart.js';
import type { RunwayChartPoint } from './charts/RunwayEmailChart.js';
import { CashFlowEmailChart } from './charts/CashFlowEmailChart.js';
import type { CashFlowChartPoint } from './charts/CashFlowEmailChart.js';
import { MarginEmailChart } from './charts/MarginEmailChart.js';
import type { MarginChartPoint } from './charts/MarginEmailChart.js';

// react-dom/client reads document/window/navigator off globalThis, so React
// won't complain about act() being used outside a configured test runner.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

export interface RenderChartContext {
  correlationId: string;
  orgId: number;
  ruleId: number;
}

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

// Recharts v3 reports its own pixel size through a useEffect (ReportChartSize
// in recharts/es6/context/chartLayoutContext.js), which never runs under
// react-dom/server: renderToStaticMarkup produces an empty
// <div class="recharts-wrapper"> with no <svg> inside at all. jsdom supplies
// just enough DOM (no ResizeObserver needed, since width/height are fixed
// numeric props, not ResponsiveContainer) for a real react-dom/client render
// through act() to fire that effect and compute real geometry. It's a
// pure-JS DOM shim, not a headless browser: no Chromium download, no browser
// process, and jsdom is already a devDependency of apps/web's test suite, so
// this doesn't add the container-size cost Playwright would have.
//
// react-dom/client reads document/window/navigator off globalThis, so two
// renders can't safely share the module scope at once. `renderQueue`
// serializes every call through this file so exactly one render owns the
// shimmed globals at a time, which is what "no shared Recharts state across
// concurrent renders" requires even though alerts-send runs at concurrency 10.
let renderQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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

    const svg = container.querySelector('svg');
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
    font: { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

async function optimizePng(png: Buffer, quality: number): Promise<Buffer> {
  return sharp(png).png({ quality, compressionLevel: 9 }).toBuffer();
}

/**
 * Renders a fired insight to a PNG chart, or null if it can't be produced
 * within the size/parse constraints. Never throws: every failure mode here
 * degrades the alert email to text-only rather than failing the send job.
 */
export async function renderChart(
  params: ChartRenderInput & { width?: number; height?: number },
  context: RenderChartContext,
): Promise<Buffer | null> {
  const width = params.width ?? RENDER_WIDTH;
  const height = params.height ?? RENDER_HEIGHT;
  const start = Date.now();
  const logFields = { ...context, chartKind: params.chartKind };

  return serialize(async () => {
    let svg: string;
    try {
      svg = await renderSvgString(buildChartElement(params, width, height));
    } catch (err) {
      logger.warn(
        { ...logFields, err, durationMs: Date.now() - start },
        'Chart render threw before producing SVG, sending text-only',
      );
      return null;
    }

    if (!svg) {
      logger.warn(
        { ...logFields, durationMs: Date.now() - start },
        'Chart render produced no SVG content, sending text-only',
      );
      return null;
    }

    let png: Buffer;
    try {
      png = svgToPng(svg, width);
    } catch (err) {
      logger.warn(
        { ...logFields, err, durationMs: Date.now() - start },
        'Resvg failed to parse chart SVG, sending text-only',
      );
      return null;
    }

    let optimized: Buffer;
    try {
      optimized = await optimizePng(png, SHARP_QUALITY_PRIMARY);
      if (optimized.length > MAX_PNG_BYTES) {
        optimized = await optimizePng(png, SHARP_QUALITY_RETRY);
      }
    } catch (err) {
      logger.warn(
        { ...logFields, err, durationMs: Date.now() - start },
        'Sharp failed to optimize the chart PNG, sending text-only',
      );
      return null;
    }
    if (optimized.length > MAX_PNG_BYTES) {
      logger.warn(
        { ...logFields, bytes: optimized.length, maxBytes: MAX_PNG_BYTES, durationMs: Date.now() - start },
        'Chart PNG still exceeds the size budget after a lower-quality retry, sending text-only',
      );
      return null;
    }

    return optimized;
  });
}
