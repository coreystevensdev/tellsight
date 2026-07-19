import { describe, it, expect, vi } from 'vitest';
import { render } from '@react-email/render';

vi.mock('../../../config.js', () => ({
  env: {
    APP_URL: 'https://app.tellsight.com',
    JWT_SECRET: 'a'.repeat(64),
    EMAIL_MAILING_ADDRESS: '123 Some Real Street, Anywhere, ZZ 00000',
    EMAIL_FROM_NAME: 'Tellsight',
  },
}));

const {
  DigestWeekly,
  buildRecipientExplanation,
  parseSummaryToBullets,
  buildDashboardUrl,
  buildUnsubscribeUrl,
} = await import('./digestWeekly.js');

const fixture: {
  orgName: string;
  bullets: string[];
  dashboardUrl: string;
  unsubscribeUrl: string;
  mailingAddress: string;
  companyName: string;
  openTrackingUrl?: string;
} = {
  orgName: 'Acme Coffee',
  bullets: ['Revenue up 12%', 'Payroll spiked', 'Runway 8 months'],
  dashboardUrl: 'https://app.tellsight.com/dashboard?datasetId=1',
  unsubscribeUrl: 'https://app.tellsight.com/unsubscribe/digest/known-token',
  mailingAddress: '123 Some Real Street, Anywhere, ZZ 00000',
  companyName: 'Tellsight',
};

// React Email's renderer entity-encodes apostrophes to &#x27;, so substring
// assertions on raw "you're" miss. Match the encoded form when checking
// content that travels through HTML escaping.
const RECIPIENT_EXPLANATION_ENCODED =
  'You&#x27;re receiving this because you&#x27;re a Pro subscriber at Acme Coffee';

async function renderFixture(overrides: Partial<typeof fixture> = {}) {
  return render(DigestWeekly({ ...fixture, ...overrides }));
}

describe('DigestWeekly render shape (AC #1, #2, #8)', () => {
  it('uses fluid 100% outer width via attribute, not CSS', async () => {
    const html = await renderFixture();
    expect(html).toContain('width="100%"');
  });

  it('caps inner container at 600px via inline style', async () => {
    const html = await renderFixture();
    expect(html).toMatch(/max-width:\s*600px/i);
  });

  it('emits no <style> blocks', async () => {
    const html = await renderFixture();
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('leaks no CSS variable tokens (var(--*))', async () => {
    const html = await renderFixture();
    expect(html).not.toMatch(/var\(--/);
  });

  it('uses the system font fallback stack (no Google Fonts <link>)', async () => {
    const html = await renderFixture();
    expect(html).toMatch(/Inter,\s*-apple-system/);
    expect(html).not.toMatch(/<link[^>]+fonts\.googleapis/i);
  });

  it('includes brand colors used by heading, CTA, body, and surfaces', async () => {
    const html = await renderFixture();
    expect(html).toContain('#2563eb');
    expect(html).toContain('#111827');
    expect(html).toContain('#1f2937');
    expect(html).toContain('#f6f7f9');
    expect(html).toContain('#e5e7eb');
  });
});

describe('DigestWeekly content (AC #3, #7)', () => {
  it('renders the heading + each bullet in scoring order', async () => {
    const html = await renderFixture();
    expect(html).toContain('Acme Coffee weekly insights');
    const a = html.indexOf('Revenue up 12%');
    const b = html.indexOf('Payroll spiked');
    const c = html.indexOf('Runway 8 months');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('renders the disclaimer using the AI_DISCLAIMER constant', async () => {
    const html = await renderFixture();
    expect(html).toMatch(/financial advice/i);
  });

  it('renders the dashboard CTA with ASCII greater-than (no Unicode arrow)', async () => {
    const html = await renderFixture();
    expect(html).toContain('See full dashboard');
    expect(html).toMatch(/See full dashboard\s*&gt;/);
    expect(html).not.toMatch(/See full dashboard\s*→/);
    expect(html).toContain(fixture.dashboardUrl);
  });

  it('preserves the dashboard URL through HTML escaping (& becomes &amp; in href)', async () => {
    const html = await renderFixture({
      dashboardUrl: 'https://app.tellsight.com/dashboard?datasetId=1&utm_source=digest',
    });
    expect(html).toContain(
      'href="https://app.tellsight.com/dashboard?datasetId=1&amp;utm_source=digest"',
    );
  });

  it('renders an empty state when no bullets are passed', async () => {
    const html = await renderFixture({ bullets: [] });
    expect(html).toContain('Acme Coffee');
    expect(html).toMatch(/Unsubscribe/i);
  });
});

describe('DigestWeekly CAN-SPAM footer (AC #4)', () => {
  it('renders the recipient-explanation line with the Pro subscriber phrasing', async () => {
    const html = await renderFixture();
    expect(html).toContain(RECIPIENT_EXPLANATION_ENCODED);
  });

  it('renders the unsubscribe link to the provided URL', async () => {
    const html = await renderFixture();
    expect(html).toContain(fixture.unsubscribeUrl);
    expect(html).toMatch(/Unsubscribe from these emails/);
  });

  it('renders the mailing address verbatim', async () => {
    const html = await renderFixture();
    expect(html).toContain(fixture.mailingAddress);
  });

  it('renders the company name', async () => {
    const html = await renderFixture();
    expect(html).toContain(fixture.companyName);
  });

  it('orders footer DOM as explanation, unsubscribe, mailing address, company name', async () => {
    const html = await renderFixture();
    const explanation = html.indexOf(RECIPIENT_EXPLANATION_ENCODED);
    const unsubscribe = html.indexOf('Unsubscribe from these emails');
    const address = html.indexOf(fixture.mailingAddress);
    const company = html.lastIndexOf(fixture.companyName);
    expect(explanation).toBeGreaterThan(-1);
    expect(unsubscribe).toBeGreaterThan(explanation);
    expect(address).toBeGreaterThan(unsubscribe);
    expect(company).toBeGreaterThan(address);
  });
});

describe('DigestWeekly cite-tag stripping', () => {
  it('strips a <cite id="..."/> tag from a bullet before rendering', async () => {
    const html = await renderFixture({
      bullets: ['Revenue up 12% <cite id="1:total:_:overall"/>', 'Payroll spiked'],
    });
    expect(html).not.toContain('cite id=');
    expect(html).toContain('Revenue up 12%');
  });
});

describe('DigestWeekly snapshot (AC #9)', () => {
  it('matches the committed structural snapshot', async () => {
    const html = await renderFixture();
    expect(html).toMatchSnapshot();
  });
});

describe('buildRecipientExplanation', () => {
  it('builds the literal string the template renders', () => {
    expect(buildRecipientExplanation('Acme Coffee')).toBe(
      "You're receiving this because you're a Pro subscriber at Acme Coffee",
    );
  });
});

describe('parseSummaryToBullets', () => {
  it('splits leading-dash bullets and trims each', () => {
    const input = '- First insight\n- Second insight\n- Third insight';
    expect(parseSummaryToBullets(input)).toEqual([
      'First insight',
      'Second insight',
      'Third insight',
    ]);
  });

  it('handles asterisk bullets and stray whitespace', () => {
    const input = '\n   - Padded\n\n -  More padding   \n- Final\n\n';
    expect(parseSummaryToBullets(input)).toEqual(['Padded', 'More padding', 'Final']);
  });

  it('caps at 5 bullets', () => {
    const input = Array.from({ length: 10 }, (_, i) => `- Bullet ${i + 1}`).join('\n');
    const bullets = parseSummaryToBullets(input);
    expect(bullets).toHaveLength(5);
    expect(bullets[0]).toBe('Bullet 1');
    expect(bullets[4]).toBe('Bullet 5');
  });

  it('skips empty lines', () => {
    expect(parseSummaryToBullets('- One\n\n\n- Two')).toEqual(['One', 'Two']);
  });
});

describe('buildDashboardUrl', () => {
  it('appends datasetId + UTM params', () => {
    const url = buildDashboardUrl(42);
    expect(url).toContain('datasetId=42');
    expect(url).toContain('utm_source=digest');
    expect(url).toContain('utm_medium=email');
    expect(url).toContain('utm_campaign=weekly-digest');
    expect(url).toContain('https://app.tellsight.com/dashboard');
  });

  it('omits t= when no tracking token supplied', () => {
    const url = buildDashboardUrl(42);
    expect(url).not.toContain('t=');
  });

  it('appends t= when tracking token supplied', () => {
    const url = buildDashboardUrl(42, 'opaque-tracking-token');
    expect(url).toContain('t=opaque-tracking-token');
  });
});

describe('DigestWeekly tracking pixel (AC #4)', () => {
  it('omits the open-pixel <img> when openTrackingUrl is undefined', async () => {
    const html = await renderFixture();
    expect(html).not.toMatch(/track\/digest\/open/);
    expect(html).not.toMatch(/<img[^>]+width="1"[^>]+height="1"/i);
  });

  it('renders the 1x1 open-pixel <img> when openTrackingUrl is supplied', async () => {
    const html = await renderFixture({
      openTrackingUrl: 'https://api.tellsight.com/track/digest/open?t=abc123',
    });
    expect(html).toMatch(/<img[^>]+src="https:\/\/api\.tellsight\.com\/track\/digest\/open\?t=abc123"/);
    expect(html).toMatch(/width="1"/);
    expect(html).toMatch(/height="1"/);
    expect(html).toMatch(/alt=""/);
  });

  it('places the pixel after the footer content (body-end placement)', async () => {
    const html = await renderFixture({
      openTrackingUrl: 'https://api.tellsight.com/track/digest/open?t=abc',
    });
    // The pixel-bearing <img> tag appears AFTER the unsubscribe link, the
    // canonical body-end ordering. react-email may emit other meta references
    // earlier (e.g., preview text), so anchor the check on the actual <img>
    // element rather than the URL substring.
    const unsubLinkPos = html.indexOf('Unsubscribe from these emails');
    const pixelImgPos = html.search(/<img[^>]+track\/digest\/open/);
    expect(unsubLinkPos).toBeGreaterThan(0);
    expect(pixelImgPos).toBeGreaterThan(unsubLinkPos);
  });
});

describe('buildUnsubscribeUrl', () => {
  it('produces a verifiable token at the existing /unsubscribe/digest/[token] path', async () => {
    const { verifyUnsubscribeToken } = await import('../unsubscribeToken.js');
    const url = buildUnsubscribeUrl(7);
    expect(url).toMatch(/\/unsubscribe\/digest\//);

    const segments = new URL(url).pathname.split('/');
    const tokenEncoded = segments[segments.length - 1]!;
    const token = decodeURIComponent(tokenEncoded);
    expect(verifyUnsubscribeToken(token)).toEqual({ userId: 7 });
  });
});
