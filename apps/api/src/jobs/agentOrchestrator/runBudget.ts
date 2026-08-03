import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';

const RUN_SPEND_TTL_SECONDS = 86_400;

function runSpendKey(correlationId: string): string {
  return `agent-orchestrator:run-spend:${correlationId}`;
}

// Run-scoped spend accumulator shared by the orchestrator and evaluate-org
// jobs. Both are decoupled BullMQ workers, not one in-process loop, so a
// local variable (qaLoop.ts's totalCost) can't span them -- this is the
// cross-job equivalent, keyed by the run's correlationId.
//
// Every call fails open: a Redis blip must not block or crash the nightly
// run, so an error here is logged and treated as "nothing recorded" /
// "not exceeded" rather than thrown.
export async function recordRunSpend(correlationId: string, cost: number): Promise<void> {
  const key = runSpendKey(correlationId);
  try {
    // Pipelined as one MULTI/EXEC so a crash between the increment and the
    // TTL can't happen -- two separate awaited commands left a window where
    // the key survives with no expiry if the process died in between.
    await redis.multi().incrbyfloat(key, cost).expire(key, RUN_SPEND_TTL_SECONDS).exec();
  } catch (err) {
    logger.warn({ err, correlationId }, 'Failed to record agent run spend, continuing uncapped for this call');
  }
}

export async function hasExceededRunBudget(correlationId: string): Promise<boolean> {
  const key = runSpendKey(correlationId);
  try {
    const raw = await redis.get(key);
    const spend = raw === null ? 0 : Number(raw);
    if (Number.isNaN(spend)) {
      logger.warn({ correlationId, raw }, 'Agent run spend key held a non-numeric value, proceeding as if under budget');
      return false;
    }
    return spend > env.AGENT_RUN_COST_CEILING_USD;
  } catch (err) {
    logger.warn({ err, correlationId }, 'Failed to read agent run spend, proceeding as if under budget');
    return false;
  }
}
