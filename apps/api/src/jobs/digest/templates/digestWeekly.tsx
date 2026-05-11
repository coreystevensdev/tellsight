// Email-safe digest template, table-based layout, inline styles only.
// Brand tokens hex-translated from `apps/web/app/globals.css`:
//   --color-foreground   oklch(0.145 0 0)        -> #1f2937 body / #111827 heading
//   --color-primary      oklch(0.55 0.15 250)    -> #2563eb CTA + link
//   --color-background   oklch(1 0 0)            -> #f6f7f9 page bg, #ffffff card
//   --color-border       oklch(0.92 0 0)         -> #e5e7eb
//   --color-muted-fg     oklch(0.55 0 0)         -> #6b7280 disclaimer / #9ca3af footer
// MSO + Gmail webmail strip <style> blocks and ignore flexbox/grid; tables and
// inline styles are the universally rendered subset. Don't reach for media
// queries here, fluid 100% outer + 600px inner is the survivable shape.
import { AI_DISCLAIMER, DIGEST_UTM_PARAMS } from 'shared/constants';

import { env } from '../../../config.js';
import { signUnsubscribeToken } from '../unsubscribeToken.js';

export interface DigestWeeklyProps {
  orgName: string;
  bullets: string[];
  dashboardUrl: string;
  unsubscribeUrl: string;
  mailingAddress: string;
  companyName: string;
  // Open-tracking pixel src; when undefined the <img> is omitted (dev/test
  // renders without a token still produce valid HTML). Body-end placement is
  // industry convention, the pixel doesn't block content render in clients
  // that pre-fetch sequentially.
  openTrackingUrl?: string;
}

const colors = {
  pageBg: '#f6f7f9',
  cardBg: '#ffffff',
  border: '#e5e7eb',
  heading: '#111827',
  body: '#1f2937',
  primary: '#2563eb',
  primaryText: '#ffffff',
  disclaimer: '#6b7280',
  footer: '#9ca3af',
};

const fontStack =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const styles = {
  body: { margin: 0, padding: 0, backgroundColor: colors.pageBg, fontFamily: fontStack },
  outerCell: { padding: '24px 16px', backgroundColor: colors.pageBg },
  containerTable: {
    maxWidth: '600px',
    width: '100%',
    margin: '0 auto',
    backgroundColor: colors.cardBg,
    border: `1px solid ${colors.border}`,
    borderRadius: '6px',
  },
  cardCell: { padding: '24px' },
  heading: {
    margin: '0 0 16px 0',
    color: colors.heading,
    fontFamily: fontStack,
    fontSize: '18px',
    fontWeight: 600,
    lineHeight: 1.4,
  },
  bullet: {
    margin: '0 0 12px 0',
    color: colors.body,
    fontFamily: fontStack,
    fontSize: '14px',
    lineHeight: 1.6,
  },
  ctaWrap: { padding: '16px 0 8px 0' },
  ctaLink: {
    display: 'inline-block',
    padding: '12px 20px',
    backgroundColor: colors.primary,
    color: colors.primaryText,
    fontFamily: fontStack,
    fontSize: '14px',
    fontWeight: 600,
    textDecoration: 'none',
    borderRadius: '6px',
  },
  disclaimer: {
    margin: '16px 0 0 0',
    color: colors.disclaimer,
    fontFamily: fontStack,
    fontSize: '11px',
    lineHeight: 1.5,
  },
  footerCell: { padding: '16px 24px 0 24px' },
  footerText: {
    margin: '0 0 6px 0',
    color: colors.footer,
    fontFamily: fontStack,
    fontSize: '11px',
    lineHeight: 1.5,
    textAlign: 'center' as const,
  },
  footerLink: { color: colors.footer, textDecoration: 'underline' },
};

export function DigestWeekly({
  orgName,
  bullets,
  dashboardUrl,
  unsubscribeUrl,
  mailingAddress,
  companyName,
  openTrackingUrl,
}: DigestWeeklyProps) {
  const recipientExplanation = buildRecipientExplanation(orgName);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${orgName} weekly insights`}</title>
      </head>
      <body style={styles.body}>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={{ backgroundColor: colors.pageBg }}>
          <tbody>
            <tr>
              <td align="center" style={styles.outerCell}>
                <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0} style={styles.containerTable}>
                  <tbody>
                    <tr>
                      <td style={styles.cardCell}>
                        <h1 style={styles.heading}>{`${orgName} weekly insights`}</h1>
                        {bullets.map((bullet, i) => (
                          <p key={i} style={styles.bullet}>
                            {bullet}
                          </p>
                        ))}
                        <table role="presentation" align="center" cellPadding={0} cellSpacing={0} border={0}>
                          <tbody>
                            <tr>
                              <td align="center" style={styles.ctaWrap}>
                                <a href={dashboardUrl} style={styles.ctaLink}>
                                  See full dashboard &gt;
                                </a>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                        <p style={styles.disclaimer}>{AI_DISCLAIMER}</p>
                      </td>
                    </tr>
                    <tr>
                      <td style={styles.footerCell}>
                        <p style={styles.footerText}>{recipientExplanation}</p>
                        <p style={styles.footerText}>
                          <a href={unsubscribeUrl} style={styles.footerLink}>
                            Unsubscribe from these emails
                          </a>
                        </p>
                        <p style={styles.footerText}>{mailingAddress}</p>
                        <p style={styles.footerText}>{companyName}</p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
        {openTrackingUrl && (
          <img
            src={openTrackingUrl}
            alt=""
            width={1}
            height={1}
            style={{ display: 'block', border: 0, width: 1, height: 1 }}
          />
        )}
      </body>
    </html>
  );
}

// Single source of truth for the explanation string. Both the template render
// and the perSend handler's CAN-SPAM audit log call this so the rendered HTML
// and the audit log can never drift.
export function buildRecipientExplanation(orgName: string): string {
  return `You're receiving this because you're a Pro subscriber at ${orgName}`;
}

// Splits the v1-digest output into trimmed bullet strings. Defensive: max 5
// bullets, each trimmed of leading dashes/whitespace, empty lines skipped.
export function parseSummaryToBullets(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.replace(/^[\s-]+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
}

export function buildDashboardUrl(datasetId: number, trackingToken?: string): string {
  const url = new URL('/dashboard', env.APP_URL);
  url.searchParams.set('datasetId', String(datasetId));
  for (const [key, value] of Object.entries(DIGEST_UTM_PARAMS)) {
    url.searchParams.set(key, value);
  }
  // Carrying the token on the CTA URL lets the dashboard's click tracker
  // recover {userId, orgId, weekStart} on mount, no server lookup needed.
  if (trackingToken) {
    url.searchParams.set('t', trackingToken);
  }
  return url.toString();
}

export function buildUnsubscribeUrl(userId: number): string {
  const token = signUnsubscribeToken(userId);
  return new URL(`/unsubscribe/digest/${encodeURIComponent(token)}`, env.APP_URL).toString();
}
