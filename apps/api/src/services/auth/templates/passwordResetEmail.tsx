// Same table/inline-style convention as the alert and digest templates:
// raw <table role="presentation">, no <style> blocks, no @react-email/components,
// 600px single-column, no media queries.

export interface PasswordResetEmailProps {
  resetUrl: string;
  expiryHours: number;
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
  ctaWrap: { padding: '8px 0 16px 0' },
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
  footerCell: { padding: '16px 24px 0 24px' },
  footerText: {
    margin: '0 0 6px 0',
    color: colors.footer,
    fontFamily: fontStack,
    fontSize: '11px',
    lineHeight: 1.5,
    textAlign: 'center' as const,
  },
};

export function PasswordResetEmail({
  resetUrl,
  expiryHours,
  mailingAddress,
  companyName,
}: PasswordResetEmailProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Reset your password</title>
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
                        <h1 style={styles.heading}>Reset your password</h1>
                        <p style={styles.paragraph}>
                          Someone requested a password reset for your {companyName} account. If this
                          was you, click below to choose a new password. This link expires in{' '}
                          {expiryHours} hour{expiryHours === 1 ? '' : 's'}.
                        </p>
                        <table role="presentation" cellPadding={0} cellSpacing={0} border={0}>
                          <tbody>
                            <tr>
                              <td style={styles.ctaWrap}>
                                <a href={resetUrl} style={styles.ctaLink}>
                                  Reset password
                                </a>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                        <p style={styles.paragraph}>
                          If you didn&apos;t request this, you can safely ignore this email, your
                          password won&apos;t change.
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <td style={styles.footerCell}>
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
