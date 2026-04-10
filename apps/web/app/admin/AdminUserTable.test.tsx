import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminUserTable } from './AdminUserTable';

const sampleUsers = [
  {
    id: 1,
    email: 'alice@acme.com',
    name: 'Alice Admin',
    isPlatformAdmin: true,
    orgs: [
      { orgId: 10, orgName: 'Acme Corp', role: 'owner' },
      { orgId: 20, orgName: 'Side Project', role: 'member' },
    ],
    createdAt: '2026-01-15T00:00:00Z',
  },
  {
    id: 2,
    email: 'bob@startup.com',
    name: 'Bob Regular',
    isPlatformAdmin: false,
    orgs: [{ orgId: 10, orgName: 'Acme Corp', role: 'member' }],
    createdAt: '2026-02-20T00:00:00Z',
  },
  {
    id: 3,
    email: 'charlie@nowhere.com',
    name: 'Charlie NoOrg',
    isPlatformAdmin: false,
    orgs: [],
    createdAt: '2026-03-10T00:00:00Z',
  },
];

describe('AdminUserTable', () => {
  it('renders user rows with name, email, and org memberships', () => {
    render(<AdminUserTable users={sampleUsers} />);

    expect(screen.getByText('Alice Admin')).toBeInTheDocument();
    expect(screen.getByText('alice@acme.com')).toBeInTheDocument();
    // Acme Corp appears for both Alice and Bob
    expect(screen.getAllByText('Acme Corp')).toHaveLength(2);

    expect(screen.getByText('Bob Regular')).toBeInTheDocument();
    expect(screen.getByText('bob@startup.com')).toBeInTheDocument();
  });

  it('shows ShieldCheck icon for platform admins', () => {
    render(<AdminUserTable users={sampleUsers} />);

    const adminBadge = screen.getByLabelText('Platform admin');
    expect(adminBadge).toBeInTheDocument();

    const allBadges = screen.queryAllByLabelText('Platform admin');
    expect(allBadges).toHaveLength(1);
  });

  it('shows "No org" for users without org memberships', () => {
    render(<AdminUserTable users={sampleUsers} />);

    expect(screen.getByText('No org')).toBeInTheDocument();
  });

  it('renders org role in parentheses next to org name', () => {
    render(<AdminUserTable users={sampleUsers} />);

    expect(screen.getByText('(owner)')).toBeInTheDocument();
    expect(screen.getAllByText('(member)')).toHaveLength(2);
  });

  it('shows empty state when no users', () => {
    render(<AdminUserTable users={[]} />);

    expect(screen.getByText('No users yet')).toBeInTheDocument();
  });

  it('renders column headers', () => {
    render(<AdminUserTable users={sampleUsers} />);

    const headers = screen.getAllByRole('columnheader');
    const headerTexts = headers.map((h) => h.textContent);
    expect(headerTexts).toEqual(['Name', 'Email', 'Organizations', 'Created']);
  });
});
