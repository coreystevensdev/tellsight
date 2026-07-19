import type { DataRow } from './datasets.js';

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

// Citation surface for same-process callers that resolve a stat by id
// outside an HTTP request. No row-shaped field on this type by construction,
// so a caller can't return DataRow/SourceRow data through it by mistake.
export interface CitationResponse extends StatDetailResponse {
  statId: string;
  datasetId: number;
}

// Row-level evidence behind a stat instance (Story 12.4). Excludes
// orgId/datasetId/sourceType/metadata/createdAt, the audit drawer only
// needs enough to show the owner which transactions produced the number.
export type SourceRow = Pick<DataRow, 'id' | 'date' | 'category' | 'parentCategory' | 'amount' | 'label'>;
