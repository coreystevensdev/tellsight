import { BackLink } from '@/components/common/BackLink';
import { BillingContent } from './BillingContent';

export default function BillingPage() {
  return (
    <div className="flex flex-col items-center px-4 pb-12 pt-12">
      <div className="w-full max-w-[640px]">
        <BackLink />
        <h1 className="mb-8 text-2xl font-semibold tracking-tight">Billing</h1>
        <BillingContent />
      </div>
    </div>
  );
}
