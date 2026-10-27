import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import LandingPage from './page';

describe('LandingPage', () => {
  it('renders the product story and primary navigation', () => {
    render(<LandingPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: /your spreadsheet,\s*actually explained/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the demo' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute(
      'href',
      '/login',
    );

    const storyHeadings = screen.getAllByRole('heading', { level: 2 });
    expect(storyHeadings.map((heading) => heading.textContent)).toEqual([
      'Ask it directly, instead of hunting through charts.',
      'Every figure opens up.',
      "It also watches for what you'd otherwise miss.",
      'It arrives whether or not you log in.',
      'Your raw numbers never reach the AI.',
    ]);
  });
});
