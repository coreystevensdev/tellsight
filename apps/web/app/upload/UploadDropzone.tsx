'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, AlertCircle, CheckCircle2 } from 'lucide-react';
import { MAX_FILE_SIZE, ACCEPTED_FILE_TYPES } from 'shared/constants';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { CsvPreviewData, ColumnValidationError } from 'shared/types';
import { CsvPreview } from './CsvPreview';

type DropzoneState = 'default' | 'dragHover' | 'processing' | 'preview' | 'success' | 'error';

interface UploadError {
  message: string;
  errors?: ColumnValidationError[];
  fileName?: string;
}

const noop = () => () => {};
const getTouch = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const getServerTouch = () => false;

function useIsTouchDevice() {
  return useSyncExternalStore(noop, getTouch, getServerTouch);
}

const REDIRECT_DELAY_S = 3;

export function UploadDropzone() {
  const router = useRouter();
  const isTouchDevice = useIsTouchDevice();
  const [state, setState] = useState<DropzoneState>('default');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<UploadError | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<CsvPreviewData | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmedRowCount, setConfirmedRowCount] = useState(0);
  const [countdown, setCountdown] = useState(REDIRECT_DELAY_S);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const dragCountRef = useRef(0);

  // Redirect countdown after successful confirm
  useEffect(() => {
    if (state !== 'success') return;

    if (countdown <= 0) {
      router.push('/dashboard');
      return;
    }

    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [state, countdown, router]);

  const validateClientSide = useCallback((file: File): string | null => {
    if (file.size > MAX_FILE_SIZE) {
      return 'File size exceeds 10MB limit. Try splitting your data into smaller files.';
    }

    const hasValidExt = file.name.toLowerCase().endsWith('.csv');
    const hasValidMime = (ACCEPTED_FILE_TYPES as readonly string[]).includes(file.type);
    if (!hasValidExt && !hasValidMime) {
      return `We expected a .csv file, but received a ${file.type || 'unknown'} file type.`;
    }

    if (file.size === 0) {
      return 'This file appears to be empty. Download our sample template to see the expected format.';
    }

    return null;
  }, []);

  const uploadFile = useCallback(async (file: File) => {
    setState('processing');
    setUploadProgress(0);
    setLastFile(file);

    const clientError = validateClientSide(file);
    if (clientError) {
      setError({ message: clientError, fileName: file.name });
      setState('error');
      setTimeout(() => alertRef.current?.focus(), 100);
      return;
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await new Promise<{ ok: boolean; status: number; data: unknown }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        });

        xhr.addEventListener('load', () => {
          try {
            const data = JSON.parse(xhr.responseText);
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
          } catch {
            reject(new Error('Failed to parse server response'));
          }
        });

        xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
        xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

        xhr.open('POST', '/api/datasets');
        xhr.withCredentials = true;
        xhr.send(formData);
      });

      if (!response.ok) {
        const errData = (response.data as { error?: { message?: string; details?: { errors?: ColumnValidationError[]; fileName?: string } } }).error;
        setError({
          message: errData?.message || 'Upload failed',
          errors: errData?.details?.errors,
          fileName: errData?.details?.fileName || file.name,
        });
        setState('error');
        setTimeout(() => alertRef.current?.focus(), 100);
        return;
      }

      const preview = (response.data as { data: CsvPreviewData }).data;
      setPreviewData(preview);
      setState('preview');
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Something went wrong during upload',
        fileName: file.name,
      });
      setState('error');
      setTimeout(() => alertRef.current?.focus(), 100);
    }
  }, [validateClientSide]);

  const handleConfirm = useCallback(async () => {
    if (!lastFile || !previewData) return;

    setIsConfirming(true);

    try {
      const formData = new FormData();
      formData.append('file', lastFile);
      formData.append('previewToken', previewData.previewToken);

      const response = await fetch('/api/datasets/confirm', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      const result = await response.json();

      if (!response.ok) {
        const errMsg = result?.error?.message || 'Something went wrong while saving your data.';
        setError({ message: errMsg, fileName: lastFile.name });
        setIsConfirming(false);
        setState('error');
        setTimeout(() => alertRef.current?.focus(), 100);
        return;
      }

      const { rowCount } = result.data as { datasetId: number; rowCount: number };
      setConfirmedRowCount(rowCount);
      setIsConfirming(false);
      setLastFile(null);
      setPreviewData(null);
      setCountdown(REDIRECT_DELAY_S);
      setState('success');
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Network error while saving your data.',
        fileName: lastFile.name,
      });
      setIsConfirming(false);
      setState('error');
      setTimeout(() => alertRef.current?.focus(), 100);
    }
  }, [lastFile, previewData]);

  const handleCancel = useCallback(() => {
    setPreviewData(null);
    setIsConfirming(false);
    setState('default');
    // lastFile preserved so user sees "Last attempt: file.csv" if they re-enter error state
  }, []);

  const handleFileSelect = useCallback((file: File | undefined) => {
    if (file) uploadFile(file);
  }, [uploadFile]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current++;
    setState('dragHover');
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setState((s) => (s === 'dragHover' ? 'default' : s));
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    const file = e.dataTransfer.files[0];
    handleFileSelect(file);
  }, [handleFileSelect]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelect(e.target.files?.[0]);
    e.target.value = '';
  }, [handleFileSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Preview and success states render outside the dropzone
  if (state === 'preview' && previewData) {
    return (
      <div className="space-y-4">
        <CsvPreview
          previewData={previewData}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          isConfirming={isConfirming}
        />
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="flex min-h-[240px] flex-col items-center justify-center rounded-lg border-2 border-green-300 bg-green-50 p-8 text-center">
        <CheckCircle2 className="mb-3 h-12 w-12 text-green-600" />
        <p className="text-lg font-medium text-green-800">
          {confirmedRowCount.toLocaleString()} transactions uploaded!
        </p>
        <p className="mt-1 text-sm text-green-600">
          Redirecting to dashboard in {countdown}...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        ref={dropzoneRef}
        role="button"
        tabIndex={0}
        aria-label="Upload CSV file"
        onClick={openFilePicker}
        onKeyDown={handleKeyDown}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'relative flex min-h-[240px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          state === 'default' && 'border-border hover:border-muted-foreground/50 hover:bg-muted/50',
          state === 'dragHover' && 'border-primary bg-accent',
          state === 'processing' && 'border-primary/50 bg-muted/30',
          state === 'error' && 'border-destructive bg-destructive/5',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleInputChange}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
        />

        {state === 'default' && (
          <DefaultContent isMobile={isTouchDevice} />
        )}

        {state === 'dragHover' && (
          <div className="text-center">
            <Upload className="mx-auto mb-3 h-12 w-12 text-primary" />
            <p className="text-lg font-medium text-primary">Drop to upload</p>
          </div>
        )}

        {state === 'processing' && (
          <div className="w-full max-w-xs text-center">
            <Upload className="mx-auto mb-3 h-10 w-10 animate-pulse text-muted-foreground" />
            <p className="mb-4 text-sm font-medium">Validating your data...</p>
            <Progress
              value={uploadProgress}
              indeterminate={uploadProgress >= 100}
              className="mx-auto"
            />
            {uploadProgress < 100 && (
              <p className="mt-2 text-xs text-muted-foreground">{uploadProgress}% uploaded</p>
            )}
          </div>
        )}

        {state === 'error' && (
          <div className="text-center">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-destructive" />
            <p className="text-sm font-medium text-destructive">Validation failed</p>
            {lastFile && (
              <p className="mt-1 text-xs text-muted-foreground">
                Last attempt: {lastFile.name}
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Drop a corrected file or click to select
            </p>
          </div>
        )}
      </div>

      {state === 'error' && error && (
        <div ref={alertRef} tabIndex={-1} aria-live="assertive">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{error.message}</AlertTitle>
            {error.errors && error.errors.length > 0 && (
              <AlertDescription>
                <ul className="mt-2 space-y-1">
                  {error.errors.map((err, i) => (
                    <li key={i} className="text-sm">
                      {err.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            )}
            <AlertDescription className="mt-3">
              <a
                href="/templates/sample-data.csv"
                download="sample-data.csv"
                className="font-medium underline underline-offset-4"
                onClick={(e) => e.stopPropagation()}
              >
                Download sample template
              </a>
            </AlertDescription>
          </Alert>
        </div>
      )}
    </div>
  );
}

function DefaultContent({ isMobile }: { isMobile: boolean }) {
  return (
    <div className="text-center">
      <Upload className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
      <p className="text-base font-medium">
        {isMobile ? 'Tap to select your CSV file' : 'Drag your CSV here or click to browse'}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">Accepted: .csv up to 10MB</p>
      <a
        href="/templates/sample-data.csv"
        download="sample-data.csv"
        className="mt-2 inline-block text-sm text-primary underline underline-offset-4"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        Download sample template
      </a>
    </div>
  );
}
