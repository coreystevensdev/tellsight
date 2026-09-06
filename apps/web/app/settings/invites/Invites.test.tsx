import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// No test file, and no reference from any other test.

const apiClient = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...args: unknown[]) => apiClient(...args) }));

import Invites from './Invites';

const writeText = vi.fn();

beforeEach(() => {
  apiClient.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
});

// userEvent.setup() installs its own navigator.clipboard, so the stub has to go
// in after it or the component writes to userEvent's copy and this spy never
// sees the call.
function stubClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  });
}

function generated(url = 'https://tellsight.app/invite/tok-1') {
  return { url, id: 7, expiresAt: '2026-12-31T00:00:00Z' };
}

describe('Invites owner gating', () => {
  // The list call is the only thing that reveals the caller is not an owner, so
  // its rejection is load-bearing: it swaps the whole page for an explanation
  // rather than showing a button that will always fail.
  it('explains rather than offering a button when the caller is not an owner', async () => {
    apiClient.mockRejectedValue(new Error('Owner access required'));

    render(<Invites />);

    expect(await screen.findByText(/Only organization owners can generate/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  // Any other failure is transient, and swapping to the owner explanation would
  // be a lie. The page stays usable.
  it('keeps the page usable when the list fails for another reason', async () => {
    apiClient.mockRejectedValue(new Error('Network unreachable'));

    render(<Invites />);

    await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument());
    expect(screen.queryByText(/Only organization owners/)).not.toBeInTheDocument();
  });
});

describe('Invites generation', () => {
  it('shows the generated link and refreshes the active list', async () => {
    apiClient.mockImplementation(async (_path: string, init?: { method?: string }) =>
      init?.method === 'POST' ? { data: generated() } : { data: [] },
    );

    const user = userEvent.setup();
    render(<Invites />);
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    const listCallsBefore = apiClient.mock.calls.filter(([, i]) => !i || !i.method).length;
    await user.click(screen.getByRole('button'));

    expect(await screen.findByDisplayValue('https://tellsight.app/invite/tok-1')).toBeInTheDocument();
    const listCallsAfter = apiClient.mock.calls.filter(([, i]) => !i || !i.method).length;
    expect(listCallsAfter).toBeGreaterThan(listCallsBefore);
  });

  it('surfaces a generation failure without claiming a link exists', async () => {
    apiClient.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') throw new Error('Invite limit reached');
      return { data: [] };
    });

    const user = userEvent.setup();
    render(<Invites />);
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    await user.click(screen.getByRole('button'));

    expect(await screen.findByText('Invite limit reached')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/invite\//)).not.toBeInTheDocument();
  });
});

describe('Invites copying', () => {
  async function generateThen() {
    apiClient.mockImplementation(async (_path: string, init?: { method?: string }) =>
      init?.method === 'POST' ? { data: generated() } : { data: [] },
    );
    const user = userEvent.setup();
    stubClipboard();
    render(<Invites />);
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    await user.click(screen.getByRole('button'));
    await screen.findByDisplayValue('https://tellsight.app/invite/tok-1');
    return user;
  }

  it('copies the link the API returned', async () => {
    const user = await generateThen();

    await user.click(screen.getByRole('button', { name: /copy/i }));

    expect(writeText).toHaveBeenCalledWith('https://tellsight.app/invite/tok-1');
  });

  // A clipboard write can be refused outright by permissions policy, and telling
  // the user to select the link manually is the only recovery available.
  it('tells the user to copy manually when the clipboard refuses', async () => {
    const user = await generateThen();
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));

    await user.click(screen.getByRole('button', { name: /copy/i }));

    expect(await screen.findByText(/select and copy the link manually/)).toBeInTheDocument();
  });
});
