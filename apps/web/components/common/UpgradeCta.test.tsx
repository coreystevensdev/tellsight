import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { UpgradeCta } from './UpgradeCta';
import { PRO_PRICE_DISPLAY } from 'shared/constants';

afterEach(cleanup);

describe('UpgradeCta', () => {
  it('renders overlay variant with headline and subtext', () => {
    render(<UpgradeCta variant="overlay" onUpgrade={() => {}} />);
    expect(screen.getByText('Unlock full analysis')).toBeInTheDocument();
    expect(screen.getByText(/full ai insights, no word limits/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upgrade to pro subscription/i })).toBeInTheDocument();
  });

  it('renders inline variant with full width', () => {
    const { container } = render(<UpgradeCta variant="inline" onUpgrade={() => {}} />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain('w-full');
  });

  it('overlay variant is centered with max width', () => {
    const { container } = render(<UpgradeCta variant="overlay" onUpgrade={() => {}} />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain('max-w-sm');
  });

  it('fires onUpgrade on click', () => {
    const handler = vi.fn();
    render(<UpgradeCta variant="overlay" onUpgrade={handler} />);
    fireEvent.click(screen.getByRole('button', { name: /upgrade to pro subscription/i }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('fires onUpgrade even when disabled (intent tracking)', () => {
    const handler = vi.fn();
    render(<UpgradeCta variant="overlay" onUpgrade={handler} disabled disabledTooltip="Pro plan coming soon" />);
    fireEvent.click(screen.getByRole('button', { name: /upgrade to pro subscription/i }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('disabled state shows tooltip text and aria attributes', () => {
    render(<UpgradeCta variant="overlay" onUpgrade={() => {}} disabled disabledTooltip="Pro plan coming soon" />);
    const btn = screen.getByRole('button', { name: /upgrade to pro subscription/i });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('aria-describedby', 'upgrade-tooltip');
    expect(screen.getByText('Pro plan coming soon')).toBeInTheDocument();
  });

  it('enabled state has no aria-disabled or tooltip', () => {
    render(<UpgradeCta variant="overlay" onUpgrade={() => {}} />);
    const btn = screen.getByRole('button', { name: /upgrade to pro subscription/i });
    expect(btn).not.toHaveAttribute('aria-disabled');
    expect(btn).not.toHaveAttribute('aria-describedby');
  });

  it('button meets 44x44 minimum touch target', () => {
    render(<UpgradeCta variant="overlay" onUpgrade={() => {}} />);
    const btn = screen.getByRole('button', { name: /upgrade to pro subscription/i });
    expect(btn.className).toContain('min-h-11');
    expect(btn.className).toContain('min-w-11');
  });
  // The price was hardcoded here and in BillingContent, and drifted from the
  // Stripe price it is supposed to describe: the button said $29 while checkout
  // charged $29.99. Assert the rendered number comes from the shared constant so
  // re-hardcoding one of them shows up here.
  it('shows the price from the shared constant, in the label and the copy', () => {
    render(<UpgradeCta variant="overlay" onUpgrade={() => {}} />);

    expect(screen.getByText(`${PRO_PRICE_DISPLAY}/mo`)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Upgrade to Pro subscription for ${PRO_PRICE_DISPLAY} per month` }),
    ).toBeInTheDocument();
  });
});
