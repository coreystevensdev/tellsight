'use client';

import { useState, type FormEvent } from 'react';

import { apiClient, ApiClientError } from '@/lib/api-client';
import {
  emptyAlertRuleForm,
  formToPayload,
  ruleToForm,
  type AlertRule,
  type AlertRuleFormState,
} from './alertRuleModel';

export function useAlertRules(initial: AlertRule[]) {
  const [rules, setRules] = useState<AlertRule[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<AlertRuleFormState>(emptyAlertRuleForm());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const parsedNumericValue = Number(form.numericValue);
  const numericInvalid =
    form.kind !== 'anomaly_fires' &&
    (!Number.isFinite(parsedNumericValue) || parsedNumericValue <= 0);

  function reportError(caughtError: unknown, fallback: string) {
    if (caughtError instanceof ApiClientError && caughtError.status === 403) {
      setError('Only organization owners can manage alert rules.');
      return;
    }
    setError(caughtError instanceof Error ? caughtError.message : fallback);
  }

  function openCreateForm() {
    setEditingId(null);
    setForm(emptyAlertRuleForm());
    setFormOpen(true);
    setError(null);
  }

  function openEditForm(rule: AlertRule) {
    setEditingId(rule.id);
    setForm(ruleToForm(rule));
    setFormOpen(true);
    setError(null);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
  }

  async function submitForm(event: FormEvent) {
    event.preventDefault();
    if (submitting || numericInvalid) return;

    setSubmitting(true);
    setError(null);
    const payload = formToPayload(form);

    try {
      if (editingId != null) {
        const { data } = await apiClient<AlertRule>(`/org/alert-rules/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setRules((current) =>
          current.map((rule) => (rule.id === editingId ? data : rule)),
        );
      } else {
        const { data } = await apiClient<AlertRule>('/org/alert-rules', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setRules((current) => [data, ...current]);
      }
      closeForm();
    } catch (submitError) {
      reportError(
        submitError,
        editingId != null ? 'Failed to update alert rule' : 'Failed to create alert rule',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleEnabled(rule: AlertRule) {
    setBusyId(rule.id);
    setError(null);
    try {
      const { data } = await apiClient<AlertRule>(`/org/alert-rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          kind: rule.kind,
          threshold: rule.threshold,
          enabled: !rule.enabled,
        }),
      });
      setRules((current) => current.map((item) => (item.id === rule.id ? data : item)));
    } catch (toggleError) {
      reportError(toggleError, 'Failed to update alert rule');
    } finally {
      setBusyId(null);
    }
  }

  async function unmuteRule(rule: AlertRule) {
    setBusyId(rule.id);
    setError(null);
    try {
      const { data } = await apiClient<AlertRule>(`/org/alert-rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({ kind: rule.kind, threshold: rule.threshold, muteUntil: null }),
      });
      setRules((current) => current.map((item) => (item.id === rule.id ? data : item)));
    } catch (unmuteError) {
      reportError(unmuteError, 'Failed to unmute alert rule');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteRule(id: number) {
    setBusyId(id);
    setError(null);
    try {
      await apiClient(`/org/alert-rules/${id}`, { method: 'DELETE' });
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (deleteError) {
      reportError(deleteError, 'Failed to delete alert rule');
    } finally {
      setBusyId(null);
    }
  }

  return {
    rules,
    error,
    dismissError: () => setError(null),
    formOpen,
    form,
    setForm,
    editingId,
    submitting,
    busyId,
    numericInvalid,
    openCreateForm,
    openEditForm,
    closeForm,
    submitForm,
    toggleEnabled,
    unmuteRule,
    deleteRule,
  };
}
