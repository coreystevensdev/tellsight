import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ActionDrawer } from './ActionDrawer';

vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const mockUseActionDrawer = vi.fn();
vi.mock('./ActionDrawerContext', () => ({
  useActionDrawer: () => mockUseActionDrawer(),
}));

afterEach(cleanup);

const proposal = {
  id: 10,
  title: 'Marketing spend up 30%',
  explanation: 'Ad spend rose sharply against the prior month.',
  recommendation: 'Review the largest campaigns.',
};

function baseState(overrides: Partial<ReturnType<typeof mockUseActionDrawer>> = {}) {
  return {
    open: true,
    setOpen: vi.fn(),
    status: 'done',
    proposals: [],
    error: null,
    isOwner: false,
    resolveProposal: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('ActionDrawer', () => {
  it('shows a loading state', () => {
    mockUseActionDrawer.mockReturnValue(baseState({ status: 'loading' }));
    render(<ActionDrawer />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows an explicit empty state when there are no pending proposals', () => {
    mockUseActionDrawer.mockReturnValue(baseState({ status: 'done', proposals: [] }));
    render(<ActionDrawer />);

    expect(screen.getByText('No pending proposals right now.')).toBeInTheDocument();
  });

  it('renders title, explanation, and recommendation for each pending proposal', () => {
    mockUseActionDrawer.mockReturnValue(baseState({ proposals: [proposal] }));
    render(<ActionDrawer />);

    expect(screen.getByText('Marketing spend up 30%')).toBeInTheDocument();
    expect(screen.getByText('Ad spend rose sharply against the prior month.')).toBeInTheDocument();
    expect(screen.getByText('Review the largest campaigns.')).toBeInTheDocument();
  });

  it('hides Approve/Dismiss for non-owner members', () => {
    mockUseActionDrawer.mockReturnValue(baseState({ proposals: [proposal], isOwner: false }));
    render(<ActionDrawer />);

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('shows Approve/Dismiss for owners and calls resolveProposal on click', () => {
    const resolveProposal = vi.fn().mockResolvedValue(true);
    mockUseActionDrawer.mockReturnValue(baseState({ proposals: [proposal], isOwner: true, resolveProposal }));
    render(<ActionDrawer />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(resolveProposal).toHaveBeenCalledWith(10, 'approved');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(resolveProposal).toHaveBeenCalledWith(10, 'rejected');
  });

  it('shows an error message when the fetch failed', () => {
    mockUseActionDrawer.mockReturnValue(baseState({ status: 'error', proposals: [] }));
    render(<ActionDrawer />);

    expect(screen.getByText("Couldn't load pending proposals.")).toBeInTheDocument();
  });

  it('shows an inline error when resolving a proposal fails, without hiding the list', () => {
    mockUseActionDrawer.mockReturnValue(
      baseState({ status: 'done', proposals: [proposal], error: 'Request failed (500)' }),
    );
    render(<ActionDrawer />);

    expect(screen.getByRole('alert')).toHaveTextContent('Request failed (500)');
    expect(screen.getByText('Marketing spend up 30%')).toBeInTheDocument();
  });
});
