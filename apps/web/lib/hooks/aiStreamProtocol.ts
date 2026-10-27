import {
  citeClosingTagGlobal,
  citeClosingTagOpenFragment,
  citeTagGlobal,
  citeTagOpenFragment,
  statTagGlobal,
  statTagOpenFragment,
} from 'shared/constants';
import type { TransparencyMetadata } from 'shared/types';

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'done'
  | 'error'
  | 'timeout'
  | 'free_preview';

export interface StreamState {
  status: StreamStatus;
  text: string;
  rawText: string;
  metadata: TransparencyMetadata | null;
  error: string | null;
  code: string | null;
  retryable: boolean;
  retryCount: number;
}

export type StreamAction =
  | { type: 'START'; isRetry?: boolean }
  | { type: 'TEXT'; delta: string }
  | { type: 'DONE'; metadata?: TransparencyMetadata | null }
  | { type: 'ERROR'; message: string; code?: string; retryable?: boolean }
  | { type: 'PARTIAL'; text: string; metadata?: TransparencyMetadata | null }
  | { type: 'CACHE_HIT'; content: string; metadata?: TransparencyMetadata | null }
  | { type: 'UPGRADE_REQUIRED'; wordCount: number }
  | { type: 'RESET' };

export const initialStreamState: StreamState = {
  status: 'idle',
  text: '',
  rawText: '',
  metadata: null,
  error: null,
  code: null,
  retryable: false,
  retryCount: 0,
};

export function stripStatTags(raw: string): string {
  return raw.replace(statTagGlobal(), '').replace(statTagOpenFragment(), '');
}

export function stripCiteTags(raw: string): string {
  return raw
    .replace(citeTagGlobal(), '')
    .replace(citeClosingTagGlobal(), '')
    .replace(citeTagOpenFragment(), '')
    .replace(citeClosingTagOpenFragment(), '');
}

export function stripDisplayTags(raw: string): string {
  return stripCiteTags(stripStatTags(raw));
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'START':
      return {
        ...initialStreamState,
        status: 'connecting',
        retryCount: action.isRetry ? state.retryCount + 1 : 0,
      };
    case 'TEXT': {
      const rawText = state.rawText + action.delta;
      return { ...state, status: 'streaming', rawText, text: stripDisplayTags(rawText) };
    }
    case 'DONE':
      if (state.status === 'timeout' || state.status === 'free_preview') return state;
      return { ...state, status: 'done', metadata: action.metadata ?? null };
    case 'UPGRADE_REQUIRED':
      return { ...state, status: 'free_preview' };
    case 'ERROR':
      return {
        ...state,
        status: 'error',
        error: action.message,
        code: action.code ?? null,
        retryable: action.retryable ?? false,
      };
    case 'PARTIAL':
      return {
        ...state,
        status: 'timeout',
        rawText: action.text,
        text: stripDisplayTags(action.text),
        metadata: action.metadata ?? null,
      };
    case 'CACHE_HIT':
      return {
        ...initialStreamState,
        status: 'done',
        rawText: action.content,
        text: stripDisplayTags(action.content),
        metadata: action.metadata ?? null,
      };
    case 'RESET':
      return initialStreamState;
  }
}

export function parseSseLines(
  buffer: string,
  dispatch: (action: StreamAction) => void,
): string {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  let currentEvent = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      const raw = line.slice(6);
      try {
        const parsed = JSON.parse(raw);
        switch (currentEvent) {
          case 'text':
            dispatch({ type: 'TEXT', delta: parsed.text });
            break;
          case 'done':
            dispatch({ type: 'DONE', metadata: parsed.metadata ?? null });
            break;
          case 'error':
            dispatch({
              type: 'ERROR',
              message: parsed.message ?? 'Stream error',
              code: parsed.code,
              retryable: parsed.retryable ?? false,
            });
            break;
          case 'partial':
            dispatch({ type: 'PARTIAL', text: parsed.text, metadata: parsed.metadata ?? null });
            break;
          case 'upgrade_required':
            dispatch({ type: 'UPGRADE_REQUIRED', wordCount: parsed.wordCount });
            break;
        }
      } catch {
        // Ignore malformed events and continue consuming the stream.
      }
      currentEvent = '';
    }
  }

  return remainder;
}
