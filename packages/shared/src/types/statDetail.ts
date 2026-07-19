export interface StatDetailTerm {
  label: string;
  value: string;
}

// Arithmetic stats (total, average, cash_flow, runway, break_even,
// year_over_year, margin_trend, category_breakdown): a closed-form
// expression reconciles to the stat's own value.
export interface StatDetailFormula {
  kind: 'formula';
  expression: string;
  terms: StatDetailTerm[];
}

// Statistical stats (trend, anomaly, seasonal_projection, cash_forecast):
// no closed-form equation, name the method instead.
export interface StatDetailInputs {
  kind: 'inputs';
  methodName: string;
  inputs: StatDetailTerm[];
}

export type StatDetailView = StatDetailFormula | StatDetailInputs;

export interface StatDetailResponse {
  statType: string;
  value: number;
  detail: StatDetailView;
}
