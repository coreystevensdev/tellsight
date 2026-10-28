import { logger } from '../../lib/logger.js';

// Tool output round-trips through every remaining turn, so cap uploaded values
// and strip control/format characters before they compound in model context.
const MAX_TOOL_RESULT_CONTENT_LENGTH = 4000;
// Node 20+ supports Unicode set subtraction under the `v` flag; construction
// avoids TypeScript's es2024-only literal-regex flag check.
const UNSAFE_CODE_POINTS = new RegExp('[\\p{Cc}\\u2028\\u2029[\\p{Cf}--[\\u200c\\u200d]]]', 'gv');
const TRUNCATION_MARKER = '... [truncated]';

// Avoid leaving a lone high surrogate when a truncation boundary falls inside
// a UTF-16 pair.
function safeSlice(value: string, length: number): string {
  const lastCodeUnit = value.charCodeAt(length - 1);
  const cutsHighSurrogate = length > 0 && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
  return value.slice(0, cutsHighSurrogate ? length - 1 : length);
}

export function sanitizeToolResultContent(output: unknown): string {
  const raw = JSON.stringify(output) ?? String(output);
  const stripped = raw.replace(UNSAFE_CODE_POINTS, '');

  if (stripped.length !== raw.length) {
    logger.warn(
      { removedCount: raw.length - stripped.length },
      'Tool result content had unsafe code points stripped before re-entering the conversation',
    );
  }

  if (stripped.length <= MAX_TOOL_RESULT_CONTENT_LENGTH) return stripped;

  logger.warn(
    { preTruncationLength: stripped.length, cap: MAX_TOOL_RESULT_CONTENT_LENGTH },
    'Tool result content exceeded the length cap and was truncated before re-entering the conversation',
  );
  return (
    safeSlice(stripped, MAX_TOOL_RESULT_CONTENT_LENGTH - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}
