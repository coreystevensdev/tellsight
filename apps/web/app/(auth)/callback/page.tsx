import type { Metadata } from 'next';
import CallbackHandler from './CallbackHandler';

export const metadata: Metadata = {
  title: 'Signing in...',
};

export default async function CallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string; error?: string }>;
}) {
  const params = await searchParams;

  if (params.error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-4 rounded-lg bg-card p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">Authentication Failed</h1>
          <p className="text-sm text-muted-foreground">
            Google denied the sign-in request. Please try again.
          </p>
          <a
            href="/login"
            className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Back to Sign In
          </a>
        </div>
      </div>
    );
  }

  return <CallbackHandler code={params.code} state={params.state} />;
}
