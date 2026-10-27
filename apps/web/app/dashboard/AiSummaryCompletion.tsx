'use client';

import { useEffect, useRef } from 'react';
import { AI_DISCLAIMER, ANALYTICS_EVENTS } from 'shared/constants';

import { UpgradeCta } from '@/components/common/UpgradeCta';
import { trackClientEvent } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import { ShareMenu, type LinkStatus, type ShareStatus } from './ShareMenu';
import { SummaryText } from './SummaryText';

interface PostCompletionFooterProps {
  onToggleTransparency?: () => void;
  transparencyOpen?: boolean;
  onShare?: () => Promise<void>;
  onShareDownload?: () => void;
  onShareCopy?: () => Promise<void>;
  shareState?: ShareStatus;
  onShareCopyLink?: () => Promise<void>;
  shareLinkStatus?: LinkStatus;
  shareLinkClipboardFailed?: boolean;
  onExportPdf?: () => Promise<void>;
  pdfStatus?: 'idle' | 'generating' | 'done' | 'error';
}

// Every summary path renders the disclaimer, including the free preview where
// completion actions are intentionally withheld.
function AiDisclaimer() {
  return <p className="mt-3 text-[11px] leading-tight text-muted-foreground">{AI_DISCLAIMER}</p>;
}

export function PostCompletionFooter({
  onToggleTransparency,
  transparencyOpen,
  onShare,
  onShareDownload,
  onShareCopy,
  shareState = 'idle',
  onShareCopyLink,
  shareLinkStatus,
  shareLinkClipboardFailed,
  onExportPdf,
  pdfStatus,
}: PostCompletionFooterProps) {
  return (
    <div className="mt-4 border-t border-border pt-4 animate-fade-in">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="min-h-11 text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={onToggleTransparency}
          aria-expanded={transparencyOpen}
          disabled={!onToggleTransparency}
        >
          How I reached this conclusion
          <span
            className={cn(
              'ml-1 inline-block transition-transform duration-150',
              transparencyOpen && 'rotate-180',
            )}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
        <div className="ml-auto">
          {onShare && onShareDownload && onShareCopy ? (
            <ShareMenu
              status={shareState}
              onGenerate={onShare}
              onDownload={onShareDownload}
              onCopy={onShareCopy}
              onCopyLink={onShareCopyLink}
              linkStatus={shareLinkStatus}
              linkClipboardFailed={shareLinkClipboardFailed}
              onExportPdf={onExportPdf}
              pdfStatus={pdfStatus}
            />
          ) : (
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              disabled
            >
              Share
            </button>
          )}
        </div>
      </div>
      <AiDisclaimer />
    </div>
  );
}

export function FreePreviewOverlay({
  previewText,
  onUpgrade,
}: {
  previewText: string;
  onUpgrade: () => void;
}) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    trackClientEvent(ANALYTICS_EVENTS.AI_PREVIEW_VIEWED);
  }, []);

  return (
    <div className="relative">
      <SummaryText text={previewText} />

      <div className="relative mt-0" aria-hidden="true">
        <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-card/0 to-card z-10" />
        <div className="select-none blur-sm opacity-60">
          <div className="text-sm leading-[1.6] md:text-[15px] md:leading-[1.7] [&>p+p]:mt-[1em]">
            <p>
              Continue reading to discover key trends in your revenue growth, expense patterns, and
              actionable recommendations for optimizing your business performance over the coming
              quarter.
            </p>
            <p>
              Our analysis identifies several opportunities for cost reduction and revenue
              acceleration based on your historical data patterns.
            </p>
          </div>
        </div>
      </div>

      <div className="relative z-20 -mt-8 flex justify-center">
        <UpgradeCta variant="overlay" onUpgrade={onUpgrade} />
      </div>

      <AiDisclaimer />
    </div>
  );
}
