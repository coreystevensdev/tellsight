// Email-safe alert template, same table/inline-style convention as
// digestWeekly.tsx: raw <table role="presentation">, no <style> blocks, no
// @react-email/components, 600px single-column, no media queries.
import { ALERT_DISCLAIMER } from 'shared/constants';

export interface AlertEmailProps {
  orgName: string;
  headline: string;
  paragraph: string;
  dashboardUrl: string;
  muteUrl: string;
  mailingAddress: string;
  companyName: string;
  ruleKindLabel: string;
  // CID of the attached chart PNG (see EmailProvider.attachments). Omitted
  // for rule kinds with no chart mapping, or when rendering degraded to
  // text-only; the <img> is skipped entirely rather than left broken.
  chartContentId?: string;
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
  paragraph: {
    margin: '0 0 16px 0',
    color: colors.body,
    fontFamily: fontStack,
    fontSize: '14px',
    lineHeight: 1.6,
  },
  chartCell: { padding: '0 0 16px 0' },
  chartImage: { display: 'block', width: '100%', maxWidth: '600px', height: 'auto', border: 0 },
  ctaWrap: { padding: '8px 0 8px 0' },
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

export function AlertEmail({
  orgName,
  headline,
  paragraph,
  dashboardUrl,
  muteUrl,
  mailingAddress,
  companyName,
  ruleKindLabel,
  chartContentId,
}: AlertEmailProps) {
  const recipientExplanation = buildAlertRecipientExplanation(ruleKindLabel, orgName);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{headline}</title>
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
                        <h1 style={styles.heading}>{headline}</h1>
                        <p style={styles.paragraph}>{paragraph}</p>
                        {chartContentId && (
                          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
                            <tbody>
                              <tr>
                                <td style={styles.chartCell}>
                                  <img
                                    src={`cid:${chartContentId}`}
                                    alt={`${headline} chart`}
                                    width={600}
                                    height={300}
                                    style={styles.chartImage}
                                  />
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        )}
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
                        <p style={styles.disclaimer}>{ALERT_DISCLAIMER}</p>
                      </td>
                    </tr>
                    <tr>
                      <td style={styles.footerCell}>
                        <p style={styles.footerText}>{recipientExplanation}</p>
                        <p style={styles.footerText}>
                          <a href={muteUrl} style={styles.footerLink}>
                            Mute this alert for 30 days
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
      </body>
    </html>
  );
}

// Single source of truth for the reason-for-receipt line: both the rendered
// HTML and the send handler's CAN-SPAM audit log call this so they can't drift.
export function buildAlertRecipientExplanation(ruleKindLabel: string, orgName: string): string {
  return `You're receiving this because you have an active alert rule for ${ruleKindLabel} in ${orgName}`;
}
