// `mapAnthropicError` marks a Claude failure permanent when it is a 400 or a
// 401: a malformed request, a bad key, an exhausted credit balance. None of
// those improve across 36 samples, so an eval that keeps going is only
// discovering the same fact repeatedly and at cost.
//
// On 2026-11-13 a credit-balance 400 produced 72 errored samples over roughly 40
// minutes and a scorecard whose whole agent section was null. The classification
// that would have stopped it after one already existed upstream; it was computed
// for a log level and discarded.
//
// Read off `details` rather than the message. The message is user-facing copy
// ("Service temporarily unavailable, please retry shortly.") and free to change,
// which is the reason the shed check next to this one matches on a code.
export function isPermanentUpstreamFailure(err: unknown): boolean {
  const details = (err as { details?: unknown } | null)?.details;
  return (details as { permanent?: boolean } | null)?.permanent === true;
}
