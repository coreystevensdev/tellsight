import type {
  SseDoneEvent,
  SseTextEvent,
  SseUpgradeRequiredEvent,
} from 'shared/types';
import type { SubscriptionTier } from '../../db/queries/subscriptions.js';
import { FREE_PREVIEW_WORD_LIMIT } from 'shared/constants';
import { aiFirstTokenDuration, aiSummaryDuration } from '../../lib/metrics.js';
import type { StreamSession } from './streamSession.js';

type EmitSseEvent = (event: string, data: unknown) => void;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export class StreamTextPolicy {
  private accumulatedText = '';
  private firstTokenSeen = false;
  private truncatedForFree = false;

  constructor(
    private readonly tier: SubscriptionTier,
    private readonly streamStart: number,
    private readonly session: StreamSession,
    private readonly emit: EmitSseEvent,
  ) {}

  get text(): string {
    return this.accumulatedText;
  }

  get truncated(): boolean {
    return this.truncatedForFree;
  }

  handleDelta(delta: string): void {
    if (this.session.clientDisconnected || this.session.ended || this.truncatedForFree) return;

    // An empty first delta still counts as the provider's first response and
    // must latch the metric so a later delta cannot overwrite its latency.
    if (!this.firstTokenSeen) {
      this.firstTokenSeen = true;
      aiFirstTokenDuration.observe(
        { tier: this.tier },
        (Date.now() - this.streamStart) / 1000,
      );
    }

    this.accumulatedText += delta;
    if (
      this.tier === 'free' &&
      countWords(this.accumulatedText) >= FREE_PREVIEW_WORD_LIMIT
    ) {
      this.truncatedForFree = true;
      this.emit('text', { text: delta } satisfies SseTextEvent);
      this.emit('upgrade_required', {
        wordCount: countWords(this.accumulatedText),
      } satisfies SseUpgradeRequiredEvent);
      this.emit('done', { usage: null, reason: 'free_preview' } satisfies SseDoneEvent);
      aiSummaryDuration.observe(
        { tier: this.tier, outcome: 'free_preview' },
        (Date.now() - this.streamStart) / 1000,
      );
      this.session.end();
      this.session.abort();
      return;
    }

    this.emit('text', { text: delta } satisfies SseTextEvent);
  }
}
