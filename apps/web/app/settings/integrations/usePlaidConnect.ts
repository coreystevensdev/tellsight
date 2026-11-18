'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import type { PlaidLinkOnSuccess } from 'react-plaid-link';

import { apiClient } from '@/lib/api-client';

interface Options {
  /** Refreshes the integrations list once a connection lands. */
  onConnected: () => Promise<void> | void;
  onError: (message: string) => void;
}

/**
 * Runs the Plaid Link flow, which does not look like the other three connectors.
 *
 * They navigate away to the provider and come back to a callback. Link opens in
 * an iframe on this page and hands back a short-lived public token, which the
 * browser posts to the API to be exchanged for the real access token. The
 * exchange has to happen server-side: a public token is useless to an attacker
 * but the access token it becomes is not.
 *
 * The two-step shape is forced by the SDK. `usePlaidLink` wants the token at
 * hook-call time and hooks cannot be called conditionally, so the token goes in
 * state, the hook reports `ready` once it has one, and an effect opens Link at
 * that point. Fetching on click and opening immediately is not available.
 */
export function usePlaidConnect({ onConnected, onError }: Options) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Returns void rather than a promise because that is the SDK's signature, so
  // the async work is started and not awaited by Link.
  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken, metadata) => {
      // The SDK types this nullable. Posting null would fail validation at the
      // API with a message about a missing field, which tells the owner nothing.
      if (!publicToken) {
        setLinkToken(null);
        setConnecting(false);
        onError('Your bank did not return a usable token. Please try again.');
        return;
      }

      void (async () => {
        try {
          await apiClient('/integrations/plaid/exchange', {
            method: 'POST',
            body: JSON.stringify({
              publicToken,
              // Only ever a display name for the dataset. Link is the only place
              // it is known without two more Plaid calls.
              institutionName: metadata.institution?.name ?? '',
            }),
          });
          await onConnected();
        } catch (err) {
          onError(err instanceof Error ? err.message : 'Could not finish connecting your bank');
        } finally {
          // Single-use: Plaid rejects a link_token that has already completed,
          // so holding it would make the next attempt fail rather than re-open.
          setLinkToken(null);
          setConnecting(false);
        }
      })();
    },
    [onConnected, onError],
  );

  const onExit = useCallback((err: unknown) => {
    setLinkToken(null);
    setConnecting(false);
    // A deliberate close is the common case and is not an error, so nothing is
    // surfaced for it. Link reports a real failure with an error object.
    if (err) onError('Your bank could not be connected. Please try again.');
  }, [onError]);

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess, onExit });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const res = await apiClient<{ linkToken: string }>('/integrations/plaid/link-token', {
        method: 'POST',
      });
      setLinkToken(res.data.linkToken);
    } catch (err) {
      setConnecting(false);
      onError(err instanceof Error ? err.message : 'Could not start connecting your bank');
    }
  }, [onError]);

  return { connect, connecting };
}
