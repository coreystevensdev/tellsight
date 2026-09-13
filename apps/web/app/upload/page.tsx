import { BackLink } from '@/components/common/BackLink';
import { InvoiceFlowCard } from './InvoiceFlowCard';
import { UploadDropzone } from './UploadDropzone';
import { QuickBooksCard } from '@/components/QuickBooksCard';

export default function UploadPage() {
  return (
    <div className="flex flex-col items-center px-4 pb-12 pt-12">
      <div className="w-full max-w-[1024px]">
        <BackLink />
        <h1 className="mb-8 text-2xl font-semibold tracking-tight">Upload Data</h1>
        <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
          <UploadDropzone />
          <QuickBooksCard />
        </div>
        <InvoiceFlowCard className="mt-6" />
      </div>
    </div>
  );
}
