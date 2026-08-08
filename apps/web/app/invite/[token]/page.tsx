import type { Metadata } from 'next';
import { TellsightLogo } from '@/components/common/TellsightLogo';
import InviteAccept from './InviteAccept';

export const metadata: Metadata = {
  title: 'Join Organization, Tellsight',
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-6">
      <div className="flex items-center gap-2">
        <TellsightLogo size={24} />
        <span className="font-serif text-lg font-medium text-foreground">Tellsight</span>
      </div>
      <InviteAccept token={token} />
    </div>
  );
}
