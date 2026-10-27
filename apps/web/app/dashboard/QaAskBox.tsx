'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { TransparencyMetadata } from 'shared/types';
import { cn } from '@/lib/utils';
import { useQaAnswer, type QaAnswerState } from '@/lib/hooks/useQaAnswer';
import { UpgradeCta } from '@/components/common/UpgradeCta';
import { Spinner } from '@/components/ui/spinner';
import { StatDetailSheet } from './StatDetailSheet';
import { QaAnswerText } from './QaAnswerText';
import { getSuggestedQuestions } from './suggestedQuestions';

interface QaAskBoxProps {
  datasetId: number | null;
  metadata?: TransparencyMetadata | null;
  className?: string;
  // A question composed by a click on a chart. The nonce, not the text, marks it
  // as new: clicking the same bar twice should ask twice rather than be swallowed
  // as an unchanged prop.
  askFromChart?: { text: string; nonce: number } | null;
  // Defaults to false: /qa is on protectedRouter, so a caller that forgets
  // this should offer nothing rather than a control that 401s.
  hasAuth?: boolean;
}

// Second copy of this shape; AiSummaryCard has the other. Both fall through to
// the API's own `message` for an unmapped code, which is how "Missing access
// token" reached a reader there. If a third surface needs one, share it.
const ERROR_MESSAGES: Record<string, string> = {
  QA_LOOP_FAILED: 'That question could not be answered. Try asking it a different way.',
  RATE_LIMITED: "You've hit the request limit. Wait a minute, then try again.",
  VALIDATION_ERROR: 'That question could not be sent. Try rephrasing it.',
  AUTHENTICATION_REQUIRED: 'Your session expired. Sign in again to ask a question.',
};

function userMessage(code: string | null, fallback: string | null): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return fallback ?? 'That question could not be answered. Try asking it a different way.';
}

export function QaAskBox({
  datasetId,
  metadata,
  className,
  askFromChart,
  hasAuth = false,
}: QaAskBoxProps) {
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
    setStaleAnswer({
      status: qaAnswer.status,
      answer: qaAnswer.answer,
      error: qaAnswer.error,
      code: qaAnswer.code,
    });
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
  const canSubmit =
    question.trim().length > 0 && !isAsking && status !== 'locked' && datasetId !== null;

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
    if (!hasAuth || isAsking || status === 'locked' || datasetId === null) return;
    setQuestion(text);
    askQuestion(text);
  }

  // Same path a suggestion chip takes, so a chart click cannot ask while one is
  // in flight, while the tier gate is closed, or with no dataset. The ref holds
  // the last nonce acted on rather than the last text, so two clicks on the same
  // point still ask twice; askSuggested is deliberately not a dependency, since
  // it is rebuilt every render and the ref is what decides whether to fire.
  const lastChartAsk = useRef<number | null>(null);
  useEffect(() => {
    if (!askFromChart || askFromChart.nonce === lastChartAsk.current) return;
    lastChartAsk.current = askFromChart.nonce;
    askSuggested(askFromChart.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askFromChart]);

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
      <p className="mb-4 text-xs text-muted-foreground">
        Limited to the data behind this dashboard.
      </p>

      {!hasAuth && (
        <p className="mb-4 text-sm text-muted-foreground">
          Sign in to ask questions about this data.
        </p>
      )}

      {status === 'idle' && (
        <div className="mb-3 flex flex-wrap gap-2">
          {getSuggestedQuestions(metadata?.statTypes).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => askSuggested(suggestion)}
              disabled={!hasAuth || isAsking || datasetId === null}
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
          disabled={!hasAuth || isAsking}
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
          <QaAnswerText rawText={answer.answer} onOpenCite={setOpenCiteId} />
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
