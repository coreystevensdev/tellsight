'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ColumnValidationError, CsvPreviewData } from 'shared/types';
import { confirmDatasetUpload, uploadDatasetPreview } from './datasetUploadClient';
import type { UploadError } from './UploadDropzoneFeedback';
import type { UploadDropzoneState } from './useUploadDropzoneInteractions';
import { validateUploadFile } from './uploadValidation';

const REDIRECT_DELAY_SECONDS = 3;

export function useDatasetUploadWorkflow() {
  const [state, setState] = useState<UploadDropzoneState>('default');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<CsvPreviewData | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmedRowCount, setConfirmedRowCount] = useState(0);
  const [countdown, setCountdown] = useState(REDIRECT_DELAY_SECONDS);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state !== 'success') return;

    if (countdown <= 0) {
      // Force a server fetch rather than risking the router cache returning the
      // dashboard's pre-upload empty state.
      window.location.replace('/dashboard');
      return;
    }

    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [state, countdown]);

  const focusError = useCallback(() => {
    setTimeout(() => alertRef.current?.focus(), 100);
  }, []);

  const uploadFile = useCallback(
    async (file: File) => {
      setState('processing');
      setUploadProgress(0);
      setLastFile(file);

      const clientError = validateUploadFile(file);
      if (clientError) {
        setError({ message: clientError, fileName: file.name });
        setState('error');
        focusError();
        return;
      }

      try {
        const response = await uploadDatasetPreview(file, setUploadProgress);

        if (!response.ok) {
          const responseError = (
            response.data as {
              error?: {
                message?: string;
                details?: { errors?: ColumnValidationError[]; fileName?: string };
              };
            }
          ).error;
          setError({
            message: responseError?.message || 'Upload failed',
            errors: responseError?.details?.errors,
            fileName: responseError?.details?.fileName || file.name,
          });
          setState('error');
          focusError();
          return;
        }

        const preview = (response.data as { data: CsvPreviewData }).data;
        setPreviewData(preview);
        setState('preview');
      } catch (uploadError) {
        setError({
          message:
            uploadError instanceof Error ? uploadError.message : 'The upload did not finish.',
          fileName: file.name,
        });
        setState('error');
        focusError();
      }
    },
    [focusError],
  );

  const selectFile = useCallback(
    (file: File | undefined) => {
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  const confirmUpload = useCallback(async () => {
    if (!lastFile || !previewData) return;

    setIsConfirming(true);
    try {
      const response = await confirmDatasetUpload(lastFile, previewData.previewToken);
      const result = await response.json();

      if (!response.ok) {
        setError({
          message: result?.error?.message || 'Your data could not be saved.',
          fileName: lastFile.name,
        });
        setIsConfirming(false);
        setState('error');
        focusError();
        return;
      }

      const { rowCount } = result.data as { datasetId: number; rowCount: number };
      setConfirmedRowCount(rowCount);
      setIsConfirming(false);
      setLastFile(null);
      setPreviewData(null);
      setCountdown(REDIRECT_DELAY_SECONDS);
      setState('success');
    } catch (confirmationError) {
      setError({
        message:
          confirmationError instanceof Error
            ? confirmationError.message
            : 'Network error while saving your data.',
        fileName: lastFile.name,
      });
      setIsConfirming(false);
      setState('error');
      focusError();
    }
  }, [focusError, lastFile, previewData]);

  const cancelPreview = useCallback(() => {
    setPreviewData(null);
    setIsConfirming(false);
    setState('default');
  }, []);

  return {
    state,
    setState,
    uploadProgress,
    error,
    lastFile,
    previewData,
    isConfirming,
    confirmedRowCount,
    countdown,
    alertRef,
    selectFile,
    confirmUpload,
    cancelPreview,
  };
}
