const ExcelJS = require('exceljs');
const { Readable } = require('stream');

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((rt) => rt.text).join('');
    if (v.result !== undefined) return cellToString(v.result);
    if (v.text !== undefined) return cellToString(v.text);
    if (v.hyperlink !== undefined) return cellToString(v.hyperlink);
    return String(v);
  }
  return String(v);
}

async function parseWorkbookBuffer(buffer, originalName) {
  const isCsv = /\.csv$/i.test(originalName || '');
  const workbook = new ExcelJS.Workbook();

  if (isCsv) {
    await workbook.csv.read(Readable.from([buffer.toString('utf8')]));
  } else {
    await workbook.xlsx.load(buffer);
  }

  const ws = workbook.worksheets[0];
  if (!ws) return { sheetName: null, headers: [], rows: [] };

  const raw = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    raw.push(row.values.slice(1).map(cellToString));
  });

  if (!raw.length) return { sheetName: ws.name, headers: [], rows: [] };

  let headerRow = raw[0].map((h, i) => {
    const s = h === undefined || h === null ? '' : String(h).trim();
    return s === '' ? `Column ${i + 1}` : s;
  });

  const seen = {};
  headerRow = headerRow.map((h) => {
    if (seen[h] === undefined) {
      seen[h] = 0;
      return h;
    }
    seen[h] += 1;
    return `${h} (${seen[h]})`;
  });

  const rows = raw
    .slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const obj = {};
      headerRow.forEach((h, i) => {
        obj[h] = r[i] !== undefined ? r[i] : '';
      });
      return obj;
    });

  return { sheetName: ws.name, headers: headerRow, rows };
}

async function buildWorkbookBuffer(rows, cellStyles = null) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');

  const headers = [];
  const seen = new Set();
  rows.forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (!seen.has(k)) {
        seen.add(k);
        headers.push(k);
      }
    });
  });

  if (headers.length) ws.addRow(headers);
  rows.forEach((r) => {
    ws.addRow(headers.map((h) => (r[h] !== undefined ? r[h] : '')));
  });

  if (cellStyles) {
    cellStyles.forEach(({ rowIndex, colIndex, style, comment }) => {
      const cell = ws.getCell(rowIndex, colIndex);
      if (style.fill) {
        cell.fill = style.fill;
      }
      if (style.font) {
        cell.font = style.font;
      }
      if (comment) {
        cell.note = comment;
      }
    });
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { parseWorkbookBuffer, buildWorkbookBuffer };
