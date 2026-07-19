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
});
