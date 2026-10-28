/** Narrow test-only contracts avoid making DevExtreme a library dependency. */
declare module 'virtual:renderpdf-devextreme' {
  export class DataGrid {
    constructor(element: HTMLElement, options: Record<string, unknown>);
    getDataSource(): { load(): PromiseLike<unknown> };
    selectRows(keys: readonly number[], preserve: boolean): PromiseLike<unknown>;
    dispose(): void;
  }
  export function exportDataGrid(options: {
    jsPDFDocument: object;
    component: DataGrid;
    selectedRowsOnly?: boolean;
    columnWidths?: readonly number[];
    repeatHeaders?: boolean;
    topLeft?: { x: number; y: number };
    margin?: { top: number; right: number; bottom: number; left: number };
    loadPanel?: { enabled: boolean };
    customizeCell?: (event: {
      pdfCell?: {
        font?: { size: number; style: 'normal' };
        wordWrapEnabled?: boolean;
      };
    }) => void;
  }): PromiseLike<void>;
  export const installedVersion: string;
}
