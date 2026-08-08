'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Info } from 'lucide-react';

import { AI_DISCLAIMER, stripAllCiteTags } from 'shared/constants';
import type { TransparencyMetadata } from 'shared/types';
import { cn } from '@/lib/utils';
import { useQaAnswer, type QaAnswerState } from '@/lib/hooks/useQaAnswer';
import { UpgradeCta } from '@/components/common/UpgradeCta';
import { Spinner } from '@/components/ui/spinner';
import { StatDetailSheet } from './StatDetailSheet';
import { parseCiteBindings } from './parseCiteBindings';
import { NUMBER_PATTERN } from './numberPattern';
import { getSuggestedQuestions } from './suggestedQuestions';

interface QaAskBoxProps {
  datasetId: number | null;
  metadata?: TransparencyMetadata | null;
  className?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  QA_LOOP_FAILED: 'Something went wrong answering that question.',
  RATE_LIMITED: 'Too many requests, please wait a moment.',
  VALIDATION_ERROR: 'That question could not be sent, try rephrasing it.',
};

function userMessage(code: string | null, fallback: string | null): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback ?? 'Something went wrong answering that question.';
}

// assembleQaAnswer (qaAnswer.ts) already appends AI_DISCLAIMER to the answer
// text; this box renders its own styled footer below instead of the plain
// trailing paragraph, so the appended suffix gets stripped to avoid showing
// the disclaimer twice.
function stripTrailingDisclaimer(text: string): string {
  const suffix = `\n\n${AI_DISCLAIMER}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

// Citation-only counterpart to AiSummaryCard's highlightNumbers: Q&A answers
// only ever carry <cite> tokens, never the <stat> chart-drill-down tokens
// AiSummaryCard also handles, so this stays a small local function against
// the same two shared parsing helpers instead of extracting that file's version.
function highlightCitedNumbers(
  text: string,
  citesByNumber: Map<number, string[]> | undefined,
  onOpenCite: (statId: string) => void,
): React.ReactNode[] {
  const parts = text.split(NUMBER_PATTERN);
  let numberIndex = -1;

  return parts.map((part, i) => {
    if (i % 2 === 0) return <span key={i}>{part}</span>;

    numberIndex++;
    const statIds = citesByNumber?.get(numberIndex) ?? [];

    return (
      <span key={i} className="font-semibold text-accent-warm" style={{ fontFeatureSettings: '"tnum"' }}>
        {part}
        {statIds.map((statId, citeIndex) => (
          <button
            key={`${statId}-${citeIndex}`}
            type="button"
            onClick={() => onOpenCite(statId)}
            className="ml-0.5 inline-flex h-3.5 w-3.5 align-super text-accent-warm/60 hover:text-accent-warm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-warm"
            aria-label={
              statIds.length > 1
                ? `Show how ${part} was calculated (source ${citeIndex + 1} of ${statIds.length})`
                : `Show how ${part} was calculated`
            }
          >
            <Info className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          </button>
        ))}
      </span>
    );
  });
}

function AnswerText({ rawText, onOpenCite }: { rawText: string; onOpenCite: (statId: string) => void }) {
  const citations = parseCiteBindings(rawText);
  const citesByParagraph = new Map<number, Map<number, string[]>>();
  for (const c of citations) {
    let byNumber = citesByParagraph.get(c.paragraphIndex);
    if (!byNumber) {
      byNumber = new Map();
      citesByParagraph.set(c.paragraphIndex, byNumber);
    }
    const ids = byNumber.get(c.numberIndex);
    if (ids) ids.push(c.statId);
    else byNumber.set(c.numberIndex, [c.statId]);
  }

  const displayText = stripTrailingDisclaimer(stripAllCiteTags(rawText));
  const paragraphs = displayText.split('\n\n').filter(Boolean);
  // stripTrailingDisclaimer only strips the exact `\n\n${AI_DISCLAIMER}`
  // suffix qaAnswer.ts appends by default. If the model's own prose already
  // echoed the disclaimer (qaAnswer.ts's double-append guard), it survives
  // here as part of the message body, so the footer below is skipped
  // instead of showing the disclaimer twice.
  const showFooter = !displayText.includes(AI_DISCLAIMER);

  return (
    <>
      <div className="text-[15px] leading-[1.7] text-card-foreground/85 [&>p+p]:mt-[1.1em]">
        {paragraphs.map((p, i) => (
          <p key={i}>{highlightCitedNumbers(p, citesByParagraph.get(i), onOpenCite)}</p>
        ))}
      </div>
      {showFooter && (
        <p className="mt-3 text-[11px] leading-tight text-muted-foreground/60">{AI_DISCLAIMER}</p>
      )}
    </>
  );
}

export function QaAskBox({ datasetId, metadata, className }: QaAskBoxProps) {
  const [question, setQuestion] = useState('');
  const [openCiteId, setOpenCiteId] = useState<string | null>(null);
  const [priorDatasetId, setPriorDatasetId] = useState(datasetId);
  const [staleAnswer, setStaleAnswer] = useState<QaAnswerState | null>(null);
  const qaAnswer = useQaAnswer(datasetId);
  const inputId = useId();
  const router = useRouter();

  // A citation sheet or in-flight question tied to the previous dataset
  // shouldn't survive a dataset switch. useQaAnswer resets its own state on
  // the same dependency, but that reset lands a render later via effect
  // cleanup, so snapshot its still-stale output here and mask it below until
  // the real output actually moves off the snapshot.
  if (datasetId !== priorDatasetId) {
    setPriorDatasetId(datasetId);
    setQuestion('');
    setOpenCiteId(null);
    setStaleAnswer({ status: qaAnswer.status, answer: qaAnswer.answer, error: qaAnswer.error, code: qaAnswer.code });
  } else if (
    staleAnswer &&
    (qaAnswer.status !== staleAnswer.status ||
      qaAnswer.answer !== staleAnswer.answer ||
      qaAnswer.error !== staleAnswer.error ||
      qaAnswer.code !== staleAnswer.code)
  ) {
    setStaleAnswer(null);
  }

  const { status, answer, error, code, ask } = staleAnswer
    ? { status: 'idle' as const, answer: null, error: null, code: null, ask: qaAnswer.ask }
    : qaAnswer;

  const isAsking = status === 'asking';
  const canSubmit = question.trim().length > 0 && !isAsking && status !== 'locked' && datasetId !== null;

  function askQuestion(text: string) {
    // A fresh ask on the current dataset is unambiguous proof we're past
    // the masking window -- clear it here instead of waiting on the
    // qaAnswer comparison above, which can get stuck if the new ask's
    // 'asking' state happens to match the stale snapshot field-for-field.
    setStaleAnswer(null);
    ask(text);
  }

  function submit() {
    if (!canSubmit) return;
    askQuestion(question.trim());
  }

  function askSuggested(text: string) {
    if (isAsking || status === 'locked' || datasetId === null) return;
    setQuestion(text);
    askQuestion(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // isComposing is true while an IME candidate (CJK input) is still being
    // confirmed -- treating that Enter as submit fires the question mid-composition.
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function handleUpgrade() {
    router.push('/billing');
  }

  return (
    <div
      className={cn('border-t-2 border-accent-warm bg-ai-surface p-5 md:p-8', className)}
      role="region"
      aria-label="Ask a question about your data"
    >
      <h3 className="font-serif text-lg font-medium text-card-foreground">Ask a question</h3>
      <p className="mb-4 text-xs text-muted-foreground">Limited to the data behind this dashboard.</p>

      {status === 'idle' && (
        <div className="mb-3 flex flex-wrap gap-2">
          {getSuggestedQuestions(metadata?.statTypes).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => askSuggested(suggestion)}
              disabled={isAsking || datasetId === null}
              className={cn(
                'inline-flex items-center rounded-full border border-border bg-card px-3 py-2 text-xs font-medium text-card-foreground',
                'transition-colors duration-200 ease-out hover:border-primary/40',
                'focus:outline-none focus:ring-2 focus:ring-primary/40',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          Ask a question about your data
        </label>
        <input
          id={inputId}
          type="text"
          value={question}
          placeholder="e.g. How did revenue trend this quarter?"
          disabled={isAsking}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            'min-h-11 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-primary/40',
            'disabled:opacity-50',
          )}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className={cn(
            'min-h-11 min-w-11 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
            'hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          Ask
        </button>
      </div>

      {isAsking && (
        <div
          className="mt-4 flex items-center gap-2 text-sm text-muted-foreground animate-fade-in"
          aria-live="polite"
        >
          <Spinner />
          Thinking...
        </div>
      )}

      {status === 'locked' && (
        <div className="mt-4">
          <UpgradeCta variant="inline" onUpgrade={handleUpgrade} />
        </div>
      )}

      {status === 'error' && (
        <div className="mt-4" aria-live="assertive">
          <p className="text-sm font-medium text-destructive">{userMessage(code, error)}</p>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="mt-2 inline-flex min-h-11 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Try again
          </button>
        </div>
      )}

      {status === 'answered' && answer && (
        <div className="mt-4 animate-fade-in">
          <AnswerText rawText={answer.answer} onOpenCite={setOpenCiteId} />
        </div>
      )}

      <StatDetailSheet
        open={openCiteId !== null}
        onOpenChange={(open) => !open && setOpenCiteId(null)}
        datasetId={datasetId}
        statId={openCiteId}
      />
    </div>
  );
}
