import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import { sanitizeToolResultContent } from './anthropicToolResultContent.js';

describe('sanitizeToolResultContent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes ordinary output without warnings', () => {
    expect(sanitizeToolResultContent({ ok: true })).toBe('{"ok":true}');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('removes unsafe format characters but preserves joiners', () => {
    expect(sanitizeToolResultContent(`a\u202eb\u200dc`)).toBe('"ab‍c"');
    expect(mockWarn).toHaveBeenCalledWith(
      { removedCount: 1 },
      'Tool result content had unsafe code points stripped before re-entering the conversation',
    );
  });

  it('caps oversized output with the truncation marker', () => {
    const result = sanitizeToolResultContent('x'.repeat(5000));

    expect(result).toHaveLength(4000);
    expect(result.endsWith('... [truncated]')).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(
      { preTruncationLength: 5002, cap: 4000 },
      'Tool result content exceeded the length cap and was truncated before re-entering the conversation',
    );
  });

  it('does not leave a lone surrogate at the truncation boundary', () => {
    const markerLength = '... [truncated]'.length;
    const cutLength = 4000 - markerLength;
    const prefixLength = cutLength - 2;
    const result = sanitizeToolResultContent(`${'x'.repeat(prefixLength)}😀${'x'.repeat(100)}`);

    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(result.endsWith('... [truncated]')).toBe(true);
  });
});
