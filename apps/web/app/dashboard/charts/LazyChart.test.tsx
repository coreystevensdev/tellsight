import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

let intersectionCallback: (entries: Array<{ isIntersecting: boolean }>) => void;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

vi.stubGlobal(
  'IntersectionObserver',
  vi.fn(function (cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    intersectionCallback = cb;
    return { observe: mockObserve, disconnect: mockDisconnect, unobserve: vi.fn() };
  }),
);

vi.mock('shared/constants', () => ({
  CHART_CONFIG: {
    LAZY_THRESHOLD: 0.1,
    SKELETON_FADE_MS: 150,
  },
}));

vi.mock('./ChartSkeleton', () => ({
  ChartSkeleton: ({ variant }: { variant?: string }) => (
    <div data-testid="chart-skeleton" data-variant={variant}>
      Skeleton
    </div>
  ),
}));

import { LazyChart } from './LazyChart';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LazyChart', () => {
  describe('desktop (>= 768px)', () => {
    beforeEach(() => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    });

    it('renders children immediately without IntersectionObserver', () => {
      render(
        <LazyChart>
          <div data-testid="chart-content">Chart</div>
        </LazyChart>,
      );

      expect(screen.getByTestId('chart-content')).toBeInTheDocument();
      expect(screen.queryByTestId('chart-skeleton')).not.toBeInTheDocument();
      expect(mockObserve).not.toHaveBeenCalled();
    });
  });

  describe('mobile (< 768px)', () => {
    beforeEach(() => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375);
    });

    it('shows skeleton before intersection', () => {
      render(
        <LazyChart skeletonVariant="bar">
          <div data-testid="chart-content">Chart</div>
        </LazyChart>,
      );

      expect(screen.getByTestId('chart-skeleton')).toBeInTheDocument();
      expect(screen.queryByTestId('chart-content')).not.toBeInTheDocument();
      expect(mockObserve).toHaveBeenCalled();
    });

    it('reveals children after intersection', () => {
      render(
        <LazyChart>
          <div data-testid="chart-content">Chart</div>
        </LazyChart>,
      );

      expect(screen.queryByTestId('chart-content')).not.toBeInTheDocument();

      act(() => {
        intersectionCallback([{ isIntersecting: true }]);
      });

      expect(screen.getByTestId('chart-content')).toBeInTheDocument();
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('does not reveal on non-intersecting entry', () => {
      render(
        <LazyChart>
          <div data-testid="chart-content">Chart</div>
        </LazyChart>,
      );

      act(() => {
        intersectionCallback([{ isIntersecting: false }]);
      });

      expect(screen.queryByTestId('chart-content')).not.toBeInTheDocument();
      expect(screen.getByTestId('chart-skeleton')).toBeInTheDocument();
    });

    it('passes skeletonVariant to ChartSkeleton', () => {
      render(
        <LazyChart skeletonVariant="bar">
          <div>Chart</div>
        </LazyChart>,
      );

      expect(screen.getByTestId('chart-skeleton')).toHaveAttribute('data-variant', 'bar');
    });
  });
});
