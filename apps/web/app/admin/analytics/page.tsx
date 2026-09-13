import { AnalyticsEventsTable } from '../AnalyticsEventsTable';
import { BackLink } from '@/components/common/BackLink';

export default function AnalyticsPage() {
  return (
    <div className="space-y-6 p-4 md:p-6 lg:p-8">
      <BackLink href="/admin" label="Back to admin" />
      <h1 className="text-2xl font-semibold tracking-tight">Analytics Events</h1>
      <AnalyticsEventsTable />
    </div>
  );
}
