import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AiSummarySkeleton } from './AiSummarySkeleton';

afterEach(cleanup);

describe('AiSummarySkeleton', () => {
  it('renders 4 skeleton text lines', () => {
    render(<AiSummarySkeleton />);

    const lines = screen.getAllByTestId(/^skeleton-line-/);
    expect(lines).toHaveLength(4);
  });

  it('applies descending widths (100%, 90%, 95%, 60%)', () => {
    render(<AiSummarySkeleton />);

    const lines = screen.getAllByTestId(/^skeleton-line-/);
    expect(lines[0]).toHaveClass('w-full');
    expect(lines[1]).toHaveClass('w-[90%]');
    expect(lines[2]).toHaveClass('w-[95%]');
    expect(lines[3]).toHaveClass('w-[60%]');
  });

  it('has role="status" and aria-label for accessibility', () => {
    render(<AiSummarySkeleton />);

    const container = screen.getByRole('status');
    expect(container).toHaveAttribute('aria-label', 'Loading AI summary');
  });

  it('includes motion-reduce:animate-none on animated elements', () => {
    render(<AiSummarySkeleton />);

    const lines = screen.getAllByTestId(/^skeleton-line-/);
    for (const line of lines) {
      expect(line.className).toContain('motion-reduce:animate-none');
    }
  });

  it('uses skeleton-pulse animation on all lines', () => {
    render(<AiSummarySkeleton />);

    const lines = screen.getAllByTestId(/^skeleton-line-/);
    for (const line of lines) {
      expect(line.className).toContain('animate-skeleton-pulse');
    }
  });

  it('renders with warm AI surface card styling', () => {
    render(<AiSummarySkeleton />);

    const container = screen.getByRole('status');
    expect(container.className).toContain('border-t-2');
    expect(container.className).toContain('bg-ai-surface');
  });

  it('renders title-bar skeleton with pulse and motion-reduce', () => {
    render(<AiSummarySkeleton />);

    const title = screen.getByTestId('skeleton-title');
    expect(title.className).toContain('animate-skeleton-pulse');
    expect(title.className).toContain('motion-reduce:animate-none');
  });
});
