import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// No test file, and no reference from any other test. The profile this collects
// feeds assemblePrompt, so the shape it saves is what the model is told about
// the business.

const apiClient = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...args: unknown[]) => apiClient(...args) }));

import { OnboardingModal } from './OnboardingModal';

const onComplete = vi.fn();

beforeEach(() => {
  apiClient.mockReset().mockResolvedValue({ data: {} });
  onComplete.mockReset();
});

/** Answers all four questions in order and returns after the last click. */
async function answerAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Retail' }));
  await user.click(screen.getByRole('button', { name: '$100K, $500K' }));
  await user.click(screen.getByRole('button', { name: '2-5 people' }));
  await user.click(screen.getByRole('button', { name: 'Cash flow' }));
}

describe('OnboardingModal stepping', () => {
  it('starts on the first question of four', () => {
    render(<OnboardingModal onComplete={onComplete} />);

    expect(screen.getByText('1 of 4')).toBeInTheDocument();
    expect(screen.getByText('What kind of business do you run?')).toBeInTheDocument();
  });

  it('advances a step on each answer without saving yet', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal onComplete={onComplete} />);

    await user.click(screen.getByRole('button', { name: 'Retail' }));

    expect(screen.getByText('2 of 4')).toBeInTheDocument();
    expect(screen.getByText('Roughly how much revenue per year?')).toBeInTheDocument();
    // One PUT at the end, not one per step.
    expect(apiClient).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // Skip has to close the modal without writing a partial profile, or a user
  // who bailed on question two ends up with half a profile feeding the prompt.
  it('closes without saving when skipped', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal onComplete={onComplete} />);
    await user.click(screen.getByRole('button', { name: 'Retail' }));

    await user.click(screen.getByRole('button', { name: 'Skip' }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(apiClient).not.toHaveBeenCalled();
  });
});

describe('OnboardingModal saving', () => {
  it('saves every answer in one PUT and then closes', async () => {
    const user = userEvent.setup();
    render(<OnboardingModal onComplete={onComplete} />);

    await answerAll(user);

    await waitFor(() => expect(apiClient).toHaveBeenCalledTimes(1));
    const [path, init] = apiClient.mock.calls[0]!;
    expect(path).toBe('/org/profile');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      businessType: 'retail',
      revenueRange: '100k_500k',
      teamSize: '2_5',
      topConcern: 'cash_flow',
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  // The swallowed catch is deliberate: a profile is a nicety and the dashboard
  // behind this modal is the product. Failing to save must not trap the user
  // behind an overlay they cannot dismiss.
  it('closes anyway when the save fails', async () => {
    apiClient.mockRejectedValue(new Error('500 from the API'));

    const user = userEvent.setup();
    render(<OnboardingModal onComplete={onComplete} />);

    await answerAll(user);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});
