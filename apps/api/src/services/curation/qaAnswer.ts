import { logger } from '../../lib/logger.js';
import { AI_DISCLAIMER, citeTagGlobal, citeTagCapture, citeClosingTagGlobal, citeTagEnclosedGlobal } from 'shared/constants';
import { BANNED_IMPERATIVES } from 'shared/agent';
import { GET_METRIC_WITH_TREND_TOOL, COMPARE_TO_PRIOR_PERIODS_TOOL } from './interpretationTools.js';
import type { QaLoopResult, QaTermination } from './qaLoop.js';
import type { IdentifiedStat } from './types.js';

export interface QaAnswer {
  answer: string;
  citedStatIds: string[];
  termination: QaTermination;
  turnCount: number;
}

// Reachable when a turn's response has zero text blocks (claudeClient.ts's
// ConversationTurn.text can be ''), e.g. a degenerate forced final turn.
// Without this, cite-stripping plus the disclaimer alone would ship a
// content-free answer with no signal to the caller that anything went wrong.
const NO_ANSWER_TEXT = "I wasn't able to put together an answer from your data for this question.";

// Mirrors proposal.ts's DIRECTIVE construction: word-boundary, case-insensitive,
// interior spaces tolerant so "you   should" or a line break still trips it.
// Unlike proposal.ts, escapes metacharacters first (legal-posture.ts's escapeRe
// pattern) -- today's BANNED_IMPERATIVES has none, but a future phrase might.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DIRECTIVE = new RegExp(
  `\\b(?:${BANNED_IMPERATIVES.map((p) => escapeRegExp(p).replace(/ /g, '\\s+')).join('|')})\\b`,
  'gi',
);

function isIdentifiedStat(value: unknown): value is IdentifiedStat {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

// get_metric_with_trend's output is IdentifiedStat | null; compare_to_prior_periods'
// nests it one level deeper at .current. Neither type is trustworthy at this point,
// .output is unknown on QaToolResult, so both get checked, not cast.
function extractStatId(name: string, output: unknown): string | null {
  if (name === GET_METRIC_WITH_TREND_TOOL.name) {
    return isIdentifiedStat(output) ? output.id : null;
  }
  if (name === COMPARE_TO_PRIOR_PERIODS_TOOL.name) {
    const current = (output as { current?: unknown } | null)?.current;
    return isIdentifiedStat(current) ? current.id : null;
  }
  return null;
}

function citableIds(toolResults: QaLoopResult['toolResults']): Set<string> {
  const ids = new Set<string>();
  for (const result of toolResults) {
    const id = extractStatId(result.name, result.output);
    if (id) ids.add(id);
  }
  return ids;
}

// Strip-not-throw, same convention as validator.ts's stripInvalidCiteRefs: a
// surviving valid tag is normalized to self-closing form, an orphaned closing
// tag is dropped unconditionally, and a bare tag (no id attribute) has nothing
// to check against allowedIds so it strips unconditionally too. The enclosed-span
// pass runs first so text between a non-self-closing tag and its </cite> never
// survives as literal prose.
function stripInvalidCites(text: string, allowedIds: Set<string>): { text: string; citedStatIds: string[] } {
  const cited = new Set<string>();
  for (const match of text.matchAll(citeTagCapture())) {
    if (allowedIds.has(match[1]!)) cited.add(match[1]!);
  }

  const stripped = text
    .replace(citeTagEnclosedGlobal(), (_full, id: string | undefined) =>
      id !== undefined && allowedIds.has(id) ? `<cite id="${id}"/>` : '',
    )
    .replace(citeClosingTagGlobal(), '')
    .replace(citeTagGlobal(), (full) => {
      const idMatch = full.match(/id="([^"]*)"/);
      if (!idMatch) return '';
      const id = idMatch[1]!;
      return allowedIds.has(id) ? `<cite id="${id}"/>` : '';
    });

  return { text: stripped, citedStatIds: [...cited] };
}

// Pure by design, matching assembly.ts's assemblePrompt: no I/O, no ToolContext.
// It only validates <cite> tokens against ids the loop's own tool calls already
// resolved, so it never needs to re-derive caller identity or re-run resolveCitation.
export function assembleQaAnswer(loopResult: QaLoopResult): QaAnswer {
  const allowedIds = citableIds(loopResult.toolResults);
  const { text, citedStatIds } = stripInvalidCites(loopResult.answer, allowedIds);

  const phrases = [...new Set([...text.matchAll(DIRECTIVE)].map((m) => m[0]))];
  if (phrases.length > 0) {
    logger.warn({ phrases }, 'Q&A answer contained banned imperative language');
  }

  // Guards against double-appending on the rare chance the model's own prose
  // already echoes the disclaimer verbatim; the "exactly once" guarantee
  // otherwise has no runtime backstop.
  const body = text.trim().length > 0 ? text : NO_ANSWER_TEXT;
  const answer = body.includes(AI_DISCLAIMER) ? body : `${body}\n\n${AI_DISCLAIMER}`;

  return {
    answer,
    citedStatIds,
    termination: loopResult.termination,
    turnCount: loopResult.turnCount,
  };
}
