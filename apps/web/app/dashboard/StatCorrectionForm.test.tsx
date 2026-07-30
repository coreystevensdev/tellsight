import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { StatCorrectionForm } from './StatCorrectionForm';

const mockUseStatCorrections = vi.fn();
vi.mock('@/lib/hooks/useStatCorrections', () => ({
  useStatCorrections: (...args: unknown[]) => mockUseStatCorrections(...args),
}));

afterEach(cleanup);

function baseHookReturn(overrides: Partial<ReturnType<typeof mockUseStatCorrections>> = {}) {
  return {
    status: 'done',
    corrections: [],
    error: null,
    submitStatus: 'idle',
    submitError: null,
    submitCorrection: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('StatCorrectionForm', () => {
  it('renders existing annotations for this stat only', () => {
    mockUseStatCorrections.mockReturnValue(
      baseHookReturn({
        corrections: [
          { id: 1, statInstanceId: '7:runway:_:_', note: 'Wrong loan total', status: null },
          { id: 2, statInstanceId: '7:total:Sales:category', note: 'Different stat', status: null },
        ],
      }),
    );

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    expect(screen.getByText('Wrong loan total')).toBeInTheDocument();
    expect(screen.queryByText('Different stat')).not.toBeInTheDocument();
  });

  it('shows a pending badge for an unresolved Tier 2 request', () => {
    mockUseStatCorrections.mockReturnValue(
      baseHookReturn({
        corrections: [{ id: 1, statInstanceId: '7:runway:_:_', note: 'apply forever', status: 'pending' }],
      }),
    );

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    expect(screen.getByText('Pending review')).toBeInTheDocument();
  });

  it('submits a note-only correction and clears the form', async () => {
    const submitCorrection = vi.fn().mockResolvedValue(true);
    mockUseStatCorrections.mockReturnValue(baseHookReturn({ submitCorrection }));

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    fireEvent.change(screen.getByPlaceholderText("What's wrong with this number?"), {
      target: { value: 'This double-counts the SBA loan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => expect(submitCorrection).toHaveBeenCalledWith('This double-counts the SBA loan', false));
  });

  it('submits with appliesGoingForward true when the checkbox is checked', async () => {
    const submitCorrection = vi.fn().mockResolvedValue(true);
    mockUseStatCorrections.mockReturnValue(baseHookReturn({ submitCorrection }));

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    fireEvent.change(screen.getByPlaceholderText("What's wrong with this number?"), {
      target: { value: 'apply this forever' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => expect(submitCorrection).toHaveBeenCalledWith('apply this forever', true));
  });

  it('disables the submit button when the note is empty', () => {
    mockUseStatCorrections.mockReturnValue(baseHookReturn());

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  });

  it('shows the submit error from the hook', () => {
    mockUseStatCorrections.mockReturnValue(
      baseHookReturn({ submitStatus: 'error', submitError: 'A pending or approved correction already exists for this stat' }),
    );

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    expect(screen.getByText('A pending or approved correction already exists for this stat')).toBeInTheDocument();
  });

  it('shows a fetch-error message when the initial load fails', () => {
    mockUseStatCorrections.mockReturnValue(baseHookReturn({ status: 'error', error: 'Request failed (500)' }));

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    expect(screen.getByText("Couldn't load past corrections: Request failed (500)")).toBeInTheDocument();
  });

  it('still shows a fetch-error message when the hook reports an empty error string', () => {
    mockUseStatCorrections.mockReturnValue(baseHookReturn({ status: 'error', error: '' }));

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    expect(screen.getByText("Couldn't load past corrections: Something went wrong.")).toBeInTheDocument();
  });

  it('shows both the fetch error and a submit error at once, without either hiding the other', () => {
    mockUseStatCorrections.mockReturnValue(
      baseHookReturn({
        status: 'error',
        error: 'Request failed (500)',
        submitStatus: 'error',
        submitError: 'A pending or approved correction already exists for this stat',
      }),
    );

    render(<StatCorrectionForm datasetId={7} statId="7:runway:_:_" />);

    expect(screen.getByText("Couldn't load past corrections: Request failed (500)")).toBeInTheDocument();
    expect(screen.getByText('A pending or approved correction already exists for this stat')).toBeInTheDocument();
  });
});
