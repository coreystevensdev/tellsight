import type { DigestValence } from '../../db/queries/digestHistory.js';
import type { MilestoneKind, TransitionMilestone } from './milestones.js';

type MilestoneRegister = 'positive' | 'concerning';

const MILESTONE_REGISTER: Record<MilestoneKind, MilestoneRegister> = {
  turned_cash_positive: 'positive',
  crossed_break_even: 'positive',
  runway_extended_past_6mo: 'positive',
  margin_turned_expanding: 'positive',
  turned_cash_negative: 'concerning',
  runway_dropped_below_3mo: 'concerning',
  forecast_crosses_zero: 'concerning',
};

// Dedicated per-kind phrase, deliberately non-numeric: milestone.label embeds
// thresholds (6mo, 3mo, a computed forecast month) meant for the authenticated
// email body, not an unauthenticated subject line / inbox preview.
const MILESTONE_PHRASES: Record<MilestoneKind, string> = {
  turned_cash_positive: "You're generating a cash surplus",
  crossed_break_even: "You've cleared break-even",
  runway_extended_past_6mo: 'Your runway just got healthier',
  margin_turned_expanding: 'Your margins are trending up',
  turned_cash_negative: 'Your cash flow just flipped negative',
  runway_dropped_below_3mo: 'Your runway needs attention',
  forecast_crosses_zero: 'Your forecast is trending toward a shortfall',
};

// Deliberately close in tone to MILESTONE_PHRASES.runway_dropped_below_3mo
// ('...needs attention'); keep both in sync if either changes.
const RUNWAY_ATTENTION_PHRASE = 'Your runway needs a look';
const POSITIVE_FALLBACK_PHRASE = 'Good momentum this week';
const WATCHING_FALLBACK_PHRASE = "Here's what changed this week";

const SPAM_TRIGGERS = [
  'free',
  'act now',
  'urgent',
  'cash now',
  'limited time',
  'winner',
  'guarantee',
  'risk-free',
  'click here',
  '100%',
  '!!!',
];

function findMilestoneByRegister(
  milestones: readonly TransitionMilestone[],
  register: MilestoneRegister,
): TransitionMilestone | undefined {
  return milestones.find((m) => MILESTONE_REGISTER[m.kind] === register);
}

// Priority: (1) concerning valence leads with a concerning-register milestone
// if one fired, else the generic runway phrase (classifyValence's only
// concerning trigger is runwayMonths < 3, so the topic is deterministic
// without inspecting stats). (2) outside a concerning week, any milestone's
// phrase still outranks a generic fallback, whichever register, because a
// concerning-register milestone (e.g. turned_cash_negative) can fire while
// runway alone keeps valence at 'watching'. (3) positive and (4) watching get
// generic fallback phrases; (5) neutral gets none, since classifyValence's own
// comment documents neutral as a defensive floor no real stat array reaches.
export function generateSubjectLine(
  valence: DigestValence,
  milestones: readonly TransitionMilestone[],
  orgName: string,
): string {
  let topicPhrase: string | undefined;

  if (valence === 'concerning') {
    const concerning = findMilestoneByRegister(milestones, 'concerning');
    topicPhrase = concerning ? MILESTONE_PHRASES[concerning.kind] : RUNWAY_ATTENTION_PHRASE;
  } else if (milestones.length > 0) {
    topicPhrase = MILESTONE_PHRASES[milestones[0]!.kind];
  } else if (valence === 'positive') {
    topicPhrase = POSITIVE_FALLBACK_PHRASE;
  } else if (valence === 'watching') {
    topicPhrase = WATCHING_FALLBACK_PHRASE;
  }

  return topicPhrase ? `${topicPhrase} - ${orgName} weekly insights` : `${orgName} weekly insights`;
}

export function containsSpamTrigger(text: string): boolean {
  const lower = text.toLowerCase();
  return SPAM_TRIGGERS.some((trigger) => lower.includes(trigger));
}
