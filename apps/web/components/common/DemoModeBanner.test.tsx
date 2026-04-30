import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DemoModeBanner } from './DemoModeBanner';

afterEach(cleanup);

const noop = () => {};

describe('DemoModeBanner', () => {
  describe('state-dependent rendering', () => {
    it('shows sample-data message for seed_only state', () => {
      render(<DemoModeBanner demoState="seed_only" onUploadClick={noop} />);

      expect(screen.getByText(/viewing sample data/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /upload csv/i })).toBeInTheDocument();
    });

    it('shows get-started message for empty state', () => {
      render(<DemoModeBanner demoState="empty" onUploadClick={noop} />);

      expect(screen.getByText(/get started/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /upload csv/i })).toBeInTheDocument();
    });

    it('renders null for seed_plus_user state', () => {
      const { container } = render(
        <DemoModeBanner demoState="seed_plus_user" onUploadClick={noop} />,
      );

      expect(container.innerHTML).toBe('');
    });

    it('renders null for user_only state', () => {
      const { container } = render(
        <DemoModeBanner demoState="user_only" onUploadClick={noop} />,
      );

      expect(container.innerHTML).toBe('');
    });
  });

  describe('dismiss behavior', () => {
    it('hides banner when dismiss button is clicked', () => {
      render(<DemoModeBanner demoState="seed_only" onUploadClick={noop} />);

      const dismiss = screen.getByRole('button', { name: /dismiss sample data notice/i });
      fireEvent.click(dismiss);

      expect(screen.queryByText(/viewing sample data/i)).not.toBeInTheDocument();
    });

    it('dismiss button has correct aria-label', () => {
      render(<DemoModeBanner demoState="seed_only" onUploadClick={noop} />);

      expect(
        screen.getByRole('button', { name: 'Dismiss sample data notice' }),
      ).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('has role="status" on the banner', () => {
      render(<DemoModeBanner demoState="seed_only" onUploadClick={noop} />);

      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('has aria-live="polite"', () => {
      render(<DemoModeBanner demoState="seed_only" onUploadClick={noop} />);

      expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('upload action', () => {
    it('calls onUploadClick when upload button is clicked', () => {
      const handleClick = vi.fn();
      render(<DemoModeBanner demoState="seed_only" onUploadClick={handleClick} />);

      fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));
      expect(handleClick).toHaveBeenCalledOnce();
    });
  });

  describe('auto-dissolve transition', () => {
    it('shows dissolve animation when demoState leaves seed_only', () => {
      const { rerender } = render(
        <DemoModeBanner demoState="seed_only" onUploadClick={noop} />,
      );

      rerender(<DemoModeBanner demoState="user_only" onUploadClick={noop} />);

      const banner = screen.getByRole('status');
      expect(banner.className).toContain('animate-banner-dissolve');
    });

    it('shows previous message during dissolve', () => {
      const { rerender } = render(
        <DemoModeBanner demoState="seed_only" onUploadClick={noop} />,
      );

      rerender(<DemoModeBanner demoState="seed_plus_user" onUploadClick={noop} />);

      expect(screen.getByText(/viewing sample data/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /upload csv/i })).not.toBeInTheDocument();
    });

    it('strips interactive elements during dissolve', () => {
      const { rerender } = render(
        <DemoModeBanner demoState="seed_only" onUploadClick={noop} />,
      );

      // Buttons present before transition
      expect(screen.getByRole('button', { name: /upload csv/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();

      rerender(<DemoModeBanner demoState="user_only" onUploadClick={noop} />);

      // No buttons during dissolve, banner is non-interactive while fading
      // onAnimationEnd calls setDismissed(true) to unmount; jsdom can't fire CSS
      // animation events, but dismiss behavior is verified in the dismiss suite
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('reduced motion', () => {
    it('applies motion-reduce:transition-none on normal banner', () => {
      render(<DemoModeBanner demoState="seed_only" onUploadClick={noop} />);

      const banner = screen.getByRole('status');
      expect(banner.className).toContain('motion-reduce:transition-none');
    });

    it('applies motion-reduce:hidden during dissolve', () => {
      const { rerender } = render(
        <DemoModeBanner demoState="seed_only" onUploadClick={noop} />,
      );

      rerender(<DemoModeBanner demoState="user_only" onUploadClick={noop} />);

      const banner = screen.getByRole('status');
      expect(banner.className).toContain('motion-reduce:hidden');
    });
  });
});
