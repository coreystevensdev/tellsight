import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/dashboard'),
}));

vi.mock('@/app/dashboard/SidebarContext', () => ({
  useSidebar: vi.fn(),
}));

import { useSidebar } from '@/app/dashboard/SidebarContext';
import { Sidebar } from './Sidebar';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar admin nav', () => {
  it('hides Admin link when user is not platform admin', () => {
    mockSidebar({ isAdmin: false });
    render(<Sidebar />);

    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
    // By href, because the guard covers two links and the second is labelled
    // "Analytics", which /admin/i does not match: moving only that one outside
    // the isAdmin check passed every assertion above.
    expect(
      document.querySelectorAll('a[href^="/admin"]'),
      'no admin-scoped link may render for a non-admin',
    ).toHaveLength(0);
  });

  it('shows Admin link when user is platform admin', () => {
    mockSidebar({ isAdmin: true });
    render(<Sidebar />);

    expect(screen.getByText('Admin')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /admin/i });
    expect(link).toHaveAttribute('href', '/admin');
  });

  it('always renders standard nav items regardless of admin status', () => {
    mockSidebar({ isAdmin: false });
    render(<Sidebar />);

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Upload')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});
