import { AI_DISCLAIMER } from 'shared/constants';

interface ProDigestProps {
  orgName: string;
  summary: string;
  dashboardUrl: string;
}

interface FreeTeaserProps {
  orgName: string;
  dashboardUrl: string;
}

const STYLES = {
  body: 'margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background-color:#f9fafb;',
  container: 'max-width:580px;margin:0 auto;padding:32px 20px;',
  card: 'background:#ffffff;border-radius:8px;padding:32px;border:1px solid #e5e7eb;',
  h1: 'margin:0 0 4px;font-size:20px;font-weight:600;color:#111827;',
  subtitle: 'margin:0 0 24px;font-size:14px;color:#6b7280;',
  summary: 'font-size:15px;line-height:1.7;color:#374151;',
  cta: 'display:inline-block;margin-top:24px;padding:12px 24px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;',
  disclaimer: 'margin-top:24px;font-size:11px;color:#9ca3af;line-height:1.4;',
  footer: 'margin-top:24px;text-align:center;font-size:12px;color:#9ca3af;',
} as const;

function formatSummaryHtml(summary: string): string {
  return summary
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const trimmed = line.replace(/^-\s*/, '');
      return `<li style="margin-bottom:8px;">${trimmed}</li>`;
    })
    .join('');
}

export function renderProDigest({ orgName, summary, dashboardUrl }: ProDigestProps): string {
  const weekOf = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${STYLES.body}">
  <div style="${STYLES.container}">
    <div style="${STYLES.card}">
      <h1 style="${STYLES.h1}">${orgName}</h1>
      <p style="${STYLES.subtitle}">Weekly insights — ${weekOf}</p>
      <ul style="${STYLES.summary}padding-left:20px;">
        ${formatSummaryHtml(summary)}
      </ul>
      <a href="${dashboardUrl}" style="${STYLES.cta}">View full dashboard</a>
      <p style="${STYLES.disclaimer}">${AI_DISCLAIMER}</p>
    </div>
    <p style="${STYLES.footer}">
      You're receiving this because you're on the Pro plan.<br>
      <a href="${dashboardUrl}/settings/preferences" style="color:#6b7280;">Manage email preferences</a>
    </p>
  </div>
</body>
</html>`;
}

export function renderFreeTeaser({ orgName, dashboardUrl }: FreeTeaserProps): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="${STYLES.body}">
  <div style="${STYLES.container}">
    <div style="${STYLES.card}">
      <h1 style="${STYLES.h1}">${orgName}</h1>
      <p style="${STYLES.subtitle}">Your weekly business update is ready</p>
      <p style="${STYLES.summary}">
        We analyzed your latest data and found insights worth reviewing.
        Upgrade to Pro to get AI-powered weekly digests delivered to your inbox
        with the most important changes in your business.
      </p>
      <a href="${dashboardUrl}/billing" style="${STYLES.cta}">Upgrade to Pro — $29/mo</a>
    </div>
    <p style="${STYLES.footer}">
      You're receiving this because you have an account.<br>
      <a href="${dashboardUrl}/settings/preferences" style="color:#6b7280;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`;
}
