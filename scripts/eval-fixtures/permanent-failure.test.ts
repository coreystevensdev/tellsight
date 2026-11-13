import { describe, it, expect } from 'vitest';

import { isPermanentUpstreamFailure } from './permanent-failure.js';

describe('isPermanentUpstreamFailure', () => {
  it('is true for the shape mapAnthropicError throws on a 400 or 401', () => {
    const err = Object.assign(new Error('External service error: Claude API'), {
      details: {
        originalError: '400 invalid_request_error: credit balance too low',
        permanent: true,
      },
    });
    expect(isPermanentUpstreamFailure(err)).toBe(true);
  });

  it('is false for a timed-out call, which is the case worth retrying', () => {
    const err = Object.assign(new Error('External service error: Claude API'), {
      details: { originalError: 'Request timed out.', permanent: false },
    });
    expect(isPermanentUpstreamFailure(err)).toBe(false);
  });

  it('is false when details carry no flag, so an unknown error keeps the old behaviour', () => {
    // Anything that predates the flag must not start aborting runs.
    const err = Object.assign(new Error('boom'), { details: { originalError: 'boom' } });
    expect(isPermanentUpstreamFailure(err)).toBe(false);
  });

  it('is false for errors with no details at all, and for non-errors', () => {
    expect(isPermanentUpstreamFailure(new Error('plain'))).toBe(false);
    expect(isPermanentUpstreamFailure(null)).toBe(false);
    expect(isPermanentUpstreamFailure(undefined)).toBe(false);
    expect(isPermanentUpstreamFailure('a string')).toBe(false);
  });

  it('does not treat a truthy non-true value as permanent', () => {
    const err = Object.assign(new Error('x'), { details: { permanent: 'yes' } });
    expect(isPermanentUpstreamFailure(err)).toBe(false);
  });
});
