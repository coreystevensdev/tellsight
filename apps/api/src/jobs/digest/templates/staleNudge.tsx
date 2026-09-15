// Email-safe stale-data nudge, table layout and inline styles only, same
// constraints as digestWeekly and alertEmail. Each template in this codebase
// carries its own colors/styles rather than sharing a chrome module: email
// clients strip <style> blocks and the survivable subset is small enough that
// a shared abstraction costs more than the duplication.
import { env } from '../../../config.js';
import { buildRecipientExplanation } from './digestWeekly.js';

export interface StaleNudgeProps {
  orgName: string;
  daysSinceData: number;
  uploadUrl: string;
  unsubscribeUrl: string;
  mailingAddress: string;
  companyName: string;
}

const colors = {
  pageBg: '#f6f7f9',
  cardBg: '#ffffff',
  border: '#e5e7eb',
  heading: '#111827',
  body: '#1f2937',
  primary: '#2563eb',
  primaryText: '#ffffff',
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
    backgroundColor: colors.cardBg,
    border: `1px solid ${colors.border}`,
    borderRadius: '8px',
  },
  contentCell: { padding: '32px 28px 24px' },
  heading: { margin: '0 0 12px', fontSize: '20px', lineHeight: '28px', color: colors.heading },
  paragraph: { margin: '0 0 16px', fontSize: '15px', lineHeight: '24px', color: colors.body },
  ctaCell: { paddingTop: '8px' },
  ctaLink: {
    display: 'inline-block',
    padding: '10px 20px',
    backgroundColor: colors.primary,
    color: colors.primaryText,
    fontSize: '14px',
    fontWeight: 600,
    borderRadius: '6px',
    textDecoration: 'none',
  },
  footerCell: { padding: '16px 28px 24px', borderTop: `1px solid ${colors.border}` },
  footerText: { margin: '0 0 6px', fontSize: '12px', lineHeight: '18px', color: colors.footer },
  footerLink: { color: colors.footer, textDecoration: 'underline' },
};

/**
 * Sent once when an org's weekly digest stops, never on a repeat schedule. The
 * copy says what happened and why rather than asking for a re-engagement: the
 * digest compares this week to last, and over an unchanged dataset it has
 * nothing to compare, so stopping is the product working rather than failing.
 */
export function StaleNudge({
  orgName,
  daysSinceData,
  uploadUrl,
  unsubscribeUrl,
  mailingAddress,
  companyName,
}: StaleNudgeProps) {
  return (
    <html lang="en">
      <body style={styles.body}>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
          <tbody>
            <tr>
              <td align="center" style={styles.outerCell}>
                <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={styles.containerTable}>
                  <tbody>
                    <tr>
                      <td style={styles.contentCell}>
                        <h1 style={styles.heading}>Your weekly digest has paused</h1>
                        <p style={styles.paragraph}>
                          {orgName} has not had new data in {daysSinceData} days, so there is nothing
                          for this week&apos;s digest to compare against. Rather than send you the same
                          numbers again, we have stopped until there is something new to say.
                        </p>
                        <p style={styles.paragraph}>
                          Upload a CSV and the weekly digest starts again on the next send.
                        </p>
                        <table role="presentation" cellPadding={0} cellSpacing={0} border={0}>
                          <tbody>
                            <tr>
                              <td style={styles.ctaCell}>
                                <a href={uploadUrl} style={styles.ctaLink}>
                                  Upload your latest data
                                </a>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style={styles.footerCell}>
                        <p style={styles.footerText}>{buildRecipientExplanation(orgName)}</p>
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
      </body>
    </html>
  );
}

export function buildUploadUrl(): string {
  return new URL('/upload', env.APP_URL).toString();
}
