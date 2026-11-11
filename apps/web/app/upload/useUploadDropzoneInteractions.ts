'use client';

import {
  useCallback,
  useRef,
  type ChangeEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type SetStateAction,
} from 'react';

export type UploadDropzoneState =
  | 'default'
  | 'dragHover'
  | 'processing'
  | 'preview'
  | 'success'
  | 'error';

export function useUploadDropzoneInteractions(
  onFileSelect: (file: File | undefined) => void,
  setState: Dispatch<SetStateAction<UploadDropzoneState>>,
) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCountRef = useRef(0);

  const beginDrag = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCountRef.current++;
      setState('dragHover');
    },
    [setState],
  );

  const keepDragActive = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const endDrag = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCountRef.current--;
      if (dragCountRef.current <= 0) {
        dragCountRef.current = 0;
        setState((state) => (state === 'dragHover' ? 'default' : state));
      }
    },
    [setState],
  );

  const acceptDroppedFiles = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCountRef.current = 0;
      onFileSelect(event.dataTransfer.files[0]);
    },
    [onFileSelect],
  );

  const acceptPickedFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onFileSelect(event.target.files?.[0]);
      event.target.value = '';
    },
    [onFileSelect],
  );

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);
  const openPickerOnEnter = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openFilePicker();
      }
    },
    [openFilePicker],
  );

  return {
    fileInputRef,
    beginDrag,
    keepDragActive,
    endDrag,
    acceptDroppedFiles,
    acceptPickedFiles,
    openPickerOnEnter,
    openFilePicker,
  };
}
