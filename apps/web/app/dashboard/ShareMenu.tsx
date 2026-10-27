'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import {
  ShareOptions,
  type LinkStatus,
  type PdfStatus,
  type ShareOptionsProps,
  type ShareStatus,
} from './ShareOptions';

export type { LinkStatus, PdfStatus, ShareStatus } from './ShareOptions';

interface ShareMenuProps {
  status: ShareOptionsProps['status'];
  onGenerate: ShareOptionsProps['onGenerate'];
  onDownload: ShareOptionsProps['onDownload'];
  onCopy: ShareOptionsProps['onCopy'];
  onCopyLink?: ShareOptionsProps['onCopyLink'];
  linkStatus?: ShareOptionsProps['linkStatus'];
  linkClipboardFailed?: ShareOptionsProps['linkClipboardFailed'];
  onExportPdf?: ShareOptionsProps['onExportPdf'];
  pdfStatus?: ShareOptionsProps['pdfStatus'];
  className?: string;
}

export function ShareMenu({
  status,
  onGenerate,
  onDownload,
  onCopy,
  onCopyLink,
  linkStatus,
  linkClipboardFailed,
  onExportPdf,
  pdfStatus,
  className,
}: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // click-outside to close
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // move focus into panel on open, back to trigger on close
  useEffect(() => {
    if (open) {
      const firstBtn = panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      firstBtn?.focus();
    }
  }, [open]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      triggerRef.current?.focus();
    }
  }, []);

  return (
    <div className={cn('relative', className)} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((v) => !v)}
        aria-label="Share"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Share2 className="inline-block h-3.5 w-3.5 mr-1" aria-hidden="true" />
        Share
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-card shadow-md animate-in fade-in-0 zoom-in-95 motion-reduce:duration-0"
          onKeyDown={handleKeyDown}
        >
          <ShareOptions
            status={status}
            onGenerate={onGenerate}
            onDownload={onDownload}
            onCopy={onCopy}
            onCopyLink={onCopyLink}
            linkStatus={linkStatus}
            linkClipboardFailed={linkClipboardFailed}
            onExportPdf={onExportPdf}
            pdfStatus={pdfStatus}
          />
        </div>
      )}
    </div>
  );
}

interface ShareFabProps {
  visible: boolean;
  status: ShareStatus;
  onGenerate: () => Promise<void>;
  onDownload: () => void;
  onCopy: () => Promise<void>;
  onCopyLink?: () => Promise<void>;
  linkStatus?: LinkStatus;
  linkClipboardFailed?: boolean;
  onExportPdf?: () => Promise<void>;
  pdfStatus?: PdfStatus;
}

export function ShareFab({
  visible,
  status,
  onGenerate,
  onDownload,
  onCopy,
  onCopyLink,
  linkStatus,
  linkClipboardFailed,
  onExportPdf,
  pdfStatus,
}: ShareFabProps) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!visible || !isMobile) return null;

  return (
    <>
      <button
        type="button"
        className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none"
        onClick={() => setSheetOpen(true)}
        aria-label="Share insight"
      >
        <Share2 className="h-5 w-5" aria-hidden="true" />
      </button>

      <Sheet open={sheetOpen} onOpenChange={(open) => !open && setSheetOpen(false)}>
        <SheetContent side="bottom" className="rounded-t-xl motion-reduce:duration-0">
          <SheetTitle>Share insight</SheetTitle>
          <ShareOptions
            status={status}
            onGenerate={onGenerate}
            onDownload={onDownload}
            onCopy={onCopy}
            onCopyLink={onCopyLink}
            linkStatus={linkStatus}
            linkClipboardFailed={linkClipboardFailed}
            onExportPdf={onExportPdf}
            pdfStatus={pdfStatus}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
