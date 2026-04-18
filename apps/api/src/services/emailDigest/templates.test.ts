import { describe, it, expect } from 'vitest';
import { renderProDigest, renderFreeTeaser } from './templates.js';

describe('renderProDigest', () => {
  const props = {
    orgName: 'Sunrise Cafe',
    summary: '- Revenue up 12%\n- Costs stable\n- Weekend traffic increased',
    dashboardUrl: 'https://app.tellsight.com',
  };

  it('includes org name in heading', () => {
    const html = renderProDigest(props);
    expect(html).toContain('Sunrise Cafe');
  });

  it('renders each summary line as a list item', () => {
    const html = renderProDigest(props);
    expect(html).toContain('<li');
    expect(html).toContain('Revenue up 12%');
    expect(html).toContain('Costs stable');
    expect(html).toContain('Weekend traffic increased');
  });

  it('strips leading dashes from summary lines', () => {
    const html = renderProDigest(props);
    // the dash-space prefix should be removed, not doubled
    expect(html).not.toContain('<li style="margin-bottom:8px;">- Revenue');
  });

  it('includes dashboard link', () => {
    const html = renderProDigest(props);
    expect(html).toContain('href="https://app.tellsight.com"');
  });

  it('includes AI disclaimer', () => {
    const html = renderProDigest(props);
    expect(html).toContain('AI-generated analysis');
  });

  it('links to preferences page for unsubscribe', () => {
    const html = renderProDigest(props);
    expect(html).toContain('/settings/preferences');
  });

  it('produces valid HTML structure', () => {
    const html = renderProDigest(props);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html).toContain('lang="en"');
  });
});

describe('renderFreeTeaser', () => {
  const props = {
    orgName: 'Corner Shop',
    dashboardUrl: 'https://app.tellsight.com',
  };

  it('includes org name', () => {
    const html = renderFreeTeaser(props);
    expect(html).toContain('Corner Shop');
  });

  it('promotes upgrade to Pro', () => {
    const html = renderFreeTeaser(props);
    expect(html).toContain('Upgrade to Pro');
    expect(html).toContain('$29/mo');
  });

  it('links to billing page', () => {
    const html = renderFreeTeaser(props);
    expect(html).toContain('href="https://app.tellsight.com/billing"');
  });

  it('does NOT include AI-generated content or disclaimer', () => {
    const html = renderFreeTeaser(props);
    // free teaser has no AI summary, so no disclaimer needed
    expect(html).not.toContain('AI-generated analysis');
  });

  it('includes unsubscribe link', () => {
    const html = renderFreeTeaser(props);
    expect(html).toContain('/settings/preferences');
  });
});
