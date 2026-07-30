import { Router, type Response } from 'express';
import { askQuestionSchema } from 'shared/schemas';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { requireUser } from '../lib/requireUser.js';
import { rateLimitAi } from '../middleware/rateLimiter.js';
import { register, deregister } from '../lib/activeStreams.js';
import { subscriptionsQueries } from '../db/queries/index.js';
import { withRlsContext } from '../lib/rls.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { runQaLoop } from '../services/curation/qaLoop.js';
import { assembleQaAnswer } from '../services/curation/qaAnswer.js';
import type { ToolContext } from '../services/curation/interpretationTools.js';
import { ValidationError } from '../lib/appError.js';
import { logger } from '../lib/logger.js';

export const qaRouter = Router();

qaRouter.post('/:datasetId', async (req, res: Response) => {
  const user = requireUser(req);
  const orgId = user.org_id;
  const userId = Number(user.sub);
  const rawId = Number(req.params.datasetId);

  if (!Number.isInteger(rawId) || rawId <= 0) {
    throw new ValidationError('Invalid datasetId');
  }

  const parsed = askQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid question',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const abortController = new AbortController();
  register(abortController);
  let clientDisconnected = false;
  // res.on('close'), not req.on('close'): express.json() has already fully
  // drained req's body stream by the time this handler runs, and Node fires
  // 'close' on a finished request stream almost immediately regardless of
  // whether the client is still connected. res only closes early when the
  // underlying connection actually drops before a response is written.
  // Registered before the entitlement/rate-limit checks below (not just
  // around the loop call) so a disconnect during either of those is caught
  // too, not only one during runQaLoop.
  res.on('close', () => {
    if (res.writableEnded) return;
    clientDisconnected = true;
    deregister(abortController);
    abortController.abort();
  });

  // Hard gate, not subscriptionGate's annotate-not-block posture: a question
  // the org isn't entitled to ask has no partial/preview shape to fall back to.
  // withRlsContext can throw before getAgentEnabled's own fail-closed catch
  // ever runs (bad orgId, dropped connection during SET LOCAL). Catching it
  // here routes the failure through the fail-closed path below instead of
  // an unhandled rejection and a raw 500.
  let agentEnabled: boolean;
  try {
    agentEnabled = await withRlsContext(orgId, user.isAdmin, (tx) =>
      subscriptionsQueries.getAgentEnabled(orgId, tx),
    );
  } catch (err) {
    logger.warn({ orgId, err: (err as Error).message }, 'agent entitlement lookup failed, defaulting to disabled');
    agentEnabled = false;
  }
  if (clientDisconnected) return;
  if (!agentEnabled) {
    deregister(abortController);
    res.status(403).json({
      error: { code: 'AGENT_TIER_REQUIRED', message: 'Ask a question requires the Agent tier' },
    });
    return;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      // rateLimitAi fails open on unexpected errors (calls next()) and on an
      // actual 429 responds via res directly instead of calling next -- this
      // callback never fires on that path. res.once('finish'/'close') below
      // is the fallback that unblocks this promise for the 429 and
      // client-disconnect branches.
      rateLimitAi(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
      res.once('finish', resolve);
      res.once('close', resolve);
    });
  } catch (err) {
    deregister(abortController);
    throw err;
  }
  if (res.headersSent || clientDisconnected) {
    deregister(abortController);
    return;
  }

  // Explicit construction per interpretationTools.ts's doc comment, never
  // passed through from the request object directly. `now` is captured once
  // here so every tool call this turn makes computes against one snapshot.
  const ctx: ToolContext = { orgId, isAdmin: user.isAdmin, datasetId: rawId, now: new Date() };

  const startedAt = Date.now();
  trackEvent(orgId, userId, ANALYTICS_EVENTS.QA_QUESTION_ASKED, { datasetId: rawId });

  let answer;
  try {
    const loopResult = await runQaLoop(parsed.data.question, ctx, abortController.signal);
    answer = assembleQaAnswer(loopResult);
  } catch (err) {
    deregister(abortController);
    // A plain AbortError is expected noise here, whether it came from the
    // client disconnecting or an app-wide abortAll() on shutdown -- don't
    // log it as a failure. Anything else (a genuine runQaLoop error that
    // happened to land in the same tick as a disconnect) still gets logged,
    // no question text in the log line, only the identifiers.
    const aborted = err instanceof Error && err.name === 'AbortError';
    if (!aborted) {
      logger.error({ orgId, datasetId: rawId, err }, 'qa loop failed');
    }
    trackEvent(orgId, userId, ANALYTICS_EVENTS.QA_QUESTION_FAILED, {
      datasetId: rawId,
      aborted,
      computationTimeMs: Date.now() - startedAt,
    });
    if (clientDisconnected) return;
    res.status(500).json({
      error: { code: 'QA_LOOP_FAILED', message: 'Failed to answer the question' },
    });
    return;
  }

  deregister(abortController);

  trackEvent(orgId, userId, ANALYTICS_EVENTS.QA_QUESTION_COMPLETED, {
    datasetId: rawId,
    termination: answer.termination,
    turnCount: answer.turnCount,
    citedStatCount: answer.citedStatIds.length,
    computationTimeMs: Date.now() - startedAt,
  });

  if (clientDisconnected) return;

  res.json({ data: answer });
});
