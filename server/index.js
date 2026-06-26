const path = require('path');
const express = require('express');
const multer = require('multer');

const { parseWorkbookBuffer, buildWorkbookBuffer } = require('./lib/excel');
const { merge } = require('./lib/reconcileEngine');

const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_FILES = 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
});

const app = express();

app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} -> ${res.statusCode}`);
  });
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/inspect', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  try {
    const { headers, rows, sheetName } = await parseWorkbookBuffer(req.file.buffer, req.file.originalname);
    if (!headers.length) {
      return res.status(422).json({ error: 'No columns found in that file.' });
    }
    res.json({ headers, rowCount: rows.length, sheetName });
  } catch (err) {
    res.status(422).json({ error: 'Could not read that file. Confirm it is a valid .xlsx or .csv file (legacy .xls is not supported — re-save as .xlsx).' });
  }
});

app.post('/api/reconcile', upload.array('files', MAX_FILES), async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files received.' });
  }

  let meta;
  try {
    meta = JSON.parse(req.body.meta || '[]');
  } catch (err) {
    return res.status(400).json({ error: 'Malformed request data.' });
  }

  if (!Array.isArray(meta) || meta.length !== req.files.length) {
    return res.status(400).json({ error: 'File metadata did not match the uploaded files.' });
  }

  try {
    const files = await Promise.all(
      req.files.map(async (file, i) => {
        const { headers, rows } = await parseWorkbookBuffer(file.buffer, file.originalname);
        return { id: meta[i].id, name: meta[i].name, headers, rows };
      })
    );

    const processedFiles = preprocessGPUPCAFiles(files);

    const rules = autoDetectRules(processedFiles);

    const result = customMerge(processedFiles, rules);

    const [mergedBuffer, mismatchBuffer] = await Promise.all([
      buildWorkbookBuffer(result.mergedRows),
      buildWorkbookBuffer(result.mismatchRows, result.mismatchCellStyles),
    ]);

    res.json({
      stats: result.stats,
      mergedFileBase64: mergedBuffer.toString('base64'),
      mismatchFileBase64: mismatchBuffer.toString('base64'),
    });
  } catch (err) {
    console.error('SheetFusion failed:', err.message);
    res.status(500).json({ error: 'Something went wrong while merging those files. Confirm every file is a valid .xlsx or .csv.' });
  }
});

function autoDetectRules(files) {
  const rules = [];
  const columnMap = {};

  const excludedColumns = ['start date', 'start time', 'end date', 'end time', 'arr. time', 'dep. time', 'gpu start date & time', 'gpu end date & time', 'pca start date & time', 'pca end date & time', 'description', 'desc'];

  files.forEach(f => {
    f.headers.forEach(h => {
      if (h === undefined || h === null) return;
      const normalized = h.trim().toLowerCase();
      if (excludedColumns.some(ex => normalized.includes(ex))) return;
      if (!columnMap[normalized]) {
        columnMap[normalized] = [];
      }
      columnMap[normalized].push(f.id);
    });
  });

  Object.keys(columnMap).forEach(normalizedName => {
    const fileIds = columnMap[normalizedName];
    if (fileIds.length >= 2) {
      for (let i = 0; i < fileIds.length - 1; i++) {
        const fileA = files.find(f => f.id === fileIds[i]);
        const fileB = files.find(f => f.id === fileIds[i + 1]);
        if (fileA && fileB) {
          const colA = fileA.headers.find(h => h && h.trim().toLowerCase() === normalizedName);
          const colB = fileB.headers.find(h => h && h.trim().toLowerCase() === normalizedName);
          if (colA && colB) {
            rules.push({ fileA: fileA.id, colA: colA, fileB: fileB.id, colB: colB });
          }
        }
      }
    }
  });

  const columnMappings = [
    { names: ['DATE', 'CDAT', 'Date', 'Cdat'], description: 'Date columns' },
    { names: ['Stand', 'Bay No', 'Bay No.', 'Bay', 'STAND', 'BAY NO', 'BAY NO.', 'BAY'], description: 'Location columns' },
    { names: ['DEVICE_ID', 'Device ID', 'Device_ID', 'device_id', 'DEVICE ID'], description: 'Device ID columns' },
    { names: ['Flight No.', 'Flight No', 'Operator Name', 'Flight Number', 'FLT NO', 'FLT NO.', 'Flight'], description: 'Flight number columns' },
    { names: ['Aircraft Reg.', 'Aircraft Reg', 'Aircraft Registration', 'Registration', 'Reg', 'Aircraft Reg No'], description: 'Aircraft registration columns' },
    { names: ['Airline', 'Carrier', 'Operator'], description: 'Airline columns' },
    { names: ['From', 'Origin', 'Departure Airport', 'Dep Airport'], description: 'Origin airport columns' },
    { names: ['To', 'Destination', 'Arrival Airport', 'Arr Airport'], description: 'Destination airport columns' },
  ];

  if (files.length === 2) {
    const fileA = files[0];
    const fileB = files[1];

    columnMappings.forEach(mapping => {
      const colsA = mapping.names.map(colName =>
        fileA.headers.find(h => h && h.trim().toLowerCase() === colName.toLowerCase())
      ).filter(Boolean);

      const colsB = mapping.names.map(colName =>
        fileB.headers.find(h => h && h.trim().toLowerCase() === colName.toLowerCase())
      ).filter(Boolean);

      colsA.forEach(colA => {
        colsB.forEach(colB => {
          if (colA.toLowerCase() === colB.toLowerCase()) return;
          if (excludedColumns.some(ex => colA.toLowerCase().includes(ex) || colB.toLowerCase().includes(ex))) return;

          const ruleExists = rules.some(r =>
            r.fileA === fileA.id && r.fileB === fileB.id &&
            r.colA === colA && r.colB === colB
          );
          if (!ruleExists) {
            rules.push({ fileA: fileA.id, colA: colA, fileB: fileB.id, colB: colB });
          }
        });
      });
    });
  }

  if (files.length === 2) {
    const fileA = files[0];
    const fileB = files[1];

    columnMappings.forEach(mapping => {
      const colsA = mapping.names.map(colName =>
        fileA.headers.find(h => h && h.trim().toLowerCase() === colName.toLowerCase())
      ).filter(Boolean);

      const colsB = mapping.names.map(colName =>
        fileB.headers.find(h => h && h.trim().toLowerCase() === colName.toLowerCase())
      ).filter(Boolean);

      colsB.forEach(colB => {
        colsA.forEach(colA => {
          if (colA.toLowerCase() === colB.toLowerCase()) return;
          if (excludedColumns.some(ex => colA.toLowerCase().includes(ex) || colB.toLowerCase().includes(ex))) return;

          const ruleExists = rules.some(r =>
            r.fileA === fileB.id && r.fileB === fileA.id &&
            r.colA === colB && r.colB === colA
          );
          if (!ruleExists) {
            rules.push({ fileA: fileB.id, colA: colB, fileB: fileA.id, colB: colA });
          }
        });
      });
    });
  }

  const descFile = files.find(f => f.headers.some(h => h && h.trim().toLowerCase() === 'description'));
  const deviceTypeFile = files.find(f =>
    f.headers.some(h => h && (h.includes('GPU') || h.includes('PCA')) && (h.includes('Start') || h.includes('End')))
  );

  if (descFile && deviceTypeFile && descFile.id !== deviceTypeFile.id) {
    const commonColumns = ['Date', 'Bay No', 'Bay No.', 'Bay', 'DEVICE_ID', 'Device ID', 'Device_ID'];
    commonColumns.forEach(colName => {
      const colA = descFile.headers.find(h => h && h.trim().toLowerCase() === colName.toLowerCase());
      const colB = deviceTypeFile.headers.find(h => h && h.trim().toLowerCase() === colName.toLowerCase());
      if (colA && colB) {
        rules.push({
          fileA: descFile.id,
          colA: colA,
          fileB: deviceTypeFile.id,
          colB: colB
        });
      }
    });

    const startDateColA = descFile.headers.find(h => h && h.toLowerCase().includes('start') && h.toLowerCase().includes('date'));
    const gpuStartCol = deviceTypeFile.headers.find(h => h && h.toLowerCase().includes('gpu') && h.toLowerCase().includes('start'));
    if (startDateColA && gpuStartCol) {
      rules.push({
        fileA: descFile.id,
        colA: startDateColA,
        fileB: deviceTypeFile.id,
        colB: gpuStartCol
      });
    }

    const endDateColA = descFile.headers.find(h => h && h.toLowerCase().includes('end') && h.toLowerCase().includes('date'));
    const gpuEndCol = deviceTypeFile.headers.find(h => h && h.toLowerCase().includes('gpu') && h.toLowerCase().includes('end'));
    if (endDateColA && gpuEndCol) {
      rules.push({
        fileA: descFile.id,
        colA: endDateColA,
        fileB: deviceTypeFile.id,
        colB: gpuEndCol
      });
    }
  }

  return rules;
}

function preprocessGPUPCAFiles(files) {
  const descFile = files.find(f => f.headers.some(h => h && h.trim().toLowerCase() === 'description'));
  const deviceTypeFile = files.find(f =>
    f.headers.some(h => h && (h.includes('GPU') || h.includes('PCA')) && (h.includes('Start') || h.includes('End')))
  );

  if (!deviceTypeFile) {
    return files;
  }

  const normalizedDeviceFile = {
    ...deviceTypeFile,
    headers: [...deviceTypeFile.headers],
    rows: []
  };

  let gpuCount = 0;
  let pcaCount = 0;

  deviceTypeFile.rows.forEach(row => {
    const gpuCol = deviceTypeFile.headers.find(h => h && h.toLowerCase() === 'gpu');
    const gpuStartCol = deviceTypeFile.headers.find(h => h && h.toLowerCase().includes('gpu') && h.toLowerCase().includes('start'));
    const gpuEndCol = deviceTypeFile.headers.find(h => h && h.toLowerCase().includes('gpu') && h.toLowerCase().includes('end'));
    const hasGPU = gpuCol && row[gpuCol] && String(row[gpuCol]).trim().toLowerCase() === 'usage';

    const pcaCol = deviceTypeFile.headers.find(h => h && h.toLowerCase() === 'pca');
    const pcaStartCol = deviceTypeFile.headers.find(h => h && h.toLowerCase().includes('pca') && h.toLowerCase().includes('start'));
    const pcaEndCol = deviceTypeFile.headers.find(h => h && h.toLowerCase().includes('pca') && h.toLowerCase().includes('end'));
    const hasPCA = pcaCol && row[pcaCol] && String(row[pcaCol]).trim().toLowerCase() === 'usage';

    if (hasGPU && gpuStartCol && gpuEndCol) {
      const gpuRow = { ...row };
      gpuRow['DESCRIPTION'] = 'GPU';
      gpuRow['Start Date'] = extractDate(row[gpuStartCol]);
      gpuRow['Start Time'] = extractTime(row[gpuStartCol]);
      gpuRow['End Date'] = extractDate(row[gpuEndCol]);
      gpuRow['End Time'] = extractTime(row[gpuEndCol]);
      normalizedDeviceFile.rows.push(gpuRow);
      gpuCount++;
    }

    if (hasPCA && pcaStartCol && pcaEndCol) {
      const pcaRow = { ...row };
      pcaRow['DESCRIPTION'] = 'PCA';
      pcaRow['Start Date'] = extractDate(row[pcaStartCol]);
      pcaRow['Start Time'] = extractTime(row[pcaStartCol]);
      pcaRow['End Date'] = extractDate(row[pcaEndCol]);
      pcaRow['End Time'] = extractTime(row[pcaEndCol]);
      normalizedDeviceFile.rows.push(pcaRow);
      pcaCount++;
    }
  });

  if (!normalizedDeviceFile.headers.includes('DESCRIPTION')) {
    normalizedDeviceFile.headers.push('DESCRIPTION');
  }
  ['Start Date', 'Start Time', 'End Date', 'End Time'].forEach(col => {
    if (!normalizedDeviceFile.headers.includes(col)) {
      normalizedDeviceFile.headers.push(col);
    }
  });

  if (descFile && descFile.id !== deviceTypeFile.id) {
    const normalizedDescFile = {
      ...descFile,
      headers: [...descFile.headers],
      rows: []
    };

    descFile.rows.forEach(row => {
      const descCol = descFile.headers.find(h => h && h.trim().toLowerCase() === 'description');
      if (descCol && row[descCol]) {
        const desc = String(row[descCol]).trim();
        const deviceType = desc.substring(0, 3).toUpperCase();
        const normalizedRow = { ...row };
        normalizedRow['DESCRIPTION'] = deviceType;
        normalizedDescFile.rows.push(normalizedRow);
      } else {
        normalizedDescFile.rows.push(row);
      }
    });

    return files.map(f => {
      if (f.id === deviceTypeFile.id) return normalizedDeviceFile;
      if (f.id === descFile.id) return normalizedDescFile;
      return f;
    });
  }

  return files.map(f => f.id === deviceTypeFile.id ? normalizedDeviceFile : f);
}

function customMerge(files, rules) {
  const { normalize } = require('./lib/reconcileEngine');

  if (files.length !== 2) {
    const { merge } = require('./lib/reconcileEngine');
    return merge(files, rules);
  }

  const fileA = files[0];
  const fileB = files[1];

  const mergedRows = [];
  const mismatchRows = [];
  const mismatchCellStyles = [];
  let completeCount = 0;
  let incompleteCount = 0;
  let conflictCount = 0;

  const allColumns = [...new Set([...fileA.headers, ...fileB.headers])];

  const fileBMap = new Map();
  fileB.rows.forEach((row, idx) => {
    const key = rules.map(r => normalize(row[r.colB])).join('|');
    if (key) {
      if (!fileBMap.has(key)) {
        fileBMap.set(key, []);
      }
      fileBMap.get(key).push({ row, idx });
    }
  });

  const matchedBIndices = new Set();

  fileA.rows.forEach((rowA, idxA) => {
    const key = rules.map(r => normalize(rowA[r.colA])).join('|');
    const matches = key ? fileBMap.get(key) : [];

    if (matches && matches.length > 0) {
      matches.forEach(({ row: rowB, idx: idxB }) => {
        matchedBIndices.add(idxB);

        const merged = {};
        const rowConflicts = [];
        const rowMissing = [];

        allColumns.forEach(col => {
          const valA = rowA[col];
          const valB = rowB[col];
          if (valA !== undefined && valA !== null && valA !== '') {
            merged[col] = valA;
          }
          else if (valB !== undefined && valB !== null && valB !== '') {
            merged[col] = valB;
          }
          else {
            merged[col] = '';
          }
        });

        const hasDataFromA = fileA.headers.some(col => rowA[col] && rowA[col] !== '');
        const hasDataFromB = fileB.headers.some(col => rowB[col] && rowB[col] !== '');
        const hasDataFromBoth = hasDataFromA && hasDataFromB;

        allColumns.forEach(h => {
          const valA = String(rowA[h] || '').trim();
          const valB = String(rowB[h] || '').trim();
          
          let normalizedA = valA;
          let normalizedB = valB;
          
          if (h.toLowerCase().includes('date') || h.toLowerCase() === 'date') {
            normalizedA = extractDate(valA) || valA;
            normalizedB = extractDate(valB) || valB;
          }
          
          if (normalizedA && normalizedB && normalizedA !== normalizedB) {
            rowConflicts.push({ column: h, valA, valB });
          }
        });

        if (hasDataFromBoth && rowConflicts.length === 0) {
          mergedRows.push(merged);
          completeCount++;
        } else {
          const rowIndex = mismatchRows.length + 2;
          rowConflicts.forEach(conflict => {
            const colIndex = allColumns.indexOf(conflict.column) + 1;
            merged[conflict.column] = `${conflict.valA} | ${conflict.valB}`;
            mismatchCellStyles.push({
              rowIndex,
              colIndex,
              style: {
                fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } },
                font: { color: { argb: 'FFFFFFFF' } }
              },
              comment: `Conflict: ${fileA.name}="${conflict.valA}" vs ${fileB.name}="${conflict.valB}"`
            });
          });
          rowMissing.forEach(missing => {
            const colIndex = allColumns.indexOf(missing.column) + 1;
            mismatchCellStyles.push({
              rowIndex,
              colIndex,
              style: {
                fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
              }
            });
          });
          mismatchRows.push(merged);
          if (!hasDataFromBoth) incompleteCount++;
          if (rowConflicts.length > 0) conflictCount++;
        }
      });
    } else {
      const merged = {};
      const rowIndex = mismatchRows.length + 2;
      allColumns.forEach((col, i) => {
        merged[col] = rowA[col] || '';
      });
      allColumns.forEach((col, i) => {
        mismatchCellStyles.push({
          rowIndex,
          colIndex: i + 1,
          style: {
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
          }
        });
      });
      mismatchRows.push(merged);
      incompleteCount++;
    }
  });

  fileB.rows.forEach((rowB, idxB) => {
    if (!matchedBIndices.has(idxB)) {
      const merged = {};
      const rowIndex = mismatchRows.length + 2;
      allColumns.forEach((col, i) => {
        merged[col] = rowB[col] || '';
      });
      allColumns.forEach((col, i) => {
        mismatchCellStyles.push({
          rowIndex,
          colIndex: i + 1,
          style: {
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
          }
        });
      });
      mismatchRows.push(merged);
      incompleteCount++;
    }
  });

  return {
    mergedRows,
    mismatchRows,
    mismatchCellStyles,
    stats: {
      totalGroups: mergedRows.length + mismatchRows.length,
      completeCount,
      incompleteCount,
      conflictCount,
    },
  };
}

function extractDate(dateTimeStr) {
  if (!dateTimeStr) return '';
  const str = String(dateTimeStr).trim();

  const monthNames = {
    'january': 1, 'jan': 1, 'february': 2, 'feb': 2, 'march': 3, 'mar': 3,
    'april': 4, 'apr': 4, 'may': 5, 'june': 6, 'jun': 6,
    'july': 7, 'jul': 7, 'august': 8, 'aug': 8, 'september': 9, 'sep': 9, 'sept': 9,
    'october': 10, 'oct': 10, 'november': 11, 'nov': 11, 'december': 12, 'dec': 12
  };

  const datePatterns = [
    { pattern: /(\d{4})-(\d{1,2})-(\d{1,2})/, format: 'iso' },
    { pattern: /(\d{1,2})\.(\d{1,2})\.(\d{4})/, format: 'dmy-dot' },
    { pattern: /(\d{1,2})-(\d{1,2})-(\d{4})/, format: 'dmy-dash' },
    { pattern: /(\d{1,2})\/(\d{1,2})\/(\d{4})/, format: 'dmy-slash' },
    { pattern: /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/, format: 'dmy-text' },
  ];

  for (const { pattern, format } of datePatterns) {
    const match = str.match(pattern);
    if (match) {
      const [, p1, p2, p3] = match;
      let year, month, day;

      if (format === 'iso') {
        year = p1; month = p2; day = p3;
        return str;
      } else if (format === 'dmy-dot' || format === 'dmy-dash' || format === 'dmy-slash') {
        day = p1; month = p2; year = p3;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      } else if (format === 'dmy-text') {
        day = p1; month = p2; year = p3;
        const monthNum = monthNames[month.toLowerCase()];
        if (monthNum) {
          return `${year}-${monthNum.toString().padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
      }
    }
  }

  return '';
}

function extractTime(dateTimeStr) {
  if (!dateTimeStr) return '';
  const str = String(dateTimeStr).trim();

  const timeMatch = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    let [, hours, minutes] = timeMatch;
    hours = parseInt(hours, 10);
    minutes = parseInt(minutes, 10);

    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }
  }

  return '';
}

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`SheetFusion server running at http://localhost:${PORT}`);
});
