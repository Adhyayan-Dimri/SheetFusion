function normalizeDate(str) {
  if (!str || typeof str !== 'string') return null;

  const trimmed = str.trim();
  if (!trimmed) return null;

  let datePart = trimmed;
  const timePatterns = [
    /\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i,
    /\s+(\d{1,2})\.(\d{2})(?:\.(\d{2}))?(?:\s*(AM|PM))?$/i,
    /\s+(\d{1,2})h(\d{2})(?:m)?$/i,
  ];

  for (const pattern of timePatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      datePart = trimmed.substring(0, match.index).trim();
      break;
    }
  }

  const dateObj = new Date(datePart);
  if (!isNaN(dateObj.getTime())) {
    const year = dateObj.getFullYear();
    if (year > 1900 && year < 2100) {
      return dateObj.toISOString().split('T')[0];
    }
  }

  const monthNames = {
    'january': 1, 'jan': 1, 'february': 2, 'feb': 2, 'march': 3, 'mar': 3,
    'april': 4, 'apr': 4, 'may': 5, 'june': 6, 'jun': 6,
    'july': 7, 'jul': 7, 'august': 8, 'aug': 8, 'september': 9, 'sep': 9, 'sept': 9,
    'october': 10, 'oct': 10, 'november': 11, 'nov': 11, 'december': 12, 'dec': 12
  };

  const dmyMatch = datePart.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const date = new Date(y, m - 1, d);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  const mdyMatch = datePart.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    const date = new Date(y, m - 1, d);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  const ymdMatch = datePart.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch;
    const date = new Date(y, m - 1, d);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  const dMonthYMatch = datePart.match(/^(\d{1,2})[-/.]\s*([a-zA-Z]+)\s*[-/.](\d{4})$/);
  if (dMonthYMatch) {
    const [, d, monthStr, y] = dMonthYMatch;
    const monthNum = monthNames[monthStr.toLowerCase()];
    if (monthNum) {
      const date = new Date(y, monthNum - 1, d);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
  }

  const monthDYMatch = datePart.match(/^([a-zA-Z]+)\s*[-/.](\d{1,2})\s*[-/.](\d{4})$/);
  if (monthDYMatch) {
    const [, monthStr, d, y] = monthDYMatch;
    const monthNum = monthNames[monthStr.toLowerCase()];
    if (monthNum) {
      const date = new Date(y, monthNum - 1, d);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
  }

  return null;
}

function normalizeTime(str) {
  if (!str || typeof str !== 'string') return null;

  const trimmed = str.trim();
  if (!trimmed) return null;

  const timePatterns = [
    /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i,
    /(\d{1,2})\.(\d{2})(?:\.(\d{2}))?(?:\s*(AM|PM))?$/i,
    /(\d{1,2})h(\d{2})(?:m)?$/i,
  ];

  for (const pattern of timePatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      let [, hours, minutes, seconds, meridiem] = match;
      hours = parseInt(hours, 10);
      minutes = parseInt(minutes, 10);

      if (meridiem) {
        const upperMeridiem = meridiem.toUpperCase();
        if (upperMeridiem === 'PM' && hours !== 12) {
          hours += 12;
        } else if (upperMeridiem === 'AM' && hours === 12) {
          hours = 0;
        }
      }

      if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
        const formattedHours = hours.toString().padStart(2, '0');
        const formattedMinutes = minutes.toString().padStart(2, '0');
        return `${formattedHours}:${formattedMinutes}`;
      }
    }
  }

  return null;
}

function normalize(v) {
  if (v === undefined || v === null) return '';
  const str = String(v);
  if (str === undefined || str === null) return '';

  const trimmed = str.trim();
  if (!trimmed) return '';

  const normalizedDate = normalizeDate(trimmed);
  if (normalizedDate) {
    return normalizedDate;
  }

  const normalizedTime = normalizeTime(trimmed);
  if (normalizedTime) {
    return normalizedTime;
  }

  return trimmed.toLowerCase();
}

function merge(files, rules) {
  const byId = {};
  files.forEach((f) => {
    byId[f.id] = f;
  });
  const fileName = (id) => (byId[id] ? byId[id].name : '(removed file)');

  const parent = {};
  const key = (fileId, idx) => `${fileId}#${idx}`;
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  files.forEach((f) => {
    f.rows.forEach((_, idx) => {
      parent[key(f.id, idx)] = key(f.id, idx);
    });
  });

  rules.forEach((rule) => {
    const fA = byId[rule.fileA];
    const fB = byId[rule.fileB];
    if (!fA || !fB) return;

    const mapA = {};
    fA.rows.forEach((r, idx) => {
      const v = normalize(r[rule.colA]);
      if (v) (mapA[v] = mapA[v] || []).push(idx);
    });
    const mapB = {};
    fB.rows.forEach((r, idx) => {
      const v = normalize(r[rule.colB]);
      if (v) (mapB[v] = mapB[v] || []).push(idx);
    });

    Object.keys(mapA).forEach((v) => {
      if (mapB[v]) {
        mapA[v].forEach((ia) => {
          mapB[v].forEach((ib) => {
            union(key(fA.id, ia), key(fB.id, ib));
          });
        });
      }
    });
  });

  const groups = {};
  files.forEach((f) => {
    f.rows.forEach((_, idx) => {
      const root = find(key(f.id, idx));
      (groups[root] = groups[root] || []).push({ fileId: f.id, idx });
    });
  });

  const mergedRows = [];
  const mismatchRows = [];
  let groupNum = 0;
  let completeCount = 0;
  let incompleteCount = 0;
  let conflictCount = 0;

  Object.keys(groups).forEach((rootKey) => {
    const members = groups[rootKey];
    groupNum += 1;

    const occurrence = {};
    members.forEach((m) => {
      occurrence[m.fileId] = (occurrence[m.fileId] || 0) + 1;
    });
    const seenSoFar = {};

    const merged = {};
    const headerValues = {};
    const duplicateNotes = [];

    members.forEach((m) => {
      const f = byId[m.fileId];
      const row = f.rows[m.idx];
      seenSoFar[m.fileId] = (seenSoFar[m.fileId] || 0) + 1;
      const suffix = occurrence[m.fileId] > 1 ? ` #${seenSoFar[m.fileId]}` : '';

      f.headers.forEach((h) => {
        const val = row[h] !== undefined ? row[h] : '';
        const colName = h;
        merged[colName] = val;
        const lh = (h !== undefined && h !== null) ? h.trim().toLowerCase() : '';
        (headerValues[lh] = headerValues[lh] || []).push({
          fileName: f.name,
          header: h,
          value: String(val).trim(),
        });
      });
    });

    Object.keys(occurrence).forEach((fid) => {
      if (occurrence[fid] > 1) {
        duplicateNotes.push(`${fileName(fid)} matched ${occurrence[fid]} rows in this group`);
      }
    });

    const contributingFileIds = Object.keys(occurrence);
    const missingFiles = files
      .filter((f) => contributingFileIds.indexOf(f.id) === -1)
      .map((f) => f.name);
    const matchStatus = missingFiles.length === 0 ? 'Complete' : 'Incomplete';

    const conflicts = [];
    Object.keys(headerValues).forEach((lh) => {
      const entries = headerValues[lh];
      const nonEmpty = entries.filter((e) => e.value !== '');
      if (nonEmpty.length < 2) return;
      const distinct = {};
      nonEmpty.forEach((e) => {
        distinct[e.value.toLowerCase()] = true;
      });
      if (Object.keys(distinct).length > 1) {
        const desc = nonEmpty.map((e) => `${e.fileName}="${e.value}"`).join(' vs ');
        conflicts.push(`${nonEmpty[0].header}: ${desc}`);
      }
    });

    if (matchStatus === 'Complete') completeCount += 1;
    else incompleteCount += 1;
    if (conflicts.length) conflictCount += 1;

    const outRow = merged;

    // Only add to merged rows if complete (exists in all files) and no conflicts
    if (matchStatus === 'Complete' && conflicts.length === 0) {
      mergedRows.push(outRow);
    }
    // Add to mismatch if incomplete or has conflicts
    if (matchStatus === 'Incomplete' || conflicts.length) mismatchRows.push(outRow);
  });

  return {
    mergedRows,
    mismatchRows,
    stats: {
      totalGroups: groupNum,
      completeCount,
      incompleteCount,
      conflictCount,
    },
  };
}

module.exports = { merge, normalize };
