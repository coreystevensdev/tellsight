import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface UnsubscribeResult {
  success: boolean;
  message: string;
}

async function unsubscribe(token: string): Promise<UnsubscribeResult> {
  // Absolute URL required for server-to-server fetch during RSC render.
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
  try {
    const res = await fetch(`${base}/digest/unsubscribe/${encodeURIComponent(token)}`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (res.ok) {
      return {
        success: true,
        message: "You won't receive any more weekly digest emails. You can re-enable them anytime from your settings.",
      };
    }
    const body = await res.json().catch(() => ({}));
    return {
      success: false,
      message: body?.error?.message ?? 'This unsubscribe link has expired or is invalid.',
    };
  } catch {
    return {
      success: false,
      message: "We couldn't reach our server. Please try again in a few minutes.",
    };
  }
}

export default async function UnsubscribeDigestPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await unsubscribe(token);

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-md px-6 py-20">
        <div className="rounded-lg border border-border bg-background p-10 shadow-sm">
          <div
            className={`mb-6 h-10 w-10 rounded-full ${result.success ? 'bg-success' : 'bg-destructive'}`}
            aria-hidden="true"
          />
          <h1 className="mb-3 text-xl font-semibold text-foreground">
            {result.success ? "You've unsubscribed" : 'This link isn\u2019t valid'}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{result.message}</p>
          <div className="mt-8 flex items-center gap-4 text-sm">
            <Link href="/" className="text-primary hover:underline">
              Back to Tellsight
            </Link>
            {!result.success && (
              <Link href="/settings/preferences" className="text-muted-foreground hover:text-foreground">
                Manage preferences
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
