import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// No test file, and nothing else imports this under test. Changing the
// pagination loop to `while (false)` silently truncated every multi-page export
// to page one, which is the failure a user is least likely to report: the PDF
// downloads, opens, and just quietly stops.

const toPng = vi.fn();
const addImage = vi.fn();
const addPage = vi.fn();
const save = vi.fn();
const trackClientEvent = vi.fn();

vi.mock('html-to-image', () => ({ toPng: (...a: unknown[]) => toPng(...a) }));
vi.mock('jspdf', () => ({
  jsPDF: vi.fn(() => ({ addImage, addPage, save })),
}));
vi.mock('@/lib/analytics', () => ({
  trackClientEvent: (...a: unknown[]) => trackClientEvent(...a),
}));

import { useExportPdf } from './useExportPdf';

const PNG = 'data:image/png;base64,abc';

/** Decoding runs through a real Image, so its dimensions are stubbed. */
function stubImage(width: number, height: number) {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    width = width;
    height = height;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

function nodeRef() {
  return { current: document.createElement('div') } as React.RefObject<HTMLElement | null>;
}

async function exportWith(width: number, height: number) {
  stubImage(width, height);
  toPng.mockResolvedValue(PNG);
  const { result } = renderHook(() => useExportPdf(nodeRef()));
  await act(async () => {
    await result.current.exportPdf();
  });
  return result;
}

beforeEach(() => {
  toPng.mockReset();
  addImage.mockReset();
  addPage.mockReset();
  save.mockReset();
  trackClientEvent.mockReset();
});

describe('useExportPdf pagination', () => {
  // The image is scaled to 190mm wide and the printable page is 277mm tall, so
  // the page count follows from the source aspect ratio alone:
  //   scaledHeight = height * 190 / width, pages = ceil(scaledHeight / 277)
  //   1000x1000  ->  190mm  -> 1
  //   1000x1500  ->  285mm  -> 2
  //   1000x4000  ->  760mm  -> 3
  //   1000x10000 -> 1900mm  -> 7
  it.each([
    ['content shorter than one page', 1000, 1000, 1],
    ['content just over one page', 1000, 1500, 2],
    ['content spanning three pages', 1000, 4000, 3],
    ['a very long dashboard', 1000, 10_000, 7],
  ])('renders %s across %s pages', async (_label, w, h, expectedPages) => {
    await exportWith(w, h);

    expect(addImage).toHaveBeenCalledTimes(expectedPages);
    // One addPage per page after the first.
    expect(addPage).toHaveBeenCalledTimes(expectedPages - 1);
  });

  // Each continuation page shifts the same image up by one page height, so the
  // offsets have to decrease monotonically. A constant offset would reprint
  // page one repeatedly.
  it('shifts the image up on every continuation page', async () => {
    await exportWith(1000, 4000);

    const offsets = addImage.mock.calls.map((c) => c[3] as number);
    expect(offsets[0]).toBe(10);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]!).toBeLessThan(offsets[i - 1]!);
    }
  });

  it('keeps the image width at the A4 content width on every page', async () => {
    await exportWith(1000, 4000);

    for (const call of addImage.mock.calls) expect(call[4]).toBe(190);
  });
});

describe('useExportPdf outcomes', () => {
  it('saves the file and reports done', async () => {
    const result = await exportWith(1000, 1000);

    expect(save).toHaveBeenCalledWith('tellsight-report.pdf');
    await waitFor(() => expect(result.current.status).toBe('done'));
  });

  it('records the export only on success', async () => {
    await exportWith(1000, 1000);

    expect(trackClientEvent).toHaveBeenCalledWith('insight.exported', { format: 'pdf' });
  });

  // Nothing to capture, so there is no point starting.
  it('errors without calling the renderer when the node is missing', async () => {
    const { result } = renderHook(() =>
      useExportPdf({ current: null } as React.RefObject<HTMLElement | null>),
    );

    await act(async () => {
      await result.current.exportPdf();
    });

    expect(result.current.status).toBe('error');
    expect(toPng).not.toHaveBeenCalled();
  });

  it('errors and records nothing when rendering fails', async () => {
    stubImage(1000, 1000);
    toPng.mockRejectedValue(new Error('tainted canvas'));
    const { result } = renderHook(() => useExportPdf(nodeRef()));

    await act(async () => {
      await result.current.exportPdf();
    });

    expect(result.current.status).toBe('error');
    expect(save).not.toHaveBeenCalled();
    expect(trackClientEvent).not.toHaveBeenCalled();
  });
});
