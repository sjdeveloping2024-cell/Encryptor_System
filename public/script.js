const dropZone = document.getElementById('dropZone');
const dropText = document.getElementById('dropText');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileChip = document.getElementById('fileChip');
const chipName = document.getElementById('chipName');
const chipSize = document.getElementById('chipSize');
const encryptBtn = document.getElementById('encryptBtn');
const decryptBtn = document.getElementById('decryptBtn');
const resultBox = document.getElementById('resultBox');
const resultTitle = document.getElementById('resultTitle');
const preview = document.getElementById('preview');
const downloadBtn = document.getElementById('downloadBtn');
const statusEl = document.getElementById('status');

const ACCEPTED = ['.txt', '.pdf', '.docx', '.md', '.csv'];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let selectedFile = null;
let lastResult = null;
let busy = false;

function say(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', !!isError);
  statusEl.classList.add('show');
}

function clearSay() {
  statusEl.textContent = '';
  statusEl.classList.remove('show', 'error');
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

// Rejecting a file the tool cannot read is faster and clearer than letting the request fail.
function rejectFile(name) {
  dropZone.classList.remove('drag-over');
  dropZone.classList.add('rejected');
  setTimeout(() => dropZone.classList.remove('rejected'), 500);
  say(`Cannot read ${extensionOf(name) || 'that file type'} — use .txt, .pdf, .docx, .md or .csv`, true);
}

function setFile(file) {
  if (!ACCEPTED.includes(extensionOf(file.name))) {
    rejectFile(file.name);
    return;
  }
  selectedFile = file;
  dropText.textContent = 'File ready';
  chipName.textContent = file.name;
  chipSize.textContent = `${(file.size / 1024).toFixed(1)} KB`;
  fileChip.classList.remove('show');
  // Reflow so the chip replays its entrance animation on every new pick.
  void fileChip.offsetWidth;
  fileChip.classList.add('show');
  encryptBtn.disabled = false;
  decryptBtn.disabled = false;
  clearSay();
}

// ---------- drag and drop ----------

// dragenter/dragleave fire for every child element, so depth is counted to avoid flicker.
let dragDepth = 0;

function showDragHint() {
  dropText.textContent = 'Release to load your file';
}

function resetDragHint() {
  dropText.textContent = selectedFile ? 'File ready' : 'Drag & drop your file here';
}

function onDragEnter(e) {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropZone.classList.add('drag-over');
  showDragHint();
}

function onDragOver(e) {
  if (!e.dataTransfer) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(e) {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropZone.classList.remove('drag-over');
    resetDragHint();
  }
}

function onDrop(e) {
  if (!e.dataTransfer) return;
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('drag-over');
  resetDragHint();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setFile(file);
}

// The window-level pair stops the highlight sticking when the pointer leaves the window.
window.addEventListener('dragenter', onDragEnter);
window.addEventListener('dragover', onDragOver);
window.addEventListener('dragleave', onDragLeave);
window.addEventListener('drop', onDrop);
window.addEventListener('dragend', () => {
  dragDepth = 0;
  dropZone.classList.remove('drag-over');
  resetDragHint();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setFile(fileInput.files[0]);
});

dropZone.addEventListener('click', (e) => {
  if (e.target.closest('.browse')) return;
  fileInput.click();
});

dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

// ---------- button feedback ----------

// Ripple starts at the pointer so it reads as a real press.
function attachRipple(button) {
  button.addEventListener('pointerdown', (e) => {
    if (reduceMotion || button.disabled) return;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left}px`;
    ripple.style.top = `${e.clientY - rect.top}px`;
    button.appendChild(ripple);
    setTimeout(() => ripple.remove(), 640);
  });
}

[encryptBtn, decryptBtn, downloadBtn].forEach(attachRipple);

// ---------- processing ----------

function setBusy(button, on) {
  busy = on;
  button.dataset.busy = on ? 'true' : 'false';
  encryptBtn.disabled = on || !selectedFile;
  decryptBtn.disabled = on || !selectedFile;
}

async function process(action) {
  if (!selectedFile || busy) return;
  const button = action === 'encrypt' ? encryptBtn : decryptBtn;
  setBusy(button, true);
  say('Processing…');

  const form = new FormData();
  form.append('file', selectedFile);
  form.append('action', action);

  try {
    const res = await fetch('/api/process', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    lastResult = data;
    resultBox.hidden = false;
    resultTitle.textContent = action === 'encrypt' ? 'Encrypted result' : 'Decrypted result';
    preview.value = data.preview;
    // Restart the panel entrance so repeat runs feel alive.
    resultBox.style.animation = 'none';
    void resultBox.offsetWidth;
    resultBox.style.animation = '';
    say(`Done: ${data.filename}`);
  } catch (err) {
    say(`Error: ${err.message}`, true);
  } finally {
    setBusy(button, false);
  }
}

encryptBtn.addEventListener('click', () => process('encrypt'));
decryptBtn.addEventListener('click', () => process('decrypt'));

downloadBtn.addEventListener('click', () => {
  if (!lastResult) return;
  const bytes = Uint8Array.from(atob(lastResult.content), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = lastResult.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick so the navigation has already started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
});