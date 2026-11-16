import { Worker } from 'node:worker_threads';

import { logger } from '../../lib/logger.js';
import { failed } from './renderPipeline.js';
import type { ChartRenderInput, RenderOutcome } from './renderPipeline.js';

// The split exists for the worker's module graph, not for callers, so the
// charting surface still comes from this one file.
export { renderToPng } from './renderPipeline.js';
export {
  buildRunwayPoints,
  buildCashFlowPoints,
  buildMarginPoints,
} from './renderPipeline.js';
export type {
  ChartRenderInput,
  RenderOutcome,
  RunwayChartData,
  CashFlowChartData,
  MarginChartData,
} from './renderPipeline.js';

export interface RenderChartContext {
  correlationId: string;
  orgId: number;
  // Optional because the digest has no rule to attribute a render to. The
  // alert path still passes it and its log fields are unchanged.
  ruleId?: number;
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
// This was a correctness guard: react-dom/client reads document, window and
// navigator off globalThis, and two in-process renders raced on the same shim.
// Renders run in worker threads now and each owns its globals, so that reason
// is gone and the lane stays only as a memory cap. Every worker loads jsdom,
// React, Resvg and sharp, on a 1GB t2.micro where alerts-send at concurrency 10
// would otherwise start ten of them at once. queueWaitMs still means something,
// just something else: waiting for memory rather than for a shared global.
let renderQueue: Promise<unknown> = Promise.resolve();

// Long enough that a slow render on a loaded box does not cry wolf, short
// enough to beat the digest's weekly cadence by a wide margin.
export const LANE_STALL_MS = 30_000;

/**
 * Names the render holding the lane, 30s before RENDER_TIMEOUT_MS kills it.
 * Both exist because they answer different questions: this one says which
 * render and which queue while it is still happening, in time for someone to
 * look, and the timeout says the process got itself unstuck without them.
 *
 * Reports rather than intervenes. Returns the cancel function.
 */
export function watchForLaneStall(fields: Record<string, unknown>): () => void {
  const timer = setTimeout(() => {
    logger.error(
      { ...fields, stalledForMs: LANE_STALL_MS },
      'Chart render still holds the serialized lane; every later render is blocked behind it',
    );
  }, LANE_STALL_MS);
  // A watchdog should never be the reason a process stays up.
  timer.unref();
  return () => clearTimeout(timer);
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Twice LANE_STALL_MS on purpose: the alarm fires first and names the render,
// and a render still holding the lane 30s after that was not slow, it was
// stuck. The number is unmeasured, because no chart has rendered in production
// yet. Revisit once a real Sunday reports renderMs.
export const RENDER_TIMEOUT_MS = 2 * LANE_STALL_MS;

// Production runs dist/index.js and the compiled worker is the sibling .js.
// Under vitest and tsx this file is .ts under src/, and the worker still has to
// be the compiled artifact: a worker's module graph is resolved by plain Node,
// which cannot read this repo's .js-specifier-for-a-.tsx-file convention or the
// tsconfig jsx setting. Pointing both at dist is what keeps the tests on the
// bytes production runs, and is why the test script builds first.
function workerEntry(): URL {
  const here = import.meta.url;
  return new URL('./renderWorker.js', here.endsWith('.js') ? here : here.replace('/src/', '/dist/'));
}

/** Exported so a test can drive the timeout without waiting a minute for it. */
export function runInWorker(
  params: ChartRenderInput & { width?: number; height?: number },
  timeoutMs: number = RENDER_TIMEOUT_MS,
): Promise<RenderOutcome> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(workerEntry(), { workerData: params });
    } catch (err) {
      resolve(failed('worker', 'Chart render worker failed to start, sending text-only', { err }));
      return;
    }

    const settle = (outcome: RenderOutcome) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };

    // The reason this spawns a thread at all. Terminating takes the worker's
    // globalThis with it, so a render that hangs inside act() cannot leave a
    // half-installed jsdom shim for the next render to inherit. In-process there
    // was no way to abandon one: the finally that removes the shim never runs,
    // and racing act() frees the lane but leaves the orphan alive to touch the
    // next render's globals.
    const timer = setTimeout(() => {
      settle(
        failed('timeout', 'Chart render exceeded its budget and was killed, sending text-only', {
          timeoutMs,
        }),
      );
    }, timeoutMs);
    timer.unref();

    // structuredClone does not preserve the Buffer subclass, so a png posted
    // from the worker arrives as a plain Uint8Array. redis.set and nodemailer's
    // attachment `content` both want a Buffer, and the old in-process return
    // was one, so re-wrap rather than quietly change the contract. Buffer.from
    // on a Uint8Array copies, which is fine at 80KB and once a week.
    worker.once('message', (outcome: RenderOutcome) =>
      settle(outcome.ok ? { ok: true, png: Buffer.from(outcome.png) } : outcome),
    );
    worker.once('error', (err) =>
      settle(failed('worker', 'Chart render worker threw, sending text-only', { err })),
    );
    // A no-op on the normal path, where message already settled the promise. It
    // matters when the thread dies without posting, which is otherwise the one
    // way this never resolves.
    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(
          failed('worker', 'Chart render worker exited without a result, sending text-only', { code }),
        );
      }
    });
  });
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
  const enqueuedAt = Date.now();
  const logFields = { ...context, chartKind: params.chartKind };

  return serialize(async () => {
    // Two numbers, not one. The old single duration was captured before
    // serialize(), so it folded lane wait into render time and an operator
    // could not tell a contended lane from a slow render. The fixes for those
    // differ: one is scheduling, the other is the pipeline itself.
    const renderStartedAt = Date.now();
    const queueWaitMs = renderStartedAt - enqueuedAt;
    const timings = () => ({ queueWaitMs, renderMs: Date.now() - renderStartedAt });
    const stopStallWatch = watchForLaneStall({ ...logFields, queueWaitMs });
    try {
      const outcome = await runInWorker(params);
      if (!outcome.ok) {
        logger.warn({ ...logFields, ...outcome.fields, ...timings() }, outcome.message);
        return null;
      }

      logger.info({ ...logFields, ...timings(), bytes: outcome.png.length }, 'Chart rendered');
      return outcome.png;
    } finally {
      // Never reached when the render hangs, which is exactly when the
      // watchdog should be left to fire.
      stopStallWatch();
    }
  });
}
