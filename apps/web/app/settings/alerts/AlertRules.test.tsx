import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AlertRules, { type AlertRule } from './AlertRules';

const mockApiClient = vi.fn();

vi.mock('@/lib/api-client', () => ({
  apiClient: (...args: unknown[]) => mockApiClient(...args),
  ApiClientError: class ApiClientError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

beforeEach(() => {
  mockApiClient.mockReset();
});

const runwayRule: AlertRule = {
  id: 1,
  kind: 'runway_runs_short',
  threshold: { months: 3 },
  enabled: true,
  muteUntil: null,
  createdAt: '2026-07-01T00:00:00.000Z',
};

describe('AlertRules, empty state', () => {
  it('renders the create-first-rule CTA when there are no rules', () => {
    render(<AlertRules initial={[]} />);

    expect(screen.getByText('No alert rules yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create your first alert rule/i })).toBeInTheDocument();
  });
});

describe('AlertRules, list rendering', () => {
  it('renders an existing rule with its threshold description', () => {
    render(<AlertRules initial={[runwayRule]} />);

    expect(screen.getByText('Runway runs short')).toBeInTheDocument();
    expect(screen.getByText(/below 3 months/i)).toBeInTheDocument();
  });
});

describe('AlertRules, create flow', () => {
  it('switches the threshold input to a confidence dropdown when anomaly_fires is selected', async () => {
    const user = userEvent.setup();
    render(<AlertRules initial={[]} />);

    await user.click(screen.getByRole('button', { name: /create your first alert rule/i }));
    await user.selectOptions(screen.getByLabelText(/alert type/i), 'anomaly_fires');

    expect(screen.getByLabelText(/minimum confidence/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^months$/i)).not.toBeInTheDocument();
  });

  it('submits a runway rule and adds it to the list', async () => {
    const user = userEvent.setup();
    mockApiClient.mockResolvedValueOnce({ data: runwayRule });

    render(<AlertRules initial={[]} />);

    await user.click(screen.getByRole('button', { name: /create your first alert rule/i }));
    await user.clear(screen.getByLabelText(/^months$/i));
    await user.type(screen.getByLabelText(/^months$/i), '3');
    await user.click(screen.getByRole('button', { name: /create rule/i }));

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith(
        '/org/alert-rules',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
        }),
      );
    });
    expect(await screen.findByText('Runway runs short')).toBeInTheDocument();
  });

  it('shows an owner-only message on a 403 from the API', async () => {
    const user = userEvent.setup();
    const { ApiClientError } = await import('@/lib/api-client');
    mockApiClient.mockRejectedValueOnce(new ApiClientError('Owner access required', 403, null));

    render(<AlertRules initial={[]} />);

    await user.click(screen.getByRole('button', { name: /create your first alert rule/i }));
    await user.click(screen.getByRole('button', { name: /create rule/i }));

    expect(await screen.findByText(/only organization owners can manage alert rules/i)).toBeInTheDocument();
  });

  it('blocks submission and shows an inline error when the months field is cleared', async () => {
    const user = userEvent.setup();
    render(<AlertRules initial={[]} />);

    await user.click(screen.getByRole('button', { name: /create your first alert rule/i }));
    await user.clear(screen.getByLabelText(/^months$/i));
    await user.click(screen.getByRole('button', { name: /create rule/i }));

    const input = screen.getByLabelText(/^months$/i);
    expect(await screen.findByText('Must be greater than 0.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'rule-value-error');
    expect(mockApiClient).not.toHaveBeenCalled();
  });

  it('blocks submission when a percent field is set to 0', async () => {
    const user = userEvent.setup();
    render(<AlertRules initial={[]} />);

    await user.click(screen.getByRole('button', { name: /create your first alert rule/i }));
    await user.selectOptions(screen.getByLabelText(/alert type/i), 'margin_drops');
    await user.clear(screen.getByLabelText(/^percent$/i));
    await user.type(screen.getByLabelText(/^percent$/i), '0');
    expect(screen.getByLabelText(/^percent$/i)).toHaveValue(0);

    await user.click(screen.getByRole('button', { name: /create rule/i }));

    expect(await screen.findByText('Must be greater than 0.')).toBeInTheDocument();
    expect(mockApiClient).not.toHaveBeenCalled();
  });

  it('blocks submission when the months field is negative', async () => {
    const user = userEvent.setup();
    render(<AlertRules initial={[]} />);

    await user.click(screen.getByRole('button', { name: /create your first alert rule/i }));
    await user.clear(screen.getByLabelText(/^months$/i));
    await user.type(screen.getByLabelText(/^months$/i), '-1');
    expect(screen.getByLabelText(/^months$/i)).toHaveValue(-1);

    await user.click(screen.getByRole('button', { name: /create rule/i }));

    expect(await screen.findByText('Must be greater than 0.')).toBeInTheDocument();
    expect(mockApiClient).not.toHaveBeenCalled();
  });

  it('clears the inline error when switching to anomaly_fires', async () => {
    const user = userEvent.setup();
    render(<AlertRules initial={[]} />);

    await user.click(screen.getByRole('button', { name: /create your first alert rule/i }));
    await user.clear(screen.getByLabelText(/^months$/i));
    expect(await screen.findByText('Must be greater than 0.')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/alert type/i), 'anomaly_fires');

    expect(screen.queryByText('Must be greater than 0.')).not.toBeInTheDocument();
  });
});

describe('AlertRules, edit flow', () => {
  it('prefills the form with the existing threshold and submits a PUT', async () => {
    const user = userEvent.setup();
    const updated: AlertRule = { ...runwayRule, threshold: { months: 6 } };
    mockApiClient.mockResolvedValueOnce({ data: updated });

    render(<AlertRules initial={[runwayRule]} />);

    await user.click(screen.getByLabelText(/edit alert rule/i));
    expect(screen.getByLabelText(/^months$/i)).toHaveValue(3);

    await user.clear(screen.getByLabelText(/^months$/i));
    await user.type(screen.getByLabelText(/^months$/i), '6');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith(
        '/org/alert-rules/1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 6 } }),
        }),
      );
    });
  });

  it('blocks a Save changes submit when the field is cleared to invalid', async () => {
    const user = userEvent.setup();
    render(<AlertRules initial={[runwayRule]} />);

    await user.click(screen.getByLabelText(/edit alert rule/i));
    await user.clear(screen.getByLabelText(/^months$/i));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Must be greater than 0.')).toBeInTheDocument();
    expect(mockApiClient).not.toHaveBeenCalled();
  });
});

describe('AlertRules, toggle flow', () => {
  it('flips enabled without touching kind or threshold', async () => {
    const user = userEvent.setup();
    mockApiClient.mockResolvedValueOnce({ data: { ...runwayRule, enabled: false } });

    render(<AlertRules initial={[runwayRule]} />);

    await user.click(screen.getByRole('button', { name: 'On' }));

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith(
        '/org/alert-rules/1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 }, enabled: false }),
        }),
      );
    });
  });
});

describe('AlertRules, mute state', () => {
  const mutedRule: AlertRule = {
    ...runwayRule,
    muteUntil: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  };

  it('shows a muted badge and unmute button when muteUntil is in the future', () => {
    render(<AlertRules initial={[mutedRule]} />);

    expect(screen.getByText(/muted until/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unmute now/i })).toBeInTheDocument();
  });

  it('hides the muted badge once muteUntil has passed', () => {
    const lapsedRule: AlertRule = {
      ...runwayRule,
      muteUntil: new Date(Date.now() - 86_400_000).toISOString(),
    };
    render(<AlertRules initial={[lapsedRule]} />);

    expect(screen.queryByText(/muted until/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unmute now/i })).not.toBeInTheDocument();
  });

  it('clears the mute via a PUT with muteUntil: null', async () => {
    const user = userEvent.setup();
    mockApiClient.mockResolvedValueOnce({ data: { ...mutedRule, muteUntil: null } });

    render(<AlertRules initial={[mutedRule]} />);
    await user.click(screen.getByRole('button', { name: /unmute now/i }));

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith(
        '/org/alert-rules/1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 }, muteUntil: null }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText(/muted until/i)).not.toBeInTheDocument();
    });
  });
});

describe('AlertRules, delete flow', () => {
  it('removes the rule from the list after a successful delete', async () => {
    const user = userEvent.setup();
    mockApiClient.mockResolvedValueOnce({ data: { deleted: true } });

    render(<AlertRules initial={[runwayRule]} />);

    await user.click(screen.getByLabelText(/delete alert rule/i));

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith('/org/alert-rules/1', expect.objectContaining({ method: 'DELETE' }));
    });
    await waitFor(() => {
      expect(screen.queryByText('Runway runs short')).not.toBeInTheDocument();
    });
  });
});
