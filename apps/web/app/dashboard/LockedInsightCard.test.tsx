import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LockedInsightCard } from './LockedInsightCard';

describe('LockedInsightCard', () => {
  const defaultProps = {
    title: 'Enable Runway',
    description: 'Add your cash balance to see runway.',
    inputLabel: 'Current cash balance',
    onSubmit: vi.fn().mockResolvedValue(undefined),
  };

  it('renders title, description, and input label', () => {
    render(<LockedInsightCard {...defaultProps} />);
    expect(screen.getByText('Enable Runway')).toBeInTheDocument();
    expect(screen.getByText('Add your cash balance to see runway.')).toBeInTheDocument();
    expect(screen.getByLabelText('Current cash balance')).toBeInTheDocument();
  });

  it('disables submit when input is empty', () => {
    render(<LockedInsightCard {...defaultProps} />);
    const button = screen.getByRole('button', { name: /save/i });
    expect(button).toBeDisabled();
  });

  it('enables submit when a valid value is typed', async () => {
    const user = userEvent.setup({ delay: null });
    render(<LockedInsightCard {...defaultProps} />);

    await user.type(screen.getByLabelText('Current cash balance'), '15000');

    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  it('passes the parsed numeric value (not the string) to onSubmit', async () => {
    const user = userEvent.setup({ delay: null });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<LockedInsightCard {...defaultProps} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Current cash balance'), '15000');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(15000);
    });
  });

  it('strips minus sign at input time so users never silently submit a positive value', async () => {
    const user = userEvent.setup({ delay: null });
    render(<LockedInsightCard {...defaultProps} />);
    const input = screen.getByLabelText('Current cash balance') as HTMLInputElement;

    await user.type(input, '-500');

    // The '-' is stripped at input time so the user sees the cleaned value.
    expect(input.value).toBe('500');
    // Sanity: button state reflects the cleaned value (500 is a valid positive).
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  it('disables submit for values over inputMax', async () => {
    const user = userEvent.setup({ delay: null });
    render(<LockedInsightCard {...defaultProps} inputMax={1_000_000} />);
    const input = screen.getByLabelText('Current cash balance');

    await user.type(input, '99999999');
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('formats the value as currency on blur', async () => {
    const user = userEvent.setup({ delay: null });
    render(<LockedInsightCard {...defaultProps} />);
    const input = screen.getByLabelText('Current cash balance') as HTMLInputElement;

    await user.type(input, '15000');
    fireEvent.blur(input);

    expect(input.value).toBe('$15,000');
  });

  it('strips formatting on focus to allow editing', async () => {
    const user = userEvent.setup({ delay: null });
    render(<LockedInsightCard {...defaultProps} />);
    const input = screen.getByLabelText('Current cash balance') as HTMLInputElement;

    await user.type(input, '15000');
    fireEvent.blur(input);
    expect(input.value).toBe('$15,000');

    fireEvent.focus(input);
    expect(input.value).toBe('15000');
  });

  it('surfaces an error when onSubmit rejects', async () => {
    const user = userEvent.setup({ delay: null });
    const onSubmit = vi.fn().mockRejectedValue(new Error('Network down'));
    render(<LockedInsightCard {...defaultProps} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Current cash balance'), '5000');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Network down');
    });
  });

  it('disables input and button while submitting', async () => {
    const user = userEvent.setup({ delay: null });
    let resolveSubmit: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((r) => { resolveSubmit = r; }));
    render(<LockedInsightCard {...defaultProps} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Current cash balance'), '5000');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Current cash balance')).toBeDisabled();
    });
    expect(screen.getByRole('button')).toBeDisabled();

    resolveSubmit!();
  });
});
