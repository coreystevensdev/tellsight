import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { StatDetailSheet } from './StatDetailSheet';

vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const mockUseStatDetail = vi.fn();
vi.mock('@/lib/hooks/useStatDetail', () => ({
  useStatDetail: (...args: unknown[]) => mockUseStatDetail(...args),
}));

const mockSourceRowsPanel = vi.fn((props: { datasetId: number; statId: string }) => (
  <div data-testid="source-rows-panel" data-dataset-id={props.datasetId} data-stat-id={props.statId} />
));
vi.mock('./SourceRowsPanel', () => ({
  SourceRowsPanel: (props: { datasetId: number; statId: string }) => mockSourceRowsPanel(props),
}));

const mockStatCorrectionForm = vi.fn((props: { datasetId: number; statId: string }) => (
  <div data-testid="stat-correction-form" data-dataset-id={props.datasetId} data-stat-id={props.statId} />
));
vi.mock('./StatCorrectionForm', () => ({
  StatCorrectionForm: (props: { datasetId: number; statId: string }) => mockStatCorrectionForm(props),
}));

afterEach(cleanup);

describe('StatDetailSheet', () => {
  it('renders nothing when statId is null', () => {
    mockUseStatDetail.mockReturnValue({ status: 'idle', data: null, error: null });

    const { container } = render(
      <StatDetailSheet open={false} onOpenChange={() => {}} datasetId={1} statId={null} />,
    );

    expect(container.querySelector('[data-slot="sheet"]')).toBeNull();
  });

  it('shows a loading state', () => {
    mockUseStatDetail.mockReturnValue({ status: 'loading', data: null, error: null });

    render(
      <StatDetailSheet open={true} onOpenChange={() => {}} datasetId={1} statId="1:total:Sales:category" />,
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows an error state', () => {
    mockUseStatDetail.mockReturnValue({
      status: 'error',
      data: null,
      error: 'This citation is no longer available',
    });

    render(
      <StatDetailSheet open={true} onOpenChange={() => {}} datasetId={1} statId="1:total:Sales:category" />,
    );

    expect(screen.getByText('This citation is no longer available')).toBeInTheDocument();
  });

  it('renders a formula-kind detail with expression and terms', () => {
    mockUseStatDetail.mockReturnValue({
      status: 'done',
      data: {
        statType: 'break_even',
        value: 35_556,
        detail: {
          kind: 'formula',
          expression: '$8,000 / (22.5% / 100) = $35,556',
          terms: [
            { label: 'Current revenue', value: '$30,000' },
            { label: 'Gap to break-even', value: '$5,556' },
          ],
        },
      },
      error: null,
    });

    render(
      <StatDetailSheet open={true} onOpenChange={() => {}} datasetId={1} statId="1:break_even:_:_" />,
    );

    expect(screen.getByText('break even')).toBeInTheDocument();
    expect(screen.getByText('$8,000 / (22.5% / 100) = $35,556')).toBeInTheDocument();
    expect(screen.getByText('Current revenue')).toBeInTheDocument();
    expect(screen.getByText('$5,556')).toBeInTheDocument();
  });

  it('renders an inputs-kind detail with method name and inputs', () => {
    mockUseStatDetail.mockReturnValue({
      status: 'done',
      data: {
        statType: 'anomaly',
        value: 500,
        detail: {
          kind: 'inputs',
          methodName: 'Z-score vs category baseline (IQR outlier detection)',
          inputs: [
            { label: 'Z-score', value: '3.10' },
            { label: 'Deviation', value: '$400' },
          ],
        },
      },
      error: null,
    });

    render(
      <StatDetailSheet open={true} onOpenChange={() => {}} datasetId={1} statId="1:anomaly:Sales:v500" />,
    );

    expect(screen.getByText('Z-score vs category baseline (IQR outlier detection)')).toBeInTheDocument();
    expect(screen.getByText('Z-score')).toBeInTheDocument();
    expect(screen.getByText('3.10')).toBeInTheDocument();
  });

  it('closes on escape', () => {
    mockUseStatDetail.mockReturnValue({ status: 'loading', data: null, error: null });
    const onOpenChange = vi.fn();

    render(
      <StatDetailSheet open={true} onOpenChange={onOpenChange} datasetId={1} statId="1:total:Sales:category" />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('footer toggle expands SourceRowsPanel with the correct datasetId/statId', () => {
    mockUseStatDetail.mockReturnValue({
      status: 'done',
      data: { statType: 'total', value: 100, detail: { kind: 'formula', expression: '$100', terms: [] } },
      error: null,
    });

    render(
      <StatDetailSheet open={true} onOpenChange={() => {}} datasetId={7} statId="7:total:Sales:category" />,
    );

    expect(screen.queryByTestId('source-rows-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View source rows' }));

    expect(screen.getByTestId('source-rows-panel')).toBeInTheDocument();
    expect(mockSourceRowsPanel).toHaveBeenCalledWith(
      expect.objectContaining({ datasetId: 7, statId: '7:total:Sales:category' }),
    );
  });

  it('renders the correction form once the citation has resolved', () => {
    mockUseStatDetail.mockReturnValue({
      status: 'done',
      data: { statType: 'total', value: 100, detail: { kind: 'formula', expression: '$100', terms: [] } },
      error: null,
    });

    render(
      <StatDetailSheet open={true} onOpenChange={() => {}} datasetId={7} statId="7:total:Sales:category" />,
    );

    expect(screen.getByTestId('stat-correction-form')).toBeInTheDocument();
    expect(mockStatCorrectionForm).toHaveBeenCalledWith(
      expect.objectContaining({ datasetId: 7, statId: '7:total:Sales:category' }),
    );
  });

  it('does not render the correction form while the citation is loading', () => {
    mockUseStatDetail.mockReturnValue({ status: 'loading', data: null, error: null });

    render(
      <StatDetailSheet open={true} onOpenChange={() => {}} datasetId={1} statId="1:total:Sales:category" />,
    );

    expect(screen.queryByTestId('stat-correction-form')).not.toBeInTheDocument();
  });

  it('source rows toggle is a keyboard-reachable button that reports its expanded state', () => {
    mockUseStatDetail.mockReturnValue({ status: 'loading', data: null, error: null });

    render(
      <StatDetailSheet open={true} onOpenChange={() => {}} datasetId={1} statId="1:total:Sales:category" />,
    );

    const toggle = screen.getByRole('button', { name: 'View source rows' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide source rows' })).toHaveAttribute('aria-expanded', 'true');
  });
});
