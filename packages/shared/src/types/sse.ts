import type { TransparencyMetadata } from './transparency.js';

export interface SseTextEvent {
  text: string;
}

export interface SseDoneEvent {
  usage: { inputTokens: number; outputTokens: number } | null;
  reason?: string;
  metadata?: TransparencyMetadata;
}

export interface SseErrorEvent {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SsePartialEvent {
  text: string;
  metadata?: TransparencyMetadata;
}

export interface SseUpgradeRequiredEvent {
  wordCount: number;
}
