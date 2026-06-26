(function () {
  "use strict";

  let uploadedFiles = [];
  let fileCounter = 0;
  let lastResult = null;

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileCardsEl = document.getElementById('fileCards');
  const uploadMsg = document.getElementById('uploadMsg');
  const addMoreFilesBtn = document.getElementById('addMoreFilesBtn');

  const stepProcess = document.getElementById('step-process');
  const stepResults = document.getElementById('step-results');

  const processBtn = document.getElementById('processBtn');
  const processMsg = document.getElementById('processMsg');
  const statsEl = document.getElementById('stats');
  const downloadMergedBtn = document.getElementById('downloadMerged');
  const downloadMismatchesBtn = document.getElementById('downloadMismatches');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const outputFilename = document.getElementById('outputFilename');

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showMsg(target, text) {
    target.innerHTML = '<div class="msg">' + escapeHtml(text) + '</div>';
    window.setTimeout(function () {
      if (target.innerHTML.indexOf(escapeHtml(text)) !== -1) target.innerHTML = '';
    }, 6000);
  }

  function fileName(id) {
    const f = uploadedFiles.find(function (x) { return x.id === id; });
    return f ? f.name : '(removed file)';
  }

  function readyFiles() {
    return uploadedFiles.filter(function (f) { return !f.loading && !f.error && f.headers.length; });
  }

  function addFile(file) {
    fileCounter += 1;
    const entry = {
      id: 'f' + fileCounter,
      name: file.name.replace(/\.(xlsx|xls|csv)$/i, ''),
      file: file,
      headers: [],
      rowCount: null,
      loading: true,
      error: null
    };
    uploadedFiles.push(entry);
    onFilesChanged();
    inspectFile(entry);
  }

  function inspectFile(entry) {
    const fd = new FormData();
    fd.append('file', entry.file);

    fetch('/api/inspect', { method: 'POST', body: fd })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || 'Could not read that file.');
        entry.headers = result.data.headers;
        entry.rowCount = result.data.rowCount;
        entry.loading = false;
      })
      .catch(function (err) {
        entry.loading = false;
        entry.error = err.message;
        showMsg(uploadMsg, entry.name + ': ' + err.message);
      })
      .finally(onFilesChanged);
  }

  function handleFiles(fileList) {
    Array.from(fileList).forEach(addFile);
  }

  function removeFile(id) {
    uploadedFiles = uploadedFiles.filter(function (f) { return f.id !== id; });
    onFilesChanged();
  }

  function renderFileCards() {
    if (!uploadedFiles.length) {
      fileCardsEl.innerHTML = '';
      return;
    }
    fileCardsEl.innerHTML = uploadedFiles.map(function (f) {
      const removeBtn = '<button class="fc-remove" data-remove="' + f.id + '" aria-label="Remove ' + escapeHtml(f.name) + '">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<line x1="18" y1="6" x2="6" y2="18"/>' +
        '<line x1="6" y1="6" x2="18" y2="18"/>' +
        '</svg></button>';

      if (f.loading) {
        return '<div class="file-card is-loading" data-id="' + f.id + '">' + removeBtn +
          '<p class="fc-name">' + escapeHtml(f.name) + '</p>' +
          '<p class="fc-meta">Reading file…</p></div>';
      }
      if (f.error) {
        return '<div class="file-card" data-id="' + f.id + '">' + removeBtn +
          '<p class="fc-name">' + escapeHtml(f.name) + '</p>' +
          '<p class="fc-meta" style="color:#dc2626;">' + escapeHtml(f.error) + '</p></div>';
      }
      const chips = f.headers.slice(0, 8).map(function (h) {
        return '<span class="fc-chip">' + escapeHtml(h) + '</span>';
      }).join('');
      const more = f.headers.length > 8 ? '<span class="fc-chip">+' + (f.headers.length - 8) + ' more</span>' : '';
      return '<div class="file-card" data-id="' + f.id + '">' + removeBtn +
        '<p class="fc-name">' + escapeHtml(f.name) + '</p>' +
        '<p class="fc-meta">' + f.rowCount + ' rows · ' + f.headers.length + ' columns</p>' +
        '<div class="fc-cols">' + chips + more + '</div></div>';
    }).join('');

    Array.from(fileCardsEl.querySelectorAll('[data-remove]')).forEach(function (btn) {
      btn.addEventListener('click', function () { 
        const card = btn.closest('.file-card');
        card.style.transform = 'scale(0.9)';
        card.style.opacity = '0';
        setTimeout(function () {
          removeFile(btn.getAttribute('data-remove'));
        }, 200);
      });
    });
  }

  function onFilesChanged() {
    renderFileCards();

    const hasFiles = readyFiles().length >= 1;
    if (hasFiles && stepProcess.style.display === 'none') {
      stepProcess.style.display = 'block';
      stepProcess.style.animation = 'fade-in-up 0.6s ease-out';
    } else if (!hasFiles) {
      stepProcess.style.display = 'none';
    }
    addMoreFilesBtn.style.display = hasFiles ? 'block' : 'none';

    stepResults.style.display = 'none';
    lastResult = null;
  }

  function runMerge() {
    const files = readyFiles();
    if (!files.length) { showMsg(uploadMsg, 'Upload at least one file first.'); return; }

    processBtn.disabled = true;
    processBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">' +
      '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>' +
      '</svg> Merging…';

    const fd = new FormData();
    files.forEach(function (f) { fd.append('files', f.file, f.file.name); });
    fd.append('meta', JSON.stringify(files.map(function (f) { return { id: f.id, name: f.name, headers: f.headers }; })));

    fetch('/api/reconcile', { method: 'POST', body: fd })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || 'Merge failed.');
        lastResult = result.data;
        renderStats(lastResult.stats);
        stepResults.style.display = 'block';
        stepResults.style.animation = 'fade-in-up 0.6s ease-out';
        stepResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function (err) {
        showMsg(processMsg, err.message);
      })
      .finally(function () {
        processBtn.disabled = false;
        processBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>' +
          '</svg> Merge files';
      });
  }

  function renderStats(stats) {
    statsEl.innerHTML =
      '<div class="stat-box"><div class="num">' + stats.totalGroups + '</div><div class="lbl">Total records</div></div>' +
      '<div class="stat-box complete"><div class="num">' + stats.completeCount + '</div><div class="lbl">Fully matched</div></div>' +
      '<div class="stat-box incomplete"><div class="num">' + stats.incompleteCount + '</div><div class="lbl">Missing data</div></div>' +
      '<div class="stat-box conflict"><div class="num">' + stats.conflictCount + '</div><div class="lbl">Conflicting values</div></div>';
  }

  function downloadBase64(base64, filename) {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.xlsx') ? filename : filename + '.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', function (e) { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('drag-over'); });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files.length) handleFiles(fileInput.files);
    fileInput.value = '';
  });

  addMoreFilesBtn.addEventListener('click', function () { fileInput.click(); });

  processBtn.addEventListener('click', runMerge);

  downloadMergedBtn.addEventListener('click', function () {
    if (lastResult) {
      const filename = outputFilename.value || 'merged-data';
      downloadBase64(lastResult.mergedFileBase64, filename);
    }
  });
  downloadMismatchesBtn.addEventListener('click', function () {
    if (lastResult) downloadBase64(lastResult.mismatchFileBase64, 'mismatches.xlsx');
  });

  clearAllBtn.addEventListener('click', function () {
    uploadedFiles = [];
    lastResult = null;
    fileCardsEl.innerHTML = '';
    statsEl.innerHTML = '';
    stepProcess.style.display = 'none';
    stepResults.style.display = 'none';
    addMoreFilesBtn.style.display = 'none';
  });

})();
