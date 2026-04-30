'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Copy, Share2, Check, Loader2, Link2, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

export type ShareStatus = 'idle' | 'generating' | 'done' | 'error';
export type LinkStatus = 'idle' | 'creating' | 'done' | 'error';
export type PdfStatus = 'idle' | 'generating' | 'done' | 'error';

interface ShareMenuProps {
  status: ShareStatus;
  onGenerate: () => Promise<void>;
  onDownload: () => void;
  onCopy: () => Promise<void>;
  onCopyLink?: () => Promise<void>;
  linkStatus?: LinkStatus;
  linkClipboardFailed?: boolean;
  onExportPdf?: () => Promise<void>;
  pdfStatus?: PdfStatus;
  className?: string;
}

type ActionFeedback = 'idle' | 'downloaded' | 'copied' | 'linked' | 'pdf';

const FEEDBACK_DURATION_MS = 2000;

function ShareOptions({
  status,
  onDownload,
  onCopy,
  onGenerate,
  onCopyLink,
  linkStatus = 'idle',
  linkClipboardFailed = false,
  onExportPdf,
  pdfStatus = 'idle',
}: Pick<ShareMenuProps, 'status' | 'onDownload' | 'onCopy' | 'onGenerate' | 'onCopyLink' | 'linkStatus' | 'linkClipboardFailed' | 'onExportPdf' | 'pdfStatus'>) {
  const isGenerating = status === 'generating';
  const isLinking = linkStatus === 'creating';
  const [feedback, setFeedback] = useState<ActionFeedback>('idle');
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showFeedback = useCallback((type: ActionFeedback) => {
    clearTimeout(feedbackTimer.current);
    setFeedback(type);
    feedbackTimer.current = setTimeout(() => setFeedback('idle'), FEEDBACK_DURATION_MS);
  }, []);

  useEffect(() => () => clearTimeout(feedbackTimer.current), []);

  const handleDownload = useCallback(async () => {
    await onGenerate();
    onDownload();
    showFeedback('downloaded');
  }, [onGenerate, onDownload, showFeedback]);

  const handleCopy = useCallback(async () => {
    await onGenerate();
    await onCopy();
    showFeedback('copied');
  }, [onGenerate, onCopy, showFeedback]);

  const handleCopyLink = useCallback(async () => {
    if (!onCopyLink) return;
    await onCopyLink();
    showFeedback('linked');
  }, [onCopyLink, showFeedback]);

  const handleExportPdf = useCallback(async () => {
    if (!onExportPdf) return;
    await onExportPdf();
    showFeedback('pdf');
  }, [onExportPdf, showFeedback]);

  const feedbackText: Record<Exclude<ActionFeedback, 'idle'>, string> = {
    downloaded: 'Downloaded!',
    copied: 'Copied to clipboard!',
    linked: 'Link copied!',
    pdf: 'PDF saved!',
  };

  return (
    <div className="flex flex-col gap-1 p-1">
      {isGenerating && (
        <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Generating image...
        </div>
      )}
      {pdfStatus === 'generating' && (
        <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Generating PDF...
        </div>
      )}
      {pdfStatus === 'error' && (
        <p className="px-3 py-2 text-sm text-destructive" role="status" aria-live="polite">
          Failed to generate PDF. Try again.
        </p>
      )}
      {isLinking && (
        <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Creating link...
        </div>
      )}
      {status === 'error' && (
        <p className="px-3 py-2 text-sm text-destructive" role="status" aria-live="polite">
          Failed to generate image. Try again.
        </p>
      )}
      {linkStatus === 'error' && (
        <p className="px-3 py-2 text-sm text-destructive" role="status" aria-live="polite">
          Failed to create link. Try again.
        </p>
      )}
      {linkClipboardFailed && (
        <p className="px-3 py-2 text-xs text-warning" role="status" aria-live="polite">
          Link created but clipboard unavailable, copy from the URL bar.
        </p>
      )}
      {feedback !== 'idle' && (
        <p className="px-3 py-1.5 text-xs font-medium text-success" role="status" aria-live="polite">
          {feedbackText[feedback]}
        </p>
      )}
      {onCopyLink && (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          onClick={handleCopyLink}
          disabled={isLinking}
          aria-label="Copy link"
        >
          {feedback === 'linked' ? (
            <Check className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <Link2 className="h-4 w-4" aria-hidden="true" />
          )}
          Copy link
        </button>
      )}
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onClick={handleDownload}
        disabled={isGenerating}
        aria-label="Download PNG"
      >
        {feedback === 'downloaded' ? (
          <Check className="h-4 w-4 text-success" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4" aria-hidden="true" />
        )}
        Download PNG
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onClick={handleCopy}
        disabled={isGenerating}
        aria-label="Copy to clipboard"
      >
        {feedback === 'copied' ? (
          <Check className="h-4 w-4 text-success" aria-hidden="true" />
        ) : (
          <Copy className="h-4 w-4" aria-hidden="true" />
        )}
        Copy image
      </button>
      {onExportPdf && (
        <>
          <div className="mx-2 my-1 border-t border-border" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onClick={handleExportPdf}
            disabled={pdfStatus === 'generating'}
            aria-label="Download PDF report"
          >
            {feedback === 'pdf' ? (
              <Check className="h-4 w-4 text-success" aria-hidden="true" />
            ) : (
              <FileText className="h-4 w-4" aria-hidden="true" />
            )}
            Download PDF
          </button>
        </>
      )}
    </div>
  );
}

export function ShareMenu({ status, onGenerate, onDownload, onCopy, onCopyLink, linkStatus, linkClipboardFailed, onExportPdf, pdfStatus, className }: ShareMenuProps) {
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
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-popover shadow-md animate-in fade-in-0 zoom-in-95 motion-reduce:duration-0"
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

export function ShareFab({ visible, status, onGenerate, onDownload, onCopy, onCopyLink, linkStatus, linkClipboardFailed, onExportPdf, pdfStatus }: ShareFabProps) {
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
