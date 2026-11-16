import { parentPort, workerData } from 'node:worker_threads';

import { renderToPng } from './renderPipeline.js';
import type { ChartRenderInput } from './renderPipeline.js';

// A worker thread owns its own globalThis, which is the whole reason this file
// exists. renderSvgString installs the jsdom shim onto it and removes it in a
// finally that a hung render never reaches, so in-process there was no way to
// abandon a render without leaving another render's window behind. Here the
// shim dies with the thread, which is what makes terminate() a real recovery
// rather than trading a loud stall for silent corruption (DW-277).
//
// Nothing is logged here, and renderPipeline imports no logger: the parent owns
// the log line, and a thread that only turns numbers into a PNG should not need
// a valid environment to start.
const outcome = await renderToPng(
  workerData as ChartRenderInput & { width?: number; height?: number },
);

parentPort?.postMessage(outcome);
