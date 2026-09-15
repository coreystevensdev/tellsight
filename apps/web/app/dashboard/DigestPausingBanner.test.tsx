import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { DigestPausingBanner } from './DigestPausingBanner';

const NOW = new Date('2026-10-08T12:00:00.000Z');

/** ISO string for a pause date `days` from NOW. */
function pausesIn(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

beforeEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe('DigestPausingBanner visibility', () => {
  // Showing this the day a dataset lands would mean a month of banner before it
  // means anything, and a banner scrolled past for a month is one nobody reads
  // on the day it matters.
  it('stays hidden while the pause is still weeks away', () => {
    render(<DigestPausingBanner digestPausesAt={pausesIn(20)} now={NOW} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('appears once the pause is a week out', () => {
    render(<DigestPausingBanner digestPausesAt={pausesIn(7)} now={NOW} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/pauses in 7 days/)).toBeInTheDocument();
  });

  it('reads as tomorrow rather than "in 1 days"', () => {
    render(<DigestPausingBanner digestPausesAt={pausesIn(1)} now={NOW} />);
    expect(screen.getByText(/pauses tomorrow/)).toBeInTheDocument();
  });

  // Once it has already stopped, "pauses in 0 days" is wrong and the message a
  // user needs is about restarting it, which is not this banner's job.
  it('stays hidden once the digest has already paused', () => {
    render(<DigestPausingBanner digestPausesAt={pausesIn(-3)} now={NOW} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders nothing when the API sent no pause date', () => {
    const { container } = render(<DigestPausingBanner digestPausesAt={null} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing rather than NaN for an unparseable date', () => {
    const { container } = render(<DigestPausingBanner digestPausesAt="not-a-date" now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DigestPausingBanner interaction', () => {
  it('offers the upload route, which is the only thing that resets the clock', () => {
    render(<DigestPausingBanner digestPausesAt={pausesIn(3)} now={NOW} />);
    expect(screen.getByRole('link', { name: /upload a csv/i }).getAttribute('href')).toBe('/upload');
  });

  it('stays dismissed for the rest of the session', async () => {
    const user = userEvent.setup();
    render(<DigestPausingBanner digestPausesAt={pausesIn(3)} now={NOW} />);

    await user.click(screen.getByRole('button', { name: /dismiss banner/i }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('digestPausingBanner:dismissed')).toBe('1');
  });

  // sessionStorage does not exist on the server, so getServerSnapshot has to
  // answer "not dismissed" without reading it. Otherwise the server can omit a
  // banner the browser then decides to render, which is a hydration mismatch
  // rather than a flash.
  it('renders server-side even when this session dismissed it', () => {
    window.sessionStorage.setItem('digestPausingBanner:dismissed', '1');

    const html = renderToString(<DigestPausingBanner digestPausesAt={pausesIn(3)} now={NOW} />);

    expect(html).toContain('role="status"');
  });
});
