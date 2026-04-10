import type { Metadata } from 'next';
import InviteManager from './InviteManager';

export const metadata: Metadata = {
  title: 'Invite Team Members — SaaS Analytics Dashboard',
};

export default function InvitesPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <InviteManager />
    </div>
  );
}
