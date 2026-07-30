import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../../lib/logger.js';
import { AppError, CostBudgetExceededError } from '../../lib/appError.js';
import { computeCost, exceedsBudget } from '../../lib/cost.js';
import type { PromptInput } from '../aiInterpretation/provider.js';
import { converseWithTools, type ToolCall, type ToolResultInput } from '../aiInterpretation/claudeClient.js';
import {
  GET_METRIC_WITH_TREND_TOOL,
  COMPARE_TO_PRIOR_PERIODS_TOOL,
  TREND_CARRYING_STAT_TYPES,
  getMetricWithTrend,
  compareToPriorPeriods,
  type ToolContext,
  type GetMetricWithTrendInput,
  type CompareToPriorPeriodsInput,
  type TrendCarryingStatType,
} from './interpretationTools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirrors assembly.ts's loadTemplate: a missing prompt file is a config
// error, not an uncaught ENOENT at module load.
function loadSystemPrompt(): string {
  const path = resolve(__dirname, 'config', 'prompt-templates', 'qa-loop-system.md');
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    throw new AppError(`Q&A loop system prompt missing: tried ${path}`, 'CONFIG_ERROR', 500, err);
  }
}

const SYSTEM_PROMPT = loadSystemPrompt();

// NFR-13.3. One further no-tools turn always follows the cap (or a cost
// trip) so the model still produces a final answer instead of the loop
// just cutting off mid-tool-call.
export const MAX_TOOL_TURNS = 5;

// Bounds real DB work within a single turn independent of the turn cap --
// nothing stops the model from returning many tool_use blocks in one
// response. Every call still gets an answering tool_result, skipped or not,
// the API requires one per tool_use block in the prior assistant turn.
export const MAX_TOOL_CALLS_PER_TURN = 6;

const TOOLS = [GET_METRIC_WITH_TREND_TOOL, COMPARE_TO_PRIOR_PERIODS_TOOL];

export type QaTermination = 'answered' | 'turn-cap' | 'cost-exceeded';

export interface QaToolResult {
  name: string;
  input: unknown;
  output: unknown;
}

export interface QaLoopResult {
  answer: string;
  toolResults: QaToolResult[];
  termination: QaTermination;
  turnCount: number;
}

function isTrendCarryingStatType(value: unknown): value is TrendCarryingStatType {
  return typeof value === 'string' && (TREND_CARRYING_STAT_TYPES as readonly string[]).includes(value);
}

// Mirrors proposals.ts's logRejectedInput: truncated so raw model output
// never lands in logs at full length. JSON.stringify returns undefined (the
// value, not the string) for undefined/function/symbol input, so that needs
// its own fallback before .slice can run.
function logRejectedInput(input: unknown, msg: string): void {
  const serialized = JSON.stringify(input) ?? String(input);
  logger.warn({ input: serialized.slice(0, 200) }, msg);
}

function validateGetMetricWithTrendInput(input: unknown): GetMetricWithTrendInput | null {
  if (typeof input !== 'object' || input === null) {
    logRejectedInput(input, 'get_metric_with_trend call had a non-object input');
    return null;
  }

  const { statType, category } = input as Record<string, unknown>;
  if (!isTrendCarryingStatType(statType)) {
    logRejectedInput(input, 'get_metric_with_trend call had an invalid statType');
    return null;
  }
  if (category !== undefined && typeof category !== 'string') {
    logRejectedInput(input, 'get_metric_with_trend call had a non-string category');
    return null;
  }

  return { statType, category };
}

function validateCompareToPriorPeriodsInput(input: unknown): CompareToPriorPeriodsInput | null {
  if (typeof input !== 'object' || input === null) {
    logRejectedInput(input, 'compare_to_prior_periods call had a non-object input');
    return null;
  }

  const { statType, category, periodsBack } = input as Record<string, unknown>;
  if (!isTrendCarryingStatType(statType)) {
    logRejectedInput(input, 'compare_to_prior_periods call had an invalid statType');
    return null;
  }
  if (category !== undefined && typeof category !== 'string') {
    logRejectedInput(input, 'compare_to_prior_periods call had a non-string category');
    return null;
  }
  if (periodsBack !== undefined && typeof periodsBack !== 'number') {
    logRejectedInput(input, 'compare_to_prior_periods call had a non-number periodsBack');
    return null;
  }

  return { statType, category, periodsBack };
}

type DispatchOutcome = { ok: true; output: unknown } | { ok: false };

// call.input is unknown, the SDK doesn't validate tool-input shape against
// our schema, so every call gets validated before it reaches a real query.
//
// The model still only ever sees the stat (or null) for a miss -- the
// not_found/suppressed distinction interpretationTools.ts now carries isn't
// wired into the prompt yet, so a suppressed lookup is logged for
// observability and otherwise collapses to null the same as a genuine miss.
async function dispatchToolCall(call: ToolCall, ctx: ToolContext): Promise<DispatchOutcome> {
  if (call.name === GET_METRIC_WITH_TREND_TOOL.name) {
    const input = validateGetMetricWithTrendInput(call.input);
    if (!input) return { ok: false };
    const result = await getMetricWithTrend(input, ctx);
    if (!result.found && result.reason === 'suppressed') {
      logger.info({ toolName: call.name, orgId: ctx.orgId, datasetId: ctx.datasetId }, 'Q&A tool result suppressed by an active correction');
    }
    return { ok: true, output: result.found ? result.stat : null };
  }

  if (call.name === COMPARE_TO_PRIOR_PERIODS_TOOL.name) {
    const input = validateCompareToPriorPeriodsInput(call.input);
    if (!input) return { ok: false };
    const result = await compareToPriorPeriods(input, ctx);
    if (!result.found) {
      if (result.reason === 'suppressed') {
        logger.info({ toolName: call.name, orgId: ctx.orgId, datasetId: ctx.datasetId }, 'Q&A tool result suppressed by an active correction');
      }
      return { ok: true, output: null };
    }
    return {
      ok: true,
      output: result.hasHistory
        ? { current: result.current, hasHistory: true, priorPeriods: result.priorPeriods }
        : { current: result.current, hasHistory: false },
    };
  }

  logger.warn({ toolName: call.name }, 'Q&A loop received an unrecognized tool call');
  return { ok: false };
}

// Bounded, cost-metered tool-calling conversation with the model, answering
// one question. Doesn't wire a route and doesn't build the final
// citation-bearing, advisory-voice answer, both are later stories, this just
// runs the loop and hands back the raw text and tool outputs the model used.
export async function runQaLoop(question: string, ctx: ToolContext, signal?: AbortSignal): Promise<QaLoopResult> {
  const input: PromptInput = { system: SYSTEM_PROMPT, user: question };

  let state: unknown = null;
  let toolResultInputs: ToolResultInput[] = [];
  let totalCost = 0;
  let turnCount = 0;
  let forcedTermination: QaTermination | null = null;
  const toolResults: QaToolResult[] = [];

  for (;;) {
    turnCount++;
    const tools = forcedTermination ? [] : TOOLS;

    let turn;
    try {
      turn = await converseWithTools(state, input, tools, toolResultInputs, signal);
    } catch (err) {
      // A single anomalously expensive turn trips claudeClient's own
      // per-call gate before the loop's cumulative check ever runs. Treat it
      // the same as tripping the cumulative check: one retry with no tools
      // to force a text answer from what's already been gathered. Only once
      // -- if the forced retry itself throws, there's nothing left to force.
      if (err instanceof CostBudgetExceededError && !forcedTermination) {
        forcedTermination = 'cost-exceeded';
        continue;
      }
      throw err;
    }
    state = turn.state;

    const cost = computeCost({ input_tokens: turn.usage.inputTokens, output_tokens: turn.usage.outputTokens });
    if (cost !== null) totalCost += cost;

    if (turn.toolCalls.length === 0) {
      return { answer: turn.text, toolResults, termination: forcedTermination ?? 'answered', turnCount };
    }

    toolResultInputs = [];
    for (const [i, call] of turn.toolCalls.entries()) {
      if (i >= MAX_TOOL_CALLS_PER_TURN) {
        logger.warn({ toolName: call.name }, 'Q&A loop turn exceeded the per-turn tool call cap, remainder skipped');
        toolResultInputs.push({ toolCallId: call.id, output: { error: 'tool call skipped, per-turn call limit reached' }, isError: true });
        continue;
      }
      const outcome = await dispatchToolCall(call, ctx);
      if (outcome.ok) {
        toolResults.push({ name: call.name, input: call.input, output: outcome.output });
        toolResultInputs.push({ toolCallId: call.id, output: outcome.output });
      } else {
        toolResultInputs.push({ toolCallId: call.id, output: { error: 'tool call rejected' }, isError: true });
      }
    }

    // Cost checked against the per-turn average, not the raw sum -- exceedsBudget's
    // cap is calibrated for one call, and summing several ordinary turns would
    // otherwise trip it well before the turn cap. Checked ahead of the turn cap
    // so a turn that trips both reports the more informative 'cost-exceeded'.
    if (exceedsBudget(totalCost / turnCount).exceeded) {
      forcedTermination = 'cost-exceeded';
    } else if (turnCount >= MAX_TOOL_TURNS) {
      forcedTermination = 'turn-cap';
    }
  }
}
