/**
 * Minimal ambient types for `xlsx-populate` (ships no own declarations).
 * Covers only the surface the PM template exporter uses. xlsx-populate's API is
 * chainable and dynamically typed; these signatures keep it loosely typed
 * without an implicit-any module error.
 */
declare module "xlsx-populate" {
  type CellValue = string | number | boolean | null | undefined;

  interface Cell {
    value(): CellValue;
    value(v: CellValue): Cell;
    formula(): string | undefined;
    formula(f: string): Cell;
    clear(): Cell;
  }

  interface RangeEndCell {
    columnNumber(): number;
    rowNumber(): number;
  }
  interface Range {
    address(): string;
    endCell(): RangeEndCell;
  }

  interface Sheet {
    name(): string;
    cell(address: string): Cell;
    cell(row: number, column: number): Cell;
    usedRange(): Range | null;
  }

  interface Workbook {
    sheet(nameOrIndex: string | number): Sheet;
    sheets(): Sheet[];
    outputAsync(): Promise<Buffer>;
    toFileAsync(path: string): Promise<void>;
  }

  interface XlsxPopulateStatic {
    fromFileAsync(path: string): Promise<Workbook>;
    fromDataAsync(data: Buffer | ArrayBuffer | Uint8Array): Promise<Workbook>;
    fromBlankAsync(): Promise<Workbook>;
  }

  const XlsxPopulate: XlsxPopulateStatic;
  export default XlsxPopulate;
}
