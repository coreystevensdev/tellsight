import { InvoiceFlowCard } from './InvoiceFlowCard';
import { UploadDropzone } from './UploadDropzone';
import { QuickBooksCard } from '@/components/integrations/QuickBooksCard';

export default function UploadPage() {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 pt-12">
      <div className="w-full max-w-[1024px]">
        <h1 className="mb-8 text-2xl font-semibold tracking-tight">Upload Data</h1>
        <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
          <UploadDropzone />
          <QuickBooksCard />
        </div>
        <InvoiceFlowCard className="mt-6" />
      </div>
    </main>
  );
}
