'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  BUSINESS_TYPES,
  REVENUE_RANGES,
  TEAM_SIZES,
  TOP_CONCERNS,
} from 'shared/schemas';
import type { BusinessProfile } from 'shared/types';

interface OnboardingModalProps {
  onComplete: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  restaurant: 'Restaurant / Cafe',
  retail: 'Retail',
  services: 'Professional Services',
  construction: 'Construction / Trades',
  healthcare: 'Healthcare',
  technology: 'Technology',
  manufacturing: 'Manufacturing',
  real_estate: 'Real Estate',
  transportation: 'Transportation',
  other: 'Other',
};

const REVENUE_LABELS: Record<string, string> = {
  under_100k: 'Under $100K',
  '100k_500k': '$100K, $500K',
  '500k_2m': '$500K, $2M',
  over_2m: 'Over $2M',
};

const TEAM_LABELS: Record<string, string> = {
  solo: 'Just me',
  '2_5': '2-5 people',
  '6_20': '6-20 people',
  over_20: '20+ people',
};

const CONCERN_LABELS: Record<string, string> = {
  cash_flow: 'Cash flow',
  growth: 'Growing revenue',
  cost_control: 'Cutting costs',
  seasonal_planning: 'Seasonal planning',
  profitability: 'Profitability',
};

type Step = 'businessType' | 'revenueRange' | 'teamSize' | 'topConcern';
const STEPS: Step[] = ['businessType', 'revenueRange', 'teamSize', 'topConcern'];

const STEP_CONFIG: Record<Step, { question: string; options: readonly string[]; labels: Record<string, string> }> = {
  businessType: { question: 'What kind of business do you run?', options: BUSINESS_TYPES, labels: TYPE_LABELS },
  revenueRange: { question: 'Roughly how much revenue per year?', options: REVENUE_RANGES, labels: REVENUE_LABELS },
  teamSize: { question: 'How big is your team?', options: TEAM_SIZES, labels: TEAM_LABELS },
  topConcern: { question: 'What do you most want help with?', options: TOP_CONCERNS, labels: CONCERN_LABELS },
};

export function OnboardingModal({ onComplete }: OnboardingModalProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [answers, setAnswers] = useState<Partial<BusinessProfile>>({});
  const [saving, setSaving] = useState(false);

  const step = STEPS[stepIdx]!;
  const config = STEP_CONFIG[step];
  const isLast = stepIdx === STEPS.length - 1;

  async function handleSelect(value: string) {
    const next = { ...answers, [step]: value };
    setAnswers(next);

    if (isLast) {
      setSaving(true);
      try {
        await apiClient('/org/profile', { method: 'PUT', body: JSON.stringify(next) });
      } catch {
        // profile save failed, continue anyway, don't block the dashboard
      }
      onComplete();
      return;
    }

    setStepIdx((i) => i + 1);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in">
      <div className="w-full max-w-md rounded-xl border border-border/50 bg-card p-6 shadow-2xl md:p-8">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{stepIdx + 1} of {STEPS.length}</span>
          <button
            type="button"
            onClick={onComplete}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Skip
          </button>
        </div>

        <div className="mb-1 h-1 rounded-full bg-muted">
          <div
            className="h-1 rounded-full bg-primary transition-all duration-300"
            style={{ width: `${((stepIdx + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        <h2 className="mt-5 text-lg font-semibold text-foreground">{config.question}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This helps the AI tailor insights to your business.
        </p>

        <div className="mt-5 grid gap-2">
          {config.options.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={saving}
              onClick={() => handleSelect(opt)}
              className="rounded-lg border border-border px-4 py-3 text-left text-sm font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-accent disabled:opacity-50"
            >
              {config.labels[opt] ?? opt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
