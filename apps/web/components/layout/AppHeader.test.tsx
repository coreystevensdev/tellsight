import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/app/dashboard/SidebarContext', () => ({
  useSidebar: vi.fn(),
}));

vi.mock('@/app/dashboard/ActionDrawerContext', () => ({
  useActionDrawer: vi.fn(),
}));

import { useSidebar } from '@/app/dashboard/SidebarContext';
import { useActionDrawer } from '@/app/dashboard/ActionDrawerContext';
import { AppHeader } from './AppHeader';

function mockSidebar(overrides: Partial<ReturnType<typeof useSidebar>> = {}) {
  vi.mocked(useSidebar).mockReturnValue({
    open: false,
    setOpen: vi.fn(),
    orgName: 'Test Org',
    setOrgName: vi.fn(),
    isAdmin: false,
    ...overrides,
  });
}

function mockActionDrawer(overrides: Partial<ReturnType<typeof useActionDrawer>> = {}) {
  vi.mocked(useActionDrawer).mockReturnValue({
    status: 'done',
    proposals: [],
    error: null,
    resolveProposal: vi.fn(),
    open: false,
    setOpen: vi.fn(),
    isOwner: false,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSidebar();
  mockActionDrawer();
});

describe('AppHeader pending-proposals badge', () => {
  it('hides the badge when there are no pending proposals', () => {
    mockActionDrawer({ proposals: [] });
    render(<AppHeader isAuthenticated={true} />);

    expect(screen.queryByLabelText(/pending proposal/i)).not.toBeInTheDocument();
  });

  it('hides the badge for logged-out visitors even if proposals exist', () => {
    mockActionDrawer({ proposals: [{ id: 1 }, { id: 2 }] as never });
    render(<AppHeader isAuthenticated={false} />);

    expect(screen.queryByLabelText(/pending proposal/i)).not.toBeInTheDocument();
  });

  it('shows the pending count and opens the drawer on click', () => {
    const setActionDrawerOpen = vi.fn();
    mockActionDrawer({ proposals: [{ id: 1 }, { id: 2 }, { id: 3 }] as never, setOpen: setActionDrawerOpen });
    render(<AppHeader isAuthenticated={true} />);

    const badge = screen.getByLabelText('3 pending proposals');
    expect(badge).toHaveTextContent('3');

    fireEvent.click(badge);
    expect(setActionDrawerOpen).toHaveBeenCalledWith(true);
  });

  it('uses singular wording for exactly one pending proposal', () => {
    mockActionDrawer({ proposals: [{ id: 1 }] as never });
    render(<AppHeader isAuthenticated={true} />);

    expect(screen.getByLabelText('1 pending proposal')).toBeInTheDocument();
  });
});
