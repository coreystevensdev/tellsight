import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { AiSummaryCard, truncateAtWordBoundary } from './AiSummaryCard';
import { AiSummaryErrorBoundary } from './AiSummaryErrorBoundary';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// ShareMenu imports useIsMobile which calls matchMedia at module scope
vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const mockUseAiStream = vi.fn();

vi.mock('@/lib/hooks/useAiStream', () => ({
  useAiStream: (...args: unknown[]) => mockUseAiStream(...args),
  stripStatTags: (raw: string) => raw.replace(/<stat\s+id="\w+"\s*\/>/g, ''),
}));

const mockTrackClientEvent = vi.fn();
vi.mock('@/lib/analytics', () => ({
  trackClientEvent: (...args: unknown[]) => mockTrackClientEvent(...args),
}));

afterEach(cleanup);

function defaultHookReturn(overrides = {}) {
  return {
    status: 'idle',
    text: '',
    rawText: '',
    metadata: null,
    error: null,
    code: null,
    retryable: false,
    retryCount: 0,
    maxRetriesReached: false,
    start: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

describe('AiSummaryCard', () => {
  it('renders nothing when idle and no cached content', () => {
    mockUseAiStream.mockReturnValue(defaultHookReturn());

    const { container } = render(<AiSummaryCard datasetId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders cached content immediately without streaming', () => {
    mockUseAiStream.mockReturnValue(defaultHookReturn());

    render(<AiSummaryCard datasetId={null} cachedContent="Pre-generated summary" />);
    expect(screen.getByText('Pre-generated summary')).toBeTruthy();
    expect(mockUseAiStream).toHaveBeenCalledWith(null);
  });

  it('shows skeleton with analyzing label when connecting', () => {
    mockUseAiStream.mockReturnValue(defaultHookReturn({ status: 'connecting' }));

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText('Analyzing your data...')).toBeTruthy();
  });

  it('shows streaming text with cursor', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'streaming', text: 'Revenue is growing' }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText('Revenue is growing')).toBeTruthy();
    expect(screen.getByText('▋')).toBeTruthy();
  });

  it('shows completed text with post-completion footer', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'done', text: 'Full analysis complete.' }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText('Full analysis complete.')).toBeTruthy();
    expect(screen.getByText(/How I reached this conclusion/)).toBeTruthy();
    expect(screen.queryByText('▋')).toBeNull();
  });

  // -- timeout state --

  it('renders partial text with timeout message', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'timeout', text: 'Partial analysis here' }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText('Partial analysis here')).toBeTruthy();
    expect(
      screen.getByText('We focused on the most important findings to keep things quick.'),
    ).toBeTruthy();
  });

  it('renders post-completion footer in timeout state', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'timeout', text: 'partial' }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText(/How I reached this conclusion/)).toBeTruthy();
  });

  it('renders hr divider in timeout state', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'timeout', text: 'partial' }),
    );

    const { container } = render(<AiSummaryCard datasetId={42} />);
    expect(container.querySelector('hr')).toBeTruthy();
  });

  // -- error state --

  it('shows error state with Try again button when retryable', () => {
    const mockRetry = vi.fn();
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'error',
        error: 'AI service is temporarily unavailable.',
        code: 'AI_UNAVAILABLE',
        retryable: true,
        retry: mockRetry,
      }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText('AI service is temporarily unavailable.')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('shows user-friendly message based on error code', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'error',
        error: 'raw error',
        code: 'RATE_LIMITED',
        retryable: false,
      }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText(/Too many requests/)).toBeTruthy();
  });

  it('hides retry button when not retryable', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'error',
        error: 'auth fail',
        code: 'AI_AUTH_ERROR',
        retryable: false,
      }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('shows "Please try again later" when max retries reached', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'error',
        error: 'fail',
        code: 'AI_UNAVAILABLE',
        retryable: true,
        retryCount: 3,
        maxRetriesReached: true,
      }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.queryByText('Try again')).toBeNull();
    expect(screen.getByText('Please try again later.')).toBeTruthy();
  });

  it('calls retry when Try again is clicked', () => {
    const mockRetry = vi.fn();
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'error',
        error: 'fail',
        code: 'AI_UNAVAILABLE',
        retryable: true,
        retry: mockRetry,
      }),
    );

    render(<AiSummaryCard datasetId={42} />);
    const button = screen.getByRole('button', { name: 'Try again' });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      fireEvent.click(button);
    });

    expect(mockRetry).toHaveBeenCalledOnce();
  });

  it('shows reassurance message in error state', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'error',
        error: 'fail',
        retryable: true,
      }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText('Your data and charts are still available below.')).toBeTruthy();
  });

  // -- free_preview --

  it('renders preview text with blur overlay and UpgradeCta for free_preview', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'free_preview', text: 'Here is a preview of your analysis' }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.getByText('Here is a preview of your analysis')).toBeTruthy();
    expect(screen.getByText('Unlock full analysis')).toBeTruthy();
    expect(screen.getByLabelText(/upgrade to pro subscription/i)).toBeTruthy();
  });

  it('hides PostCompletionFooter in free_preview state', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'free_preview', text: 'preview' }),
    );

    render(<AiSummaryCard datasetId={42} />);
    expect(screen.queryByText(/How I reached this conclusion/)).toBeNull();
  });

  it('renders blurred placeholder text with aria-hidden', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'free_preview', text: 'preview' }),
    );

    const { container } = render(<AiSummaryCard datasetId={42} />);
    const blurredSection = container.querySelector('[aria-hidden="true"].relative');
    expect(blurredSection).toBeTruthy();
    expect(blurredSection!.querySelector('.blur-sm')).toBeTruthy();
  });

  it('truncates cached content for free tier and shows UpgradeCta', () => {
    mockUseAiStream.mockReturnValue(defaultHookReturn());
    const longContent = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');

    render(<AiSummaryCard datasetId={null} cachedContent={longContent} tier="free" />);
    expect(screen.getByText('Unlock full analysis')).toBeTruthy();
    expect(screen.queryByText(/How I reached this conclusion/)).toBeNull();
  });

  it('renders full cached content for pro tier', () => {
    mockUseAiStream.mockReturnValue(defaultHookReturn());
    const content = 'Full pro analysis content.';

    render(<AiSummaryCard datasetId={null} cachedContent={content} tier="pro" />);
    expect(screen.getByText('Full pro analysis content.')).toBeTruthy();
    expect(screen.getByText(/How I reached this conclusion/)).toBeTruthy();
    expect(screen.queryByText('Unlock full analysis')).toBeNull();
  });

  it('renders full cached content when no tier specified (anonymous)', () => {
    mockUseAiStream.mockReturnValue(defaultHookReturn());

    render(<AiSummaryCard datasetId={null} cachedContent="Seed summary for visitors" />);
    expect(screen.getByText('Seed summary for visitors')).toBeTruthy();
    expect(screen.getByText(/How I reached this conclusion/)).toBeTruthy();
    expect(screen.queryByText('Unlock full analysis')).toBeNull();
  });

  // -- accessibility --

  it('has correct accessibility attributes during streaming', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'streaming', text: 'Partial text' }),
    );

    render(<AiSummaryCard datasetId={42} />);

    const region = screen.getByRole('region', { name: 'AI business summary' });
    expect(region).toBeTruthy();

    const liveRegion = region.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeTruthy();
    expect(liveRegion!.getAttribute('aria-busy')).toBe('true');
  });

  it('sets aria-busy false when done', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'done', text: 'Done text' }),
    );

    render(<AiSummaryCard datasetId={42} />);

    const region = screen.getByRole('region', { name: 'AI business summary' });
    const liveRegion = region.querySelector('[aria-live="polite"]');
    expect(liveRegion!.getAttribute('aria-busy')).toBe('false');
  });

  it('uses aria-live assertive on error state', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'error',
        error: 'fail',
        retryable: true,
      }),
    );

    render(<AiSummaryCard datasetId={42} />);

    const region = screen.getByRole('region', { name: 'AI business summary' });
    const assertiveRegion = region.querySelector('[aria-live="assertive"]');
    expect(assertiveRegion).toBeTruthy();
  });

  // -- error boundary --

  it('error boundary catches render errors and shows fallback', () => {
    function Thrower(): never {
      throw new Error('render crash');
    }

    // suppress React error boundary console noise
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AiSummaryErrorBoundary className="mb-6">
        <Thrower />
      </AiSummaryErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong generating insights.')).toBeTruthy();
    expect(screen.getByText('Your data and charts are still available below.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();

    spy.mockRestore();
  });

  it('error boundary resets and re-renders children on Try again', () => {
    let shouldThrow = true;
    function MaybeThrower() {
      if (shouldThrow) throw new Error('boom');
      return <p>recovered</p>;
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AiSummaryErrorBoundary>
        <MaybeThrower />
      </AiSummaryErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong generating insights.')).toBeTruthy();

    shouldThrow = false;
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    expect(screen.getByText('recovered')).toBeTruthy();
    expect(screen.queryByText('Something went wrong generating insights.')).toBeNull();

    spy.mockRestore();
  });

  // -- reduced motion --

  it('renders streaming cursor with reduced-motion class', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'streaming', text: 'text' }),
    );

    const { container } = render(<AiSummaryCard datasetId={42} />);
    const cursor = container.querySelector('[aria-hidden="true"]');
    expect(cursor).toBeTruthy();
    expect(cursor!.className).toContain('motion-reduce:animate-none');
  });

  // -- transparency button --

  it('transparency button calls onToggleTransparency in done state', () => {
    const toggle = vi.fn();
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'done', text: 'analysis' }),
    );

    render(
      <AiSummaryCard datasetId={42} onToggleTransparency={toggle} transparencyOpen={false} />,
    );
    fireEvent.click(screen.getByText(/How I reached this conclusion/));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('transparency button has aria-expanded attribute', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'done', text: 'analysis' }),
    );

    render(
      <AiSummaryCard datasetId={42} onToggleTransparency={vi.fn()} transparencyOpen={true} />,
    );
    const btn = screen.getByText(/How I reached this conclusion/);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('transparency button works in timeout state', () => {
    const toggle = vi.fn();
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'timeout', text: 'partial' }),
    );

    render(
      <AiSummaryCard datasetId={42} onToggleTransparency={toggle} transparencyOpen={false} />,
    );
    fireEvent.click(screen.getByText(/How I reached this conclusion/));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('transparency button is disabled when no handler provided', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({ status: 'done', text: 'analysis' }),
    );

    render(<AiSummaryCard datasetId={42} />);
    const btn = screen.getByText(/How I reached this conclusion/);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  describe('stale banner', () => {
    it('does not render banner when cachedStaleAt is null', () => {
      mockUseAiStream.mockReturnValue(defaultHookReturn());

      render(<AiSummaryCard datasetId={42} cachedContent="Prior summary" cachedStaleAt={null} />);

      expect(screen.queryByText('Your data has been updated')).toBeNull();
      expect(screen.getByText('Prior summary')).toBeTruthy();
    });

    it('renders banner with Refresh button when cachedStaleAt is in the past', () => {
      mockUseAiStream.mockReturnValue(defaultHookReturn());
      const past = new Date(Date.now() - 60_000).toISOString();

      render(
        <AiSummaryCard datasetId={42} cachedContent="Prior summary" cachedStaleAt={past} />,
      );

      expect(screen.getByText('Your data has been updated')).toBeTruthy();
      expect(screen.getByRole('button', { name: /refresh insights/i })).toBeTruthy();
    });

    it('does not render banner when cachedStaleAt is in the future', () => {
      mockUseAiStream.mockReturnValue(defaultHookReturn());
      const future = new Date(Date.now() + 60_000).toISOString();

      render(
        <AiSummaryCard datasetId={42} cachedContent="Prior summary" cachedStaleAt={future} />,
      );

      expect(screen.queryByText('Your data has been updated')).toBeNull();
    });

    it('clicking Refresh triggers streaming path by dropping cached content', () => {
      mockUseAiStream.mockReturnValue(defaultHookReturn({ status: 'connecting' }));
      const past = new Date(Date.now() - 60_000).toISOString();

      render(
        <AiSummaryCard datasetId={42} cachedContent="Prior summary" cachedStaleAt={past} />,
      );

      // before click — cached content shown, stream hook called with null
      expect(screen.getByText('Prior summary')).toBeTruthy();
      expect(mockUseAiStream).toHaveBeenLastCalledWith(null);

      fireEvent.click(screen.getByRole('button', { name: /refresh insights/i }));

      // after click — skeleton renders, hook called with the real datasetId
      expect(mockUseAiStream).toHaveBeenLastCalledWith(42);
      expect(screen.queryByText('Your data has been updated')).toBeNull();
    });

    it('Refresh button is disabled when datasetId is null', () => {
      mockUseAiStream.mockReturnValue(defaultHookReturn());
      const past = new Date(Date.now() - 60_000).toISOString();

      render(
        <AiSummaryCard datasetId={null} cachedContent="Prior summary" cachedStaleAt={past} />,
      );

      const btn = screen.getByRole('button', { name: /refresh insights/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });
});

describe('truncateAtWordBoundary', () => {
  it('returns original text when under limit', () => {
    const result = truncateAtWordBoundary('hello world', 10);
    expect(result).toEqual({ preview: 'hello world', wasTruncated: false });
  });

  it('truncates at word boundary', () => {
    const text = 'one two three four five';
    const result = truncateAtWordBoundary(text, 3);
    expect(result).toEqual({ preview: 'one two three', wasTruncated: true });
  });

  it('handles exact word count', () => {
    const result = truncateAtWordBoundary('a b c', 3);
    expect(result).toEqual({ preview: 'a b c', wasTruncated: false });
  });

  it('handles empty string', () => {
    const result = truncateAtWordBoundary('', 150);
    expect(result).toEqual({ preview: '', wasTruncated: false });
  });
});

describe('AiSummaryCard chart bindings', () => {
  it('renders thumbnail next to a tagged paragraph in done state', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'done',
        text: 'Runway is 3.2 months  worth watching.\n\nAnother paragraph.',
        rawText: 'Runway is 3.2 months <stat id="runway"/> worth watching.\n\nAnother paragraph.',
      }),
    );

    render(
      <AiSummaryCard
        datasetId={1}
        cashHistory={[
          { balance: 12000, asOfDate: '2026-04-01T00:00:00Z' },
          { balance: 9500, asOfDate: '2026-03-01T00:00:00Z' },
        ]}
      />,
    );

    expect(
      screen.getByRole('button', { name: /open cash balance over time drill-down/i }),
    ).toBeInTheDocument();
  });

  it('opens drill-down sheet and fires insight.chart_opened analytics', () => {
    mockTrackClientEvent.mockClear();
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'done',
        text: 'Cash flow burning  this month.',
        rawText: 'Cash flow burning <stat id="cash_flow"/> this month.',
      }),
    );

    render(<AiSummaryCard datasetId={1} />);

    fireEvent.click(
      screen.getByRole('button', { name: /open revenue vs\. expenses drill-down/i }),
    );

    expect(mockTrackClientEvent).toHaveBeenCalledWith('insight.chart_opened', {
      statType: 'cash_flow',
      paragraphIndex: 0,
      viewport: 'desktop',
    });

    // sheet opens as a Radix dialog — assert the dialog is in the DOM and
    // the drill-down description text is present. Either check alone would
    // pass on the thumbnail alone; together they prove the sheet mounted.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByText(/drill-down view for the chart that backs the highlighted insight/i),
    ).toBeInTheDocument();
  });

  it('does not render bindings when status is still streaming', () => {
    mockUseAiStream.mockReturnValue(
      defaultHookReturn({
        status: 'streaming',
        text: 'Streaming text without bindings yet.',
        rawText: 'Streaming text <stat id="runway"/> not yet bound.',
      }),
    );

    render(<AiSummaryCard datasetId={1} />);

    expect(
      screen.queryByRole('button', { name: /open cash balance over time drill-down/i }),
    ).toBeNull();
  });

  it('strips raw stat tags from cached content before render', () => {
    mockUseAiStream.mockReturnValue(defaultHookReturn());

    render(
      <AiSummaryCard
        datasetId={1}
        cachedContent={'Cached prose <stat id="runway"/> done.\n\nNext paragraph.'}
        tier="pro"
      />,
    );

    // raw token must never reach the user
    expect(screen.queryByText(/<stat id="runway"\/>/)).toBeNull();
    // the surrounding prose still renders
    expect(screen.getByText(/Cached prose/i)).toBeInTheDocument();
  });
});
