import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { UploadDropzone } from './UploadDropzone';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Mock XMLHttpRequest, the component uses it instead of fetch for progress tracking
class MockXHR {
  status = 200;
  responseText = '';
  withCredentials = false;
  readyState = 0;

  upload = { addEventListener: vi.fn() };
  addEventListener = vi.fn();
  open = vi.fn();
  send = vi.fn();
}

let xhrInstance: MockXHR;

const previewResponse = {
  data: {
    headers: ['date', 'amount', 'category'],
    sampleRows: [{ date: '2024-01-01', amount: '100', category: 'Food' }],
    rowCount: 42,
    validRowCount: 40,
    skippedRowCount: 2,
    fileName: 'test.csv',
    warnings: [],
    columnTypes: {},
    previewToken: 'signed-preview-token',
  },
};

beforeEach(() => {
  xhrInstance = new MockXHR();
  vi.stubGlobal('XMLHttpRequest', vi.fn(() => xhrInstance));
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * userEvent.upload has a jsdom 28 incompatibility (FileList.item removed),
 * so we use fireEvent.change with a manually assigned files property.
 */
function simulateUpload(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

/** Wire XHR mock to resolve with a given status and body */
function mockXhrResponse(status: number, body: unknown) {
  xhrInstance.addEventListener = vi.fn((event: string, handler: () => void) => {
    if (event === 'load') {
      setTimeout(() => {
        xhrInstance.status = status;
        xhrInstance.responseText = JSON.stringify(body);
        handler();
      }, 0);
    }
  });
}

/** Upload a valid CSV file and wait for the XHR to complete */
async function uploadAndWaitForPreview() {
  mockXhrResponse(200, previewResponse);

  render(<UploadDropzone />);

  const validCsv = new File(
    ['date,amount,category\n2024-01-01,100,Food'],
    'test.csv',
    { type: 'text/csv' },
  );
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  simulateUpload(input, validCsv);

  await act(() => vi.advanceTimersByTimeAsync(10));

  await waitFor(() => {
    expect(screen.getByText(/40 rows detected/i)).toBeInTheDocument();
  });
}

describe('UploadDropzone', () => {
  it('renders default state with dropzone prompt', () => {
    render(<UploadDropzone />);

    expect(screen.getByRole('button', { name: /upload csv file/i })).toBeInTheDocument();
    // jsdom exposes ontouchstart → isTouchDevice=true → mobile copy
    expect(screen.getByText(/tap to select your csv file/i)).toBeInTheDocument();
    expect(screen.getByText(/accepted: .csv up to 10mb/i)).toBeInTheDocument();
  });

  it('renders template download link with correct href in default state', () => {
    render(<UploadDropzone />);

    const link = screen.getByRole('link', { name: /download sample template/i });
    expect(link).toHaveAttribute('href', '/templates/sample-data.csv');
    expect(link).toHaveAttribute('download', 'sample-data.csv');
  });

  it('renders template download link in error state', async () => {
    render(<UploadDropzone />);

    const bigFile = new File(['x'.repeat(11 * 1024 * 1024)], 'huge.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    simulateUpload(input, bigFile);

    await waitFor(() => {
      expect(screen.getByText(/file size exceeds 10mb/i)).toBeInTheDocument();
    });

    const links = screen.getAllByRole('link', { name: /download sample template/i });
    const errorLink = links.find((l) => l.closest('[role="alert"]'));
    expect(errorLink).toHaveAttribute('href', '/templates/sample-data.csv');
    expect(errorLink).toHaveAttribute('download', 'sample-data.csv');
  });

  it('has accessible file input hidden from tab order', () => {
    render(<UploadDropzone />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toHaveAttribute('accept', '.csv');
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveAttribute('tabindex', '-1');
  });

  it('shows error for oversized file (client-side validation)', async () => {
    render(<UploadDropzone />);

    const bigFile = new File(['x'.repeat(11 * 1024 * 1024)], 'huge.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    simulateUpload(input, bigFile);

    await waitFor(() => {
      expect(screen.getByText(/file size exceeds 10mb/i)).toBeInTheDocument();
    });
  });

  it('shows error for non-CSV file type', async () => {
    render(<UploadDropzone />);

    const jsonFile = new File(['{}'], 'data.json', { type: 'application/json' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    simulateUpload(input, jsonFile);

    await waitFor(() => {
      expect(screen.getByText(/we expected a .csv file/i)).toBeInTheDocument();
    });
  });

  it('shows error for empty file', async () => {
    render(<UploadDropzone />);

    const emptyFile = new File([], 'empty.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    simulateUpload(input, emptyFile);

    await waitFor(() => {
      expect(screen.getByText(/this file appears to be empty/i)).toBeInTheDocument();
    });
  });

  it('transitions to processing state on valid file', async () => {
    render(<UploadDropzone />);

    const validCsv = new File(
      ['date,amount,category\n2024-01-01,100,Food'],
      'test.csv',
      { type: 'text/csv' },
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    simulateUpload(input, validCsv);

    await waitFor(() => {
      expect(screen.getByText(/validating your data/i)).toBeInTheDocument();
    });

    expect(xhrInstance.open).toHaveBeenCalledWith('POST', '/api/datasets');
    expect(xhrInstance.withCredentials).toBe(true);
    expect(xhrInstance.send).toHaveBeenCalled();
  });

  it('shows server error when XHR returns 400', async () => {
    mockXhrResponse(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'We expected a "date" column but could not find one.',
        details: {
          errors: [{ column: 'date', message: 'We expected a "date" column.' }],
        },
      },
    });

    render(<UploadDropzone />);

    const validCsv = new File(
      ['date,amount,category\n2024-01-01,100,Food'],
      'test.csv',
      { type: 'text/csv' },
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    simulateUpload(input, validCsv);

    await act(() => vi.advanceTimersByTimeAsync(10));

    await waitFor(() => {
      expect(screen.getByText(/we expected a "date" column but could not find one/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/validation failed/i)).toBeInTheDocument();
  });

  it('shows preview with CsvPreview on successful upload', async () => {
    await uploadAndWaitForPreview();

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload 40 rows/i })).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('opens file picker on Enter key', () => {
    render(<UploadDropzone />);

    const dropzone = screen.getByRole('button', { name: /upload csv file/i });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.keyDown(dropzone, { key: 'Enter' });

    expect(clickSpy).toHaveBeenCalled();
  });

  it('opens file picker on Space key', () => {
    render(<UploadDropzone />);

    const dropzone = screen.getByRole('button', { name: /upload csv file/i });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.keyDown(dropzone, { key: ' ' });

    expect(clickSpy).toHaveBeenCalled();
  });

  it('retains file name reference after error', async () => {
    render(<UploadDropzone />);

    const bigFile = new File(
      ['x'.repeat(11 * 1024 * 1024)],
      'quarterly-report.csv',
      { type: 'text/csv' },
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    simulateUpload(input, bigFile);

    await waitFor(() => {
      expect(screen.getByText(/last attempt: quarterly-report.csv/i)).toBeInTheDocument();
    });
  });

  it('shows warnings in preview state', async () => {
    mockXhrResponse(200, {
      data: {
        ...previewResponse.data,
        rowCount: 10,
        validRowCount: 8,
        skippedRowCount: 2,
        warnings: ['2 rows had invalid dates and were skipped.'],
      },
    });

    render(<UploadDropzone />);

    const validCsv = new File(
      ['date,amount,category\n2024-01-01,100,Food'],
      'test.csv',
      { type: 'text/csv' },
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    simulateUpload(input, validCsv);

    await act(() => vi.advanceTimersByTimeAsync(10));

    await waitFor(() => {
      expect(screen.getByText(/2 rows had invalid dates/i)).toBeInTheDocument();
    });
  });

  describe('confirm flow', () => {
    it('transitions to success state after confirm', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { datasetId: 1, rowCount: 40 } }),
      }));

      await uploadAndWaitForPreview();

      fireEvent.click(screen.getByRole('button', { name: /upload 40 rows/i }));

      await waitFor(() => {
        expect(screen.getByText(/40 transactions uploaded/i)).toBeInTheDocument();
      });

      expect(screen.getByText(/redirecting to dashboard/i)).toBeInTheDocument();
    });

    it('redirects to /dashboard after countdown', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { datasetId: 1, rowCount: 40 } }),
      }));

      await uploadAndWaitForPreview();

      fireEvent.click(screen.getByRole('button', { name: /upload 40 rows/i }));

      await waitFor(() => {
        expect(screen.getByText(/40 transactions uploaded/i)).toBeInTheDocument();
      });

      // shouldAdvanceTime auto-ticks, so just wait for the redirect to fire
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/dashboard');
      }, { timeout: 5000 });
    });

    it('shows error state when confirm fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({
          error: { message: 'Database connection failed.' },
        }),
      }));

      await uploadAndWaitForPreview();

      fireEvent.click(screen.getByRole('button', { name: /upload 40 rows/i }));

      await waitFor(() => {
        expect(screen.getByText(/database connection failed/i)).toBeInTheDocument();
      });
    });

    it('shows error state on network failure during confirm', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      await uploadAndWaitForPreview();

      fireEvent.click(screen.getByRole('button', { name: /upload 40 rows/i }));

      await waitFor(() => {
        expect(screen.getByText(/network error/i)).toBeInTheDocument();
      });
    });

    it('sends file and previewToken as FormData to /api/datasets/confirm', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { datasetId: 1, rowCount: 40 } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await uploadAndWaitForPreview();

      fireEvent.click(screen.getByRole('button', { name: /upload 40 rows/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/datasets/confirm',
          expect.objectContaining({ method: 'POST', credentials: 'include' }),
        );
      });

      const callArgs = mockFetch.mock.calls[0]!;
      const formData = callArgs[1].body as FormData;
      expect(formData).toBeInstanceOf(FormData);
      expect(formData.get('previewToken')).toBe('signed-preview-token');
    });
  });

  describe('cancel flow', () => {
    it('returns to default state when cancel clicked', async () => {
      await uploadAndWaitForPreview();

      fireEvent.click(screen.getByText('Cancel'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /upload csv file/i })).toBeInTheDocument();
      });
    });
  });
});
