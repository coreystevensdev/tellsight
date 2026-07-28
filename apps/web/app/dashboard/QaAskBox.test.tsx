import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AI_DISCLAIMER } from 'shared/constants';
import { QaAskBox } from './QaAskBox';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// StatDetailSheet pulls in useIsMobile, which calls matchMedia at module scope.
vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const mockAsk = vi.fn();
const mockUseQaAnswer = vi.fn();
vi.mock('@/lib/hooks/useQaAnswer', () => ({
  useQaAnswer: (...args: unknown[]) => mockUseQaAnswer(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function defaultHookReturn(overrides = {}) {
  return {
    status: 'idle',
    answer: null,
    error: null,
    code: null,
    ask: mockAsk,
    ...overrides,
  };
}

describe('QaAskBox', () => {
  it('renders an input and a disabled Ask button when idle with no question typed', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn());

    render(<QaAskBox datasetId={7} />);

    expect(screen.getByPlaceholderText(/how did revenue trend/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });

  it('enables Ask once a question is typed and calls ask on click', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn());

    render(<QaAskBox datasetId={7} />);
    const input = screen.getByPlaceholderText(/how did revenue trend/i);
    fireEvent.change(input, { target: { value: 'How is my runway?' } });

    const button = screen.getByRole('button', { name: 'Ask' });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(mockAsk).toHaveBeenCalledWith('How is my runway?');
  });

  it('submits on Enter in the input', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn());

    render(<QaAskBox datasetId={7} />);
    const input = screen.getByPlaceholderText(/how did revenue trend/i);
    fireEvent.change(input, { target: { value: 'How is my runway?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockAsk).toHaveBeenCalledWith('How is my runway?');
  });

  it('does not submit on Enter while an IME composition is in progress (regression)', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn());

    render(<QaAskBox datasetId={7} />);
    const input = screen.getByPlaceholderText(/how did revenue trend/i);
    fireEvent.change(input, { target: { value: '日本語' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(mockAsk).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    expect(mockAsk).toHaveBeenCalledWith('日本語');
  });

  it('trims whitespace before calling ask and rejects a whitespace-only question', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn());

    render(<QaAskBox datasetId={7} />);
    const input = screen.getByPlaceholderText(/how did revenue trend/i);

    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();

    fireEvent.change(input, { target: { value: '  How is my runway?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(mockAsk).toHaveBeenCalledWith('How is my runway?');
  });

  it('disables the Ask button when datasetId is null', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn());

    render(<QaAskBox datasetId={null} />);
    const input = screen.getByPlaceholderText(/how did revenue trend/i);
    fireEvent.change(input, { target: { value: 'How is my runway?' } });

    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });

  it('shows a disabled input and a thinking spinner while asking', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn({ status: 'asking' }));

    render(<QaAskBox datasetId={7} />);

    expect(screen.getByText('Thinking...')).toBeTruthy();
    expect((screen.getByPlaceholderText(/how did revenue trend/i) as HTMLInputElement).disabled).toBe(true);
  });

  it('renders the locked state with an inline UpgradeCta, not the error state', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn({ status: 'locked' }));

    render(<QaAskBox datasetId={7} />);

    expect(screen.getByText('Unlock full analysis')).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('navigates to /billing when the locked UpgradeCta is clicked', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn({ status: 'locked' }));

    render(<QaAskBox datasetId={7} />);
    fireEvent.click(screen.getByRole('button', { name: /upgrade to pro subscription/i }));

    expect(mockPush).toHaveBeenCalledWith('/billing');
  });

  it('renders a distinct error state with a retry affordance, not the locked state', () => {
    mockUseQaAnswer.mockReturnValue(
      defaultHookReturn({ status: 'error', error: 'Failed to answer the question', code: 'QA_LOOP_FAILED' }),
    );

    render(<QaAskBox datasetId={7} />);

    expect(screen.getByText('Something went wrong answering that question.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Unlock full analysis')).toBeNull();
  });

  it('retries the same question when Try again is clicked', () => {
    mockUseQaAnswer.mockReturnValue(
      defaultHookReturn({ status: 'error', error: 'fail', code: 'QA_LOOP_FAILED' }),
    );

    render(<QaAskBox datasetId={7} />);
    const input = screen.getByPlaceholderText(/how did revenue trend/i);
    fireEvent.change(input, { target: { value: 'How is my runway?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(mockAsk).toHaveBeenCalledWith('How is my runway?');
  });

  it('renders the completed answer with the disclaimer exactly once', () => {
    mockUseQaAnswer.mockReturnValue(
      defaultHookReturn({
        status: 'answered',
        answer: {
          answer: 'Revenue grew 12% this quarter.\n\nAI-generated analysis, not financial advice. Verify with your accountant.',
          citedStatIds: [],
          termination: 'answered',
          turnCount: 1,
        },
      }),
    );

    const { container } = render(<QaAskBox datasetId={7} />);

    expect(container.textContent).toContain('Revenue grew 12% this quarter.');
    expect(
      screen.getAllByText('AI-generated analysis, not financial advice. Verify with your accountant.'),
    ).toHaveLength(1);
  });

  it('does not duplicate the disclaimer when it appears inline instead of as a trailing suffix', () => {
    mockUseQaAnswer.mockReturnValue(
      defaultHookReturn({
        status: 'answered',
        answer: {
          answer: `Revenue grew 12% this quarter. ${AI_DISCLAIMER} Ask again for more detail.`,
          citedStatIds: [],
          termination: 'answered',
          turnCount: 1,
        },
      }),
    );

    render(<QaAskBox datasetId={7} />);

    expect(screen.getAllByText(new RegExp(AI_DISCLAIMER.slice(0, 20)))).toHaveLength(1);
  });

  it('clears the question and any open citation sheet when the dataset changes', () => {
    mockUseQaAnswer.mockReturnValue(defaultHookReturn());

    const { rerender } = render(<QaAskBox datasetId={7} />);
    const input = screen.getByPlaceholderText(/how did revenue trend/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'How is my runway?' } });
    expect(input.value).toBe('How is my runway?');

    rerender(<QaAskBox datasetId={8} />);

    expect((screen.getByPlaceholderText(/how did revenue trend/i) as HTMLInputElement).value).toBe('');
  });

  it('renders a clickable citation marker that opens StatDetailSheet for the cited stat', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { statType: 'total', value: 5000, detail: { kind: 'formula', expression: '$5,000', terms: [] } },
        }),
    } as Response);

    mockUseQaAnswer.mockReturnValue(
      defaultHookReturn({
        status: 'answered',
        answer: {
          answer: 'Revenue hit $5,000<cite id="7:total:Sales:category"/> this quarter.\n\nAI-generated analysis, not financial advice. Verify with your accountant.',
          citedStatIds: ['7:total:Sales:category'],
          termination: 'answered',
          turnCount: 1,
        },
      }),
    );

    render(<QaAskBox datasetId={7} />);

    const marker = screen.getByRole('button', { name: /show how \$5,000 was calculated/i });
    fireEvent.click(marker);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/ai-summaries/7/stats/7%3Atotal%3ASales%3Acategory',
        expect.objectContaining({ credentials: 'same-origin' }),
      ),
    );
  });

  it('strips the raw <cite> token from the rendered answer text', () => {
    mockUseQaAnswer.mockReturnValue(
      defaultHookReturn({
        status: 'answered',
        answer: {
          answer: 'Revenue hit $5,000<cite id="7:total:Sales:category"/> this quarter.',
          citedStatIds: ['7:total:Sales:category'],
          termination: 'answered',
          turnCount: 1,
        },
      }),
    );

    render(<QaAskBox datasetId={7} />);

    expect(screen.queryByText(/<cite/)).toBeNull();
  });
});
