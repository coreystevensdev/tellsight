import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';

import { AlertEmail, buildAlertRecipientExplanation } from './alertEmail.js';

const fixture: {
  orgName: string;
  headline: string;
  paragraph: string;
  dashboardUrl: string;
  muteUrl: string;
  mailingAddress: string;
  companyName: string;
  ruleKindLabel: string;
  chartContentId?: string;
} = {
  orgName: 'Acme Coffee',
  headline: 'Your cash runway is running short',
  paragraph: 'Your runway is now 2.0 months at the current burn rate, worth reviewing fixed costs.',
  dashboardUrl: 'https://app.tellsight.com/dashboard?datasetId=1',
  muteUrl: 'https://app.tellsight.com/mute/alert-rule/known-token',
  mailingAddress: '123 Some Real Street, Anywhere, ZZ 00000',
  companyName: 'Tellsight',
  ruleKindLabel: 'cash runway',
};

const RECIPIENT_EXPLANATION_ENCODED =
  'You&#x27;re receiving this because you have an active alert rule for cash runway in Acme Coffee';

async function renderFixture(overrides: Partial<typeof fixture> = {}) {
  return render(AlertEmail({ ...fixture, ...overrides }));
}

describe('AlertEmail render shape', () => {
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
});

describe('AlertEmail content', () => {
  it('renders the headline and the interpretation paragraph', async () => {
    const html = await renderFixture();
    expect(html).toContain('Your cash runway is running short');
    expect(html).toContain('Your runway is now 2.0 months');
  });

  it('renders the dashboard CTA with ASCII greater-than (no Unicode arrow)', async () => {
    const html = await renderFixture();
    expect(html).toMatch(/See full dashboard\s*&gt;/);
    expect(html).toContain(fixture.dashboardUrl);
  });

  it('renders the ALERT_DISCLAIMER text, distinct from the digest disclaimer', async () => {
    const html = await renderFixture();
    expect(html).toContain('Information only. Not financial advice. Consult your accountant for decisions.');
  });
});

describe('AlertEmail chart image', () => {
  it('omits the chart <img> when chartContentId is undefined', async () => {
    const html = await renderFixture();
    expect(html).not.toMatch(/<img/);
  });

  it('renders a cid:-referenced <img> when chartContentId is provided, never base64', async () => {
    const html = await renderFixture({ chartContentId: 'chart-999' });
    expect(html).toMatch(/<img[^>]+src="cid:chart-999"/);
    expect(html).not.toContain('data:image');
  });
});

describe('AlertEmail CAN-SPAM footer', () => {
  it('renders the reason-for-receipt line naming the rule kind and org', async () => {
    const html = await renderFixture();
    expect(html).toContain(RECIPIENT_EXPLANATION_ENCODED);
  });

  it('renders the mute link to the provided URL', async () => {
    const html = await renderFixture();
    expect(html).toContain(fixture.muteUrl);
    expect(html).toMatch(/Mute this alert for 30 days/);
  });

  it('renders the mailing address verbatim', async () => {
    const html = await renderFixture();
    expect(html).toContain(fixture.mailingAddress);
  });

  it('renders the company name', async () => {
    const html = await renderFixture();
    expect(html).toContain(fixture.companyName);
  });

  it('orders footer DOM as explanation, mute link, mailing address, company name', async () => {
    const html = await renderFixture();
    const explanation = html.indexOf(RECIPIENT_EXPLANATION_ENCODED);
    const mute = html.indexOf('Mute this alert for 30 days');
    const address = html.indexOf(fixture.mailingAddress);
    const company = html.lastIndexOf(fixture.companyName);
    expect(explanation).toBeGreaterThan(-1);
    expect(mute).toBeGreaterThan(explanation);
    expect(address).toBeGreaterThan(mute);
    expect(company).toBeGreaterThan(address);
  });
});

describe('AlertEmail cite-tag stripping', () => {
  it('strips a <cite id="..."/> tag from the paragraph before rendering', async () => {
    const html = await renderFixture({
      paragraph: 'Your runway is now 2.0 months <cite id="1:runway:_:_"/>, worth reviewing.',
    });
    expect(html).not.toContain('cite id=');
    expect(html).toContain('Your runway is now 2.0 months');
  });
});

describe('AlertEmail snapshot', () => {
  it('matches the committed structural snapshot (text-only)', async () => {
    const html = await renderFixture();
    expect(html).toMatchSnapshot();
  });

  it('matches the committed structural snapshot (with chart)', async () => {
    const html = await renderFixture({ chartContentId: 'chart-999' });
    expect(html).toMatchSnapshot();
  });
});

describe('buildAlertRecipientExplanation', () => {
  it('builds the literal string the template renders', () => {
    expect(buildAlertRecipientExplanation('cash runway', 'Acme Coffee')).toBe(
      "You're receiving this because you have an active alert rule for cash runway in Acme Coffee",
    );
  });
});
