import type {
  ColumnValidationError as SharedColumnValidationError,
  CsvPreviewData,
} from 'shared/types';

// Re-export shared types so API-internal code imports from one adapter barrel
export type ColumnValidationError = SharedColumnValidationError;
export type PreviewData = CsvPreviewData;

export interface ValidationResult {
  valid: boolean;
  errors: ColumnValidationError[];
}

export interface ParsedRow {
  [column: string]: string;
}

export interface ParseResult {
  headers: string[];
  rows: ParsedRow[];
  rowCount: number;
  warnings: string[];
}
