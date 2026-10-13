/**
 * Incremental RFC 4180 CSV parser. Feed it text in chunks of any size (as they
 * arrive from a stream); it calls `onRow` once per complete record. Handles
 * quoted fields containing commas, quotes ("") and line breaks, and both LF
 * and CRLF line endings.
 */
export interface CsvParser {
  push(chunk: string): void;
  /** Flush the final record if the input did not end with a newline. */
  end(): void;
}

export function createCsvParser(onRow: (fields: string[]) => void): CsvParser {
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  // A quote seen inside a quoted field: either an escaped quote or the field's end.
  let quotePending = false;
  let sawAny = false;
  // A CR at a chunk boundary: skip a following LF.
  let lastWasCr = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    onRow(row);
    row = [];
    sawAny = false;
  };

  return {
    push(chunk: string) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (lastWasCr) {
          lastWasCr = false;
          if (c === '\n') {
            start = i + 1;
            continue;
          }
        }
        if (inQuotes) {
          if (quotePending) {
            quotePending = false;
            if (c === '"') {
              field += '"';
              start = i + 1;
              continue;
            }
            inQuotes = false;
            // fall through: c is handled as an unquoted character
          } else if (c === '"') {
            field += chunk.slice(start, i);
            quotePending = true;
            start = i + 1;
            continue;
          } else {
            continue;
          }
        }
        if (c === ',') {
          field += chunk.slice(start, i);
          endField();
          sawAny = true;
          start = i + 1;
        } else if (c === '\n' || c === '\r') {
          field += chunk.slice(start, i);
          if (sawAny || field.length > 0 || row.length > 0) endRow();
          lastWasCr = c === '\r';
          start = i + 1;
        } else if (c === '"' && field.length === 0 && start === i) {
          inQuotes = true;
          sawAny = true;
          start = i + 1;
        } else {
          sawAny = true;
        }
      }
      if (start < chunk.length) {
        field += chunk.slice(start);
        if (!inQuotes) sawAny = true;
      }
    },
    end() {
      if (quotePending) {
        quotePending = false;
        inQuotes = false;
      }
      if (sawAny || field.length > 0 || row.length > 0) endRow();
    },
  };
}
