import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface MuteResult {
  success: boolean;
  message: string;
  unmuteHref?: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

async function muteRule(token: string): Promise<MuteResult> {
  // Absolute URL required for server-to-server fetch during RSC render.
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
  try {
    const res = await fetch(`${base}/alerts/mute/${encodeURIComponent(token)}`, {
      method: 'POST',
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const { muteUntil, ruleKindLabel, orgName } = body.data as {
        muteUntil: string;
        ruleKindLabel: string;
        orgName: string;
      };
      return {
        success: true,
        message: `You won't hear about ${ruleKindLabel} for ${orgName} until ${formatDate(muteUntil)}.`,
        unmuteHref: `/mute/alert-rule/${encodeURIComponent(token)}/unmute`,
      };
    }
    return {
      success: false,
      message: body?.error?.message ?? 'This mute link has expired or is invalid.',
    };
  } catch {
    return {
      success: false,
      message: "We couldn't reach our server. Please try again in a few minutes.",
    };
  }
}

export default async function MuteAlertRulePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await muteRule(token);

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-md px-6 py-20">
        <div className="rounded-lg border border-border bg-background p-10 shadow-sm">
          <div
            className={`mb-6 h-10 w-10 rounded-full ${result.success ? 'bg-success' : 'bg-destructive'}`}
            aria-hidden="true"
          />
          <h1 className="mb-3 text-xl font-semibold text-foreground">
            {result.success ? 'Muted for 30 days' : 'This link isn’t valid'}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{result.message}</p>
          <div className="mt-8 flex items-center gap-4 text-sm">
            <Link href="/" className="text-primary hover:underline">
              Back to Tellsight
            </Link>
            {result.success && result.unmuteHref && (
              <Link
                href={result.unmuteHref}
                className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90"
              >
                Unmute
              </Link>
            )}
            {!result.success && (
              <Link href="/settings/alerts" className="text-muted-foreground hover:text-foreground">
                Manage alerts
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
