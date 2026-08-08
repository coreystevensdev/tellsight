import { TellsightLogo } from '@/components/common/TellsightLogo';
import { MuteConfirmCard } from './MuteConfirmCard';

export const dynamic = 'force-dynamic';

export default async function MuteAlertRuleConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-md px-6 pt-16 pb-20">
        <div className="mb-8 flex items-center justify-center gap-2">
          <TellsightLogo size={24} />
          <span className="font-serif text-lg font-medium text-foreground">Tellsight</span>
        </div>
        <div className="rounded-lg border border-border bg-card p-10 shadow-sm">
          <h1 className="mb-3 font-serif text-2xl font-medium tracking-tight text-foreground">Mute this alert?</h1>
          <MuteConfirmCard token={token} />
        </div>
      </div>
    </div>
  );
}
