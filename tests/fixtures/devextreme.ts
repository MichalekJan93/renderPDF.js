import { createJsPDFAdapter } from '../../src/jspdf-adapter';
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

// Default fixture discovery must not resolve the optional caller-installed vendor package.
const vendorModule = '/__renderpdf_devextreme__.js';
const { DataGrid, exportDataGrid, installedVersion } = (await import(
  /* @vite-ignore */ vendorModule
)) as typeof import('virtual:renderpdf-devextreme');

/** Serializable evidence consumed by the independent PDF.js browser reader. */
export interface DevExtremeEvidence {
  bytes: number[];
  pageCount: number;
  selected: readonly number[];
  version: string;
}

/** Independent extraction and paint evidence for the generated document. */
export interface DevExtremePageEvidence {
  text: { value: string; x: number; y: number }[];
  width: number;
  height: number;
  images: number;
  png: string;
}

/** Every row and its two text fields are synthetic and safe to publish. */
const rows = Array.from({ length: 120 }, (_, index) => ({
  id: index + 1,
  marker: `ROW${String(index + 1).padStart(3, '0')}`,
  label: `Unicode row \u017d\u0165\u010d\u00fd\u016f\u0148 ${String(index + 1).padStart(3, '0')}`,
  note: `Long text ${'M'.repeat(90)} end`,
  amount: (index + 1) * 10,
}));
const selected = [5, 40, 119];
const element = document.querySelector<HTMLElement>('#grid');
if (!element) throw new Error('The synthetic grid host is missing.');
const grid = new DataGrid(element, {
  dataSource: rows,
  keyExpr: 'id',
  columns: [
    { dataField: 'marker', caption: 'Record', width: 100 },
    { dataField: 'label', caption: 'Unicode text', width: 350 },
    { dataField: 'note', caption: 'Truncated text', width: 180, alignment: 'right' },
    { dataField: 'amount', caption: 'Amount', width: 100 },
  ],
  paging: { enabled: true, pageSize: 15 },
  selection: { mode: 'multiple' },
  showBorders: true,
  height: 500,
});
const font = fetch('/fonts/NotoSans-Regular.ttf').then(async (response) => {
  if (!response.ok) throw new Error('The licensed synthetic-test font could not be loaded.');
  return response.arrayBuffer();
});

/** Exercise the unmodified vendor exporter and the prepared compatibility facade. */
async function exportGrid(selectedOnly = false, horizontal = false): Promise<DevExtremeEvidence> {
  await grid.getDataSource().load();
  await grid.selectRows(selected, false);
  const doc = await createJsPDFAdapter({
    unit: 'mm',
    format: 'A4',
    orientation: 'landscape',
    fonts: [{ family: 'Compatibility Sans', data: await font }],
    metadata: { title: 'Grid export verification' },
  });
  doc.setFont('Compatibility Sans');
  doc.setFontSize(12);
  doc.text('Synthetic records overview', 10, 10);
  await exportDataGrid({
    jsPDFDocument: doc,
    component: grid,
    selectedRowsOnly: selectedOnly,
    columnWidths: horizontal ? [22, 65, 400, 40] : [22, 65, 45, 40],
    repeatHeaders: true,
    topLeft: { x: 10, y: 18 },
    margin: { top: 10, right: 10, bottom: 15, left: 10 },
    loadPanel: { enabled: false },
    customizeCell: ({ pdfCell }) => {
      if (!pdfCell) return;
      pdfCell.font = { size: 8, style: 'normal' };
      pdfCell.wordWrapEnabled = false;
    },
  });
  const pageCount = doc.getNumberOfPages();
  doc.setFontSize(8);
  for (let index = 1; index <= pageCount; index += 1) {
    doc.setPage(index);
    const width = doc.internal.pageSize.getWidth();
    const height = doc.internal.pageSize.getHeight();
    doc.text('Printed by: Synthetic user', 10, height - 7);
    doc.text(`Page ${index} of ${pageCount}`, width - 10, height - 7, { align: 'right' });
  }
  const blob = await doc.toBlob();
  return {
    bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    pageCount,
    selected: [...selected],
    version: installedVersion,
  };
}

/** Decode and render through PDF.js, independently from the adapter and PDF writer. */
async function inspectPDF(input: number[]): Promise<DevExtremePageEvidence[]> {
  const task = getDocument({ data: Uint8Array.from(input), stopAtErrors: true });
  const pdf = await task.promise;
  try {
    const pages: DevExtremePageEvidence[] = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const current = await pdf.getPage(index);
      const viewport = current.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await current.render({ canvas, viewport }).promise;
      const text = await current.getTextContent();
      const operators = await current.getOperatorList();
      pages.push({
        width: viewport.width,
        height: viewport.height,
        text: text.items.flatMap((item) =>
          'str' in item
            ? [
                {
                  value: item.str,
                  x: item.transform[4]!,
                  y: item.transform[5]!,
                },
              ]
            : [],
        ),
        images: operators.fnArray.filter((operation) => operation === OPS.paintImageXObject).length,
        png: canvas.toDataURL('image/png'),
      });
      canvas.width = 0;
      canvas.height = 0;
      current.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

Object.assign(window, { devextremeFixture: { exportGrid, inspectPDF } });
