import type { BusinessProfile } from 'shared/types';
import { deriveDedupKey, FINDING_KINDS, type AgentProposal, type FindingKind } from 'shared/agent';

import { logger } from '../../lib/logger.js';
import { generateWithTools, type ToolDefinition } from '../aiInterpretation/claudeClient.js';
import { assemblePrompt } from './assembly.js';
import { statInstanceId } from './computation.js';
import { validateProposalCandidate } from './parseProposals.js';
import type { ScoredInsight } from './types.js';

const PROMPT_VERSION = 'v1-agent';

// Matches the "at most 5" instruction in v1-agent-system.md's Volume section.
const MAX_PROPOSALS = 5;

const SEVERITY_RANK: Record<AgentProposal['severity'], number> = {
  critical: 3,
  warning: 2,
  notice: 1,
  info: 0,
};

// Same ordering the prompt asks the model to self-apply ("keep the
// highest-severity ones and those with the strongest evidence support"),
// enforced in code since the model's own count isn't guaranteed to hold.
function rankProposals(proposals: AgentProposal[]): AgentProposal[] {
  return [...proposals].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence,
  );
}

const RECORD_PROPOSAL_TOOL: ToolDefinition = {
  name: 'record_proposal',
  description:
    "Record one finding worth the business owner's attention. Call once per genuine finding, or not at all when nothing in the stats is worth flagging.",
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...FINDING_KINDS] },
      severity: { type: 'string', enum: ['info', 'notice', 'warning', 'critical'] },
      title: { type: 'string', description: 'Plain text, max 120 characters, states the finding not the genre.' },
      explanation: { type: 'string', description: '1-3 sentences, what the data shows with specific numbers, advisory not directive.' },
      recommendation: { type: 'string', description: '1 sentence, advisory framing only, never "you should".' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'The bare stat id from inside each [cite: id] token that backs this finding, e.g. for "...[cite: 1:trend:Sales:0]" the evidence entry is 1:trend:Sales:0, not the brackets and not the word cite.',
      },
      subject: {
        type: 'string',
        description:
          'A short, stable label for what the finding is about (a category name, "runway", "margin") so the same ongoing concern produces the same identity across runs. No raw values or dates.',
      },
      facet: {
        type: 'string',
        description:
          'Optional coarse bucket that should change when the finding materially worsens or improves (severity tier, direction). Omit if there is no natural bucket.',
      },
      action: {
        type: 'object',
        description:
          'Omit for purely informational findings. Only include for a specific action worth taking -- notify, createNote, and flagInvoice are non-mutating flags for a human to review; reclassify writes back to the transaction record, so use it only with high confidence.',
        properties: {
          type: { type: 'string', enum: ['notify', 'createNote', 'flagInvoice', 'reclassify'] },
          targetRef: { type: 'string', description: 'Internal record id, never raw data.' },
          estimatedImpact: {
            type: 'object',
            properties: {
              amount: { type: 'number', minimum: 0 },
              currency: {
                type: 'string',
                pattern: '^[A-Z]{3}$',
                description: 'ISO 4217 currency code, three uppercase letters, e.g. USD.',
              },
            },
            required: ['amount', 'currency'],
          },
        },
        required: ['type', 'targetRef'],
      },
    },
    required: ['kind', 'severity', 'title', 'explanation', 'recommendation', 'confidence', 'evidence', 'subject'],
  },
};

// ISO 8601 week-numbering year and week ("2026-W26"), matching the format
// example in proposal.ts's `period` field comment. No date library in this
// repo for one call site, this is the standard Thursday-decides-the-week
// algorithm. Nothing downstream parses this format today, it only needs to
// be a stable, non-empty string.
function currentPeriod(now: Date): string {
  const thursday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (thursday.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  thursday.setUTCDate(thursday.getUTCDate() - dayNum + 3);

  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const firstThursdayOffset = (4 - (yearStart.getUTCDay() || 7) + 7) % 7;
  yearStart.setUTCDate(yearStart.getUTCDate() + firstThursdayOffset);

  const week = 1 + Math.round((thursday.getTime() - yearStart.getTime()) / (7 * 86_400_000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isFindingKind(value: string): value is FindingKind {
  return (FINDING_KINDS as readonly string[]).includes(value);
}

// Tool-calling models commonly emit `null` for an optional field they chose
// to skip, even though the schema only ever asked for a string. Truncated to
// keep raw model output out of logs at any real length.
function logRejectedInput(input: unknown, msg: string): void {
  logger.warn({ input: JSON.stringify(input).slice(0, 200) }, msg);
}

// call.input is unknown, the SDK doesn't validate tool-input shape against
// our schema. Pulls the dedup-identity fields (subject, facet) out before
// deriving dedupKey, everything else passes through untouched for
// validateProposalCandidate to check against agentProposalSchema.
function buildCandidate(input: unknown, period: string): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null) {
    logRejectedInput(input, 'record_proposal call had a non-object input');
    return null;
  }

  const { subject, facet: rawFacet, kind, ...rest } = input as Record<string, unknown>;
  const facet = rawFacet === null ? undefined : rawFacet;

  if (typeof kind !== 'string' || !isFindingKind(kind)) {
    logRejectedInput(input, 'record_proposal call had an invalid kind');
    return null;
  }
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    logRejectedInput(input, 'record_proposal call missing a subject for dedup');
    return null;
  }
  if (facet !== undefined && typeof facet !== 'string') {
    logRejectedInput(input, 'record_proposal call had a non-string facet');
    return null;
  }
  // A whitespace-only or empty facet is the same as "no facet", don't let it
  // produce a dedup bucket distinct from the default one deriveDedupKey falls
  // back to.
  const trimmedFacet = facet?.trim();
  const normalizedFacet = trimmedFacet === '' ? undefined : trimmedFacet;

  return {
    ...rest,
    kind,
    dedupKey: deriveDedupKey({ kind, subject: subject.trim(), facet: normalizedFacet }),
    period,
  };
}

// First real caller of generateTool/generateWithTools: turns curated insights
// into validated AgentProposals via the record_proposal tool. Directly
// callable and tested here, not wired into any job, cron, or route yet --
// that orchestration is separate work.
export async function generateProposals(
  insights: ScoredInsight[],
  datasetId: number,
  businessProfile?: BusinessProfile | null,
  now: Date = new Date(),
): Promise<AgentProposal[]> {
  const { system, user } = assemblePrompt(insights, datasetId, PROMPT_VERSION, businessProfile, now);
  const allowedStatIds = new Set(insights.map((insight) => statInstanceId(insight.stat, datasetId)));
  const period = currentPeriod(now);

  logger.info({ datasetId, insightCount: insights.length }, 'agent proposal generation started');

  const calls = await generateWithTools({ system, user }, [RECORD_PROPOSAL_TOOL]);

  const proposals: AgentProposal[] = [];
  for (const call of calls) {
    if (call.name !== RECORD_PROPOSAL_TOOL.name) {
      logger.warn({ toolName: call.name }, 'agent called an unrecognized tool');
      continue;
    }

    const candidate = buildCandidate(call.input, period);
    if (!candidate) continue;

    const proposal = validateProposalCandidate(candidate, allowedStatIds);
    if (proposal) proposals.push(proposal);
  }

  // Rank before deduping so a same-key collision keeps the strongest call
  // (highest severity, then confidence), not just whichever the model emitted
  // first -- the same preference rankProposals already applies for the volume
  // cap below.
  const deduped: AgentProposal[] = [];
  const seenDedupKeys = new Set<string>();
  for (const proposal of rankProposals(proposals)) {
    if (seenDedupKeys.has(proposal.dedupKey)) {
      logger.info({ dedupKey: proposal.dedupKey }, 'agent proposal dropped: duplicate within batch');
      continue;
    }
    seenDedupKeys.add(proposal.dedupKey);
    deduped.push(proposal);
  }

  const capped = deduped.slice(0, MAX_PROPOSALS);

  logger.info(
    { datasetId, callCount: calls.length, proposalCount: capped.length, droppedForVolume: deduped.length - capped.length },
    'agent proposal generation complete',
  );

  return capped;
}
