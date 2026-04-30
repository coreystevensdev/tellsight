import type { Metadata } from 'next';
import InviteManager from './InviteManager';

export const metadata: Metadata = {
  title: 'Invite Team Members, Tellsight',
};

export default function InvitesPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <InviteManager />
    </div>
  );
}
