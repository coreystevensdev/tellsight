import { DigestUnsubscribeConfirmCard } from './DigestUnsubscribeConfirmCard';

export const dynamic = 'force-dynamic';

export default async function DigestUnsubscribeConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-md px-6 py-20">
        <div className="rounded-lg border border-border bg-background p-10 shadow-sm">
          <h1 className="mb-3 text-xl font-semibold text-foreground">Unsubscribe from weekly digests?</h1>
          <DigestUnsubscribeConfirmCard token={token} />
        </div>
      </div>
    </div>
  );
}
