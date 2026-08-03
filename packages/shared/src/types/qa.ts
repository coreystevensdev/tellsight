// Mirrors apps/api's QaLoopResult/QaAnswer shape (qaLoop.ts, qaAnswer.ts) so web
// and api share one response contract instead of the web side re-declaring it.
export type QaTermination = 'answered' | 'turn-cap' | 'cost-exceeded' | 'breaker-open';

export interface QaAnswer {
  answer: string;
  citedStatIds: string[];
  termination: QaTermination;
  turnCount: number;
}
