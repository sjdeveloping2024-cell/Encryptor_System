const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const { PDFDocument, StandardFonts, PDFName, PDFDict, PDFString, PDFOperator, PDFOperatorNames, PDFNumber } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- alphabets ----------

const small = {};
'abcdefghijklmnopqrstuvwxyz'.split('').forEach((ch, i) => (small[ch] = 26 - i)); // a=26..z=1
const big = {};
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((ch, i) => (big[ch] = i + 1)); // A=1..Z=26
const bigFromCode = {}; Object.entries(big).forEach(([ch, n]) => (bigFromCode[n] = ch));
const SMALL_FROM_CODE = {}; Object.entries(small).forEach(([ch, n]) => (SMALL_FROM_CODE[n] = ch));

// Punctuation codes. i, n, q and w each stand for two characters on purpose, exactly as
// specified: i = ( )   n = \ /   q = { }   w = [ ]
const nonLettersToLetter = {
  '!': 'a', '^': 'b', '@': 'c', '#': 'd', '$': 'e', '%': 'f', '&': 'g',
  '*': 'h', '(': 'i', ')': 'i', ':': 'j', ';': 'k', "'": 'l', '"': 'm',
  '\\': 'n', '/': 'n', '|': 'o', '-': 'p', '{': 'q', '}': 'q', '.': 'r',
  '=': 's', '+': 't', '_': 'v', '[': 'w', ']': 'w', '~': 'x', '?': 'y',
  '`': 'z', '<': '0', ',': '2',
};

// Those four codes are shared, so the cipher text on its own cannot say which member of the pair
// was seen. Decoding always returns the first member, so encrypting records one bit per occurrence
// and decryption replays them. The note is stored beside the layer and is never drawn.
const AMBIGUOUS_PAIRS = [['(', ')'], ['\\', '/'], ['{', '}'], ['[', ']']];

function ambiguousKey(text) {
  let key = '';
  for (const ch of String(text)) {
    for (const pair of AMBIGUOUS_PAIRS) {
      if (pair[0] === ch) { key += '0'; break; }
      if (pair[1] === ch) { key += '1'; break; }
    }
  }
  return key;
}

function applyAmbiguousKey(text, key, state) {
  if (!key) return text;
  let out = '';
  for (const ch of String(text)) {
    let pair = null;
    for (const p of AMBIGUOUS_PAIRS) if (p[0] === ch) { pair = p; break; }
    if (!pair) { out += ch; continue; }
    out += key[state.i++] === '1' ? pair[1] : pair[0];
  }
  return out;
}

const digitToSymbol = {
  '1': ')', '2': '(', '3': '*', '4': '&', '5': '^',
  '6': '%', '7': '$', '8': '#', '9': '@', '0': '!',
};
const symbolToDigit = {}; Object.entries(digitToSymbol).forEach(([d, s]) => (symbolToDigit[s] = d));

// Letter notes are stored per document, but each run only owns a slice of them. Splitting the
// notes per item first would need a second pass, so instead the shared cursor is threaded through
// and advanced by decryptText as it consumes letters.
const NOTE_CURSOR = { i: 0 };

// ---------- cipher ----------
//
// Letters are written as their plain number with no padding and no separator, exactly as
// specified: small letters run z=1 .. a=26, big letters run A=1 .. Z=26, so "Rounder" becomes
// 181261323229 and "to" becomes 712.
//
// Both tables cover 1..26 and the digits run together, so the number alone records neither the
// case nor where one value stops. Decryption therefore needs notes kept beside the layer and never
// drawn: CASE_NOTE holds one character per letter ('u' small, 'U' big) so the letter sequence is
// known, and WIDTH_NOTE holds how many digits each of those letters consumed.

const CASE_NOTE_KEY = 'u';

// One 'u' or 'U' per letter, in order.
function letterCaseNote(text) {
  let note = '';
  for (const ch of String(text)) {
    if (ch >= 'a' && ch <= 'z') note += CASE_NOTE_KEY;
    else if (ch >= 'A' && ch <= 'Z') note += ch;
  }
  return note;
}

// Digits each letter wrote, in the same order as letterCaseNote.
function letterWidthNote(text) {
  let note = '';
  for (const ch of String(text)) {
    if (ch >= 'a' && ch <= 'z') note += String(small[ch]).length;
    else if (ch >= 'A' && ch <= 'Z') note += String(big[ch]).length;
  }
  return note;
}

function encryptText(text) {
  let out = '';
  for (const ch of String(text)) {
    if (ch >= 'a' && ch <= 'z') out += String(small[ch]);
    else if (ch >= 'A' && ch <= 'Z') out += String(big[ch]);
    else if (ch >= '0' && ch <= '9') out += digitToSymbol[ch];
    else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') out += ch;
    else if (nonLettersToLetter[ch] !== undefined) out += '[' + nonLettersToLetter[ch] + ']';
    else out += '[' + ch.codePointAt(0) + ']';
  }
  return out;
}

// Reads digits back into letters. With the notes the case and the digit widths are both known; a
// bare digit run with no notes is ambiguous, so it falls back to two digits at a time.
function decryptText(text, caseNote, widthNote, cursor) {
  const cases = caseNote ? String(caseNote) : '';
  const widths = widthNote ? String(widthNote) : '';
  const at = cursor ? cursor.i : 0;
  let letterIndex = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') {
      const end = text.indexOf(']', i + 1);
      if (end === -1) { out += ch; continue; }
      const v = text.slice(i + 1, end);
      if (v === '0') out += '<';
      else if (v === '2') out += ',';
      else if (v === '1') out += '=';
      else if (/^[a-z]$/.test(v)) {
        out += Object.keys(nonLettersToLetter).find(k => nonLettersToLetter[k] === v) || v;
      } else if (/^\d+$/.test(v)) out += String.fromCodePoint(Number(v));
      else out += v;
      i = end;
    } else if (ch >= '0' && ch <= '9') {
      const idx = at + letterIndex;
      const wanted = widths ? Number(widths[idx]) : 0;
      const take = wanted > 0 ? wanted : 2;
      let digits = '';
      while (digits.length < take && i + digits.length < text.length && /[0-9]/.test(text[i + digits.length])) {
        digits += text[i + digits.length];
      }
      if (!digits) { out += ch; continue; }
      const n = Number(digits);
      const isSmall = cases ? cases[idx] === CASE_NOTE_KEY : false;
      const letter = isSmall ? SMALL_FROM_CODE[n] : bigFromCode[n];
      letterIndex++;
      if (letter) {
        out += letter;
        i += digits.length - 1;
      } else {
        out += ch;
      }
    } else if (symbolToDigit[ch] !== undefined) out += symbolToDigit[ch];
    else out += ch;
  }
  if (cursor) cursor.i = at + letterIndex;
  return out;
}

// ---------- local font resolution ----------

const FONT_DIRS = [
  'C:\\Windows\\Fonts',
  '/usr/share/fonts/truetype/dejavu',
  '/usr/share/fonts/truetype/liberation',
  '/usr/share/fonts/TTF',
  '/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
];

const FAMILY_ALIASES = {
  calibri: 'calibri.ttf', calibribold: 'calibrib.ttf', calibrilight: 'calibril.ttf',
  cambria: 'cambria.ttc', cambriabold: 'cambriab.ttf',
  arial: 'arial.ttf', arialmt: 'arial.ttf', arialbold: 'arialbd.ttf',
  arialt: 'ariali.ttf', arialnarrow: 'arialn.ttf', arialtmn: 'arialn.ttf',
  helvetica: 'arial.ttf', helveticabold: 'arialbd.ttf', helveticaoblique: 'ariali.ttf',
  times: 'times.ttf', timesroman: 'times.ttf', timesnewroman: 'times.ttf',
  timesnewromanps: 'times.ttf', timesnewromanpsmt: 'times.ttf', timesbold: 'timesbd.ttf',
  courier: 'cour.ttf', couriernew: 'cour.ttf', couriernewpsmt: 'cour.ttf',
  symbol: 'seguisym.ttf', symbolmt: 'seguisym.ttf',
  wingdings: 'wingding.ttf', webdings: 'webdings.ttf',
  segoeui: 'segoeui.ttf', tahoma: 'tahoma.ttf', verdana: 'verdana.ttf',
  georgia: 'georgia.ttf', trebuchetms: 'trebuc.ttf', consolas: 'consola.ttf',
  constan: 'constan.ttf', candara: 'candara.ttf', corbel: 'corbel.ttf',
  franklingothicbook: 'FRABK.TTF', bahnschrift: 'bahnschrift.ttf',
};

const GENERIC_FONT_FILES = [
  'arial.ttf', 'segoeui.ttf', 'seguisym.ttf', 'tahoma.ttf',
  'verdana.ttf', 'consola.ttf', 'times.ttf', 'cour.ttf',
];

const RENDER_SCALE = 3;
const MIN_TZ = 0.02;
const MIN_FIT = 0.32;
const MAX_FIT = 2.5;
// Cipher text is longer than the plain text, so runs are shrunk before they are squeezed sideways.
const SQUASH_LIMIT = 0.68;
const MIN_SIZE_MUL = 0.5;
const WIDTH_TOLERANCE = 0.18;

// ---------- invisible text layer ----------
// The layer is stored as plain ASCII so it can use a base-14 font: whitespace becomes a numeric
// token, every literal bracket is escaped, and anything above ASCII becomes a codepoint token.
const LAYER_FLAG = 'EncryptorLayer';
// Font files used by the source runs, so a later pass can redraw with the same faces.
const LAYER_FONTS = 'EncryptorFonts';
// One bit per ambiguous character, so decryption can restore ( ) \ / { } [ ] exactly.
const LAYER_AMBIG = 'EncryptorAmb';
// Letters are written as bare digits, so the case and the digit widths are noted here.
const LAYER_CASE = 'EncryptorCase';
const LAYER_WIDTH = 'EncryptorWidth';
const LAYER_TAG_RE = /^\[F(\d+)\]/;
// Font tags are layer metadata, not page content.
function stripLayerTags(text) {
  let s = String(text);
  while (LAYER_TAG_RE.test(s)) s = s.replace(LAYER_TAG_RE, "");
  return s;
}


function escapeLayer(text) {
  let out = '';
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (ch === ' ') out += '[32]';
    else if (ch === '\n') out += '[10]';
    else if (ch === '\t') out += '[9]';
    else if (ch === '\r') out += '[13]';
    else if (ch === '[') out += '[91]';
    else if (cp > 126) out += `[${cp}]`;
    else out += ch;
  }
  return out;
}

function unescapeLayer(text) {
  const s = String(text);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') { out += s[i]; continue; }
    const end = s.indexOf(']', i + 1);
    if (end === -1) { out += s[i]; continue; }
    const v = s.slice(i + 1, end);
    if (/^\d+$/.test(v)) { out += String.fromCodePoint(Number(v)); i = end; }
    else out += s[i];
  }
  return out;
}

// Reverses only the tokens escapeLayer introduces, so cipher tokens such as [8594] survive intact.
const LAYER_ESCAPES = { '32': ' ', '10': '\n', '9': '\t', '13': '\r', '91': '[' };
function stripLayerEscapes(text) {
  const s = String(text);
  if (!s.includes('[')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') { out += s[i]; continue; }
    const end = s.indexOf(']', i + 1);
    if (end === -1) { out += s[i]; continue; }
    const v = s.slice(i + 1, end);
    if (Object.prototype.hasOwnProperty.call(LAYER_ESCAPES, v)) { out += LAYER_ESCAPES[v]; i = end; }
    else out += s[i];
  }
  return out;
}

const fontFileCache = new Map();
let familyCounter = 0;

function loadFontFile(file) {
  if (fontFileCache.has(file)) return fontFileCache.get(file);
  let entry = null;
  try {
    const bytes = fs.readFileSync(file);
    const fkFont = fontkit.create(bytes);
    if (typeof fkFont.hasGlyphForCodePoint === 'function') {
      // Each file gets its own alias so canvas cannot silently substitute another face.
      const real = String(fkFont.familyName || 'PDFFont').replace(/[^A-Za-z0-9]/g, '') || 'PDFFont';
      const family = `${real}_${familyCounter++}`;
      try { GlobalFonts.registerFromPath(file, family); } catch (e) {}
      entry = { file, bytes, fkFont, family, realName: fkFont.familyName || '', style: fkFont.subfamilyName || '' };
    }
  } catch (e) { /* .ttc collections and unreadable files are skipped */ }
  fontFileCache.set(file, entry);
  return entry;
}

function loadFontByFileName(name) {
  for (const dir of FONT_DIRS) {
    const p = path.join(dir, name);
    try {
      if (!fs.existsSync(p)) continue;
      const e = loadFontFile(p);
      if (e) return e;
    } catch (e) {}
  }
  return null;
}

let genericCache = null;
function genericFonts() {
  if (!genericCache) genericCache = GENERIC_FONT_FILES.map(loadFontByFileName).filter(Boolean);
  return genericCache;
}

function resolveFamilyFont(baseFont) {
  if (!baseFont) return null;
  // PDF names arrive as /Tag+Family, so both the slash and the subset tag have to go.
  let fam = String(baseFont).replace(/^\//, '').replace(/^[A-Za-z]{6}\+/, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!fam || fam.startsWith('notdef')) return null;
  const bare = fam.replace(/(psmt|mt|ps|regular|roman|italic|oblique|bold)$/g, '');
  const isBold = /bold/.test(fam);
  const names = [];
  const add = n => { if (n && !names.includes(n)) names.push(n); };
  add(FAMILY_ALIASES[fam]);
  add(FAMILY_ALIASES[bare]);
  if (isBold) add(FAMILY_ALIASES[bare + 'bold']);
  add(`${fam}.ttf`, `${bare}.ttf`, `${fam}.ttc`, `${bare}.ttc`);
  for (const n of names) {
    const e = loadFontByFileName(n);
    if (e) return e;
  }
  return null;
}

function advanceWidthOf(entry, text, size) {
  try {
    const run = entry.fkFont.layout(text);
    let units = 0;
    for (const g of run.glyphs) units += g.advanceWidth;
    return (units * size) / entry.fkFont.unitsPerEm;
  } catch (e) {
    return 0;
  }
}

// ---------- pdf helpers ----------

async function getPdfDoc(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = path.join(__dirname, 'node_modules', 'pdfjs-dist').replace(/\\/g, '/');
  return pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: `${root}/standard_fonts/`,
    cMapUrl: `${root}/cmaps/`,
    cMapPacked: true,
  }).promise;
}

// Reads /BaseFont names per page, in resource order, so runs can reuse the real fonts.
async function readFontNames(buffer) {
  const out = [];
  let doc = null;
  try { doc = await PDFDocument.load(buffer, { updateMetadata: false }); } catch (e) { return out; }
  for (const page of doc.getPages()) {
    const list = [];
    try {
      const fontsDict = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
      for (const key of fontsDict.keys()) {
        let baseFont = '';
        try {
          const obj = doc.context.lookup(fontsDict.get(key));
          const dict = obj && obj.dict ? obj.dict : obj;
          const bf = dict && dict.get ? dict.get(PDFName.of('BaseFont')) : null;
          if (bf) baseFont = bf.asString();
        } catch (e) {}
        // PDFName.asString() keeps the leading slash, but runs are matched as F<n>.
        list.push({ key: key.asString().replace(/^\//, ''), baseFont });
      }
    } catch (e) {}
    out.push(list);
  }
  return out;
}

// pdf.js reports the run height unscaled by Tz while the transform carries the horizontal
// squeeze, so the height is the size the run should be drawn at.
function runFontSize(item) {
  const t = item.transform;
  return item.height > 0.5 ? item.height : Math.hypot(t[0], t[1]);
}

function itemGeom(item, viewport) {
  const t = item.transform;
  const [dx, dy] = viewport.convertToViewportPoint(t[4], t[5]);
  return { x: dx, y: dy, fontPx: runFontSize(item) * viewport.scale, angle: Math.atan2(t[1], t[0]) };
}

async function renderPage(page, viewport) {
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  await page.render({
    canvasContext: ctx,
    viewport,
    canvasFactory: {
      create: (w, h) => { const c = createCanvas(w, h); return { canvas: c, context: c.getContext('2d') }; },
      reset() {},
      destroy() {},
    },
  }).promise;
  return { canvas, ctx };
}

async function getItems(page) {
  return (await page.getTextContent()).items.filter(it => it.str && it.str.length > 0);
}

function fontIndexFromName(fontName) {
  const m = /_f(\d+)$/.exec(String(fontName || ''));
  return m ? parseInt(m[1], 10) : 0;
}

// Picks the local font whose metrics agree with the run width reported by pdf.js.
function resolveItemFont(item, fontList) {
  const generics = genericFonts();
  const fallback = generics[0] || null;
  const size = Math.hypot(item.transform[0], item.transform[1]);
  const usable = !!(item.str && item.str.trim().length >= 2 && item.width > 0 && size > 0);
  const n = fontIndexFromName(item.fontName);
  const candidates = [];
  if (fontList && fontList.length) {
    const byKey = fontList.find(f => f.key === `F${n}`);
    if (byKey) candidates.push(byKey);
    if (fontList[n - 1]) candidates.push(fontList[n - 1]);
  }
  for (const c of candidates) {
    const e = resolveFamilyFont(c.baseFont);
    if (!e) continue;
    if (!usable) return e;
    const dev = Math.abs(advanceWidthOf(e, item.str, size) - item.width) / item.width;
    if (dev <= WIDTH_TOLERANCE) return e;
  }
  if (!usable || !item.width) return fallback;
  let best = fallback, bestDev = Infinity;
  for (const e of generics) {
    const dev = Math.abs(advanceWidthOf(e, item.str, size) - item.width) / item.width;
    if (dev < bestDev) { bestDev = dev; best = e; }
  }
  return best;
}

// The layer keeps the original run's height and advance width, so a later pass measures the same box
// the text came from. Each run is one show-text op scaled with Tz: splitting it would let pdf.js cut
// cipher tokens in half, and pdf.js also drops anything drawn outside the page box.
function drawHiddenText(page, payload, x, y, size, font, pageWidth, targetWidth) {
  if (!payload) return;
  const edge = Math.max(20, pageWidth - 2);
  const startX = Math.max(0, Math.min(x, edge - 20));
  const room = Math.max(4, targetWidth > 0 ? Math.min(targetWidth, edge - startX) : edge - startX);
  const natural = font.widthOfTextAtSize(payload, size);
  const sx = natural > 0.01 ? Math.max(MIN_TZ, room / natural) : 1;
  const key = page.node.newFontDictionary(font.name, font.ref);
  page.getContentStream().push(
    PDFOperator.of(PDFOperatorNames.BeginText),
    PDFOperator.of(PDFOperatorNames.SetFontAndSize, [key, PDFNumber.of(size)]),
    PDFOperator.of(PDFOperatorNames.SetTextMatrix, [
      PDFNumber.of(1), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(1), PDFNumber.of(0), PDFNumber.of(0)]),
    PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [PDFNumber.of(3)]),
    PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(sx * 100)]),
    PDFOperator.of(PDFOperatorNames.MoveText, [PDFNumber.of(startX), PDFNumber.of(y)]),
    PDFOperator.of(PDFOperatorNames.ShowText, [font.encodeText(payload)]),
    PDFOperator.of(PDFOperatorNames.EndText)
  );
}

function colorKey(r, g, b) { return (r << 16) | (g << 8) | b; }

// Modal colour of a rectangle, used to erase text without destroying the background.
function modalColor(pixels, x0, y0, w, h, maxY, excludeKey) {
  const width = pixels.width, data = pixels.data;
  const counts = new Map();
  const xs = Math.max(0, Math.floor(x0));
  const xe = Math.min(width - 1, Math.floor(x0 + w));
  const ys = Math.max(0, Math.floor(y0));
  const ye = Math.min(maxY - 1, Math.floor(y0 + h));
  for (let y = ys; y <= ye; y++) {
    for (let x = xs; x <= xe; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const k = colorKey(data[i], data[i + 1], data[i + 2]);
      if (excludeKey !== undefined && k === excludeKey) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k; }
  if (best === null) return null;
  return `rgb(${(best >> 16) & 255},${(best >> 8) & 255},${best & 255})`;
}

// Reads any one of the plain-text notes stored beside the layer.
async function readLayerNote(buffer, name) {
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    const v = doc.getInfoDict().get(PDFName.of(name));
    if (!v) return '';
    const s = String(v.toString());
    return s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s;
  } catch (e) { return ''; }
}

const readLayerAmb = buffer => readLayerNote(buffer, LAYER_AMBIG);

async function readLayerFonts(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    const v = doc.getInfoDict().get(PDFName.of(LAYER_FONTS));
    if (!v) return [];
    const s = String(v.toString());
    const raw = s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s;
    return raw ? raw.split('|').filter(Boolean) : [];
  } catch (e) { return []; }
}

// Reads the layer marker so files produced by this app are told apart from arbitrary pdfs.
async function readLayerFlag(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    const v = doc.getInfoDict().get(PDFName.of(LAYER_FLAG));
    if (!v) return '';
    return String(v.toString()).replace(/^\((.*)\)$/s, '$1');
  } catch (e) { return ''; }
}

// Rewrites a pdf: pages are rasterised at high resolution, original text is erased with the
// surrounding background colour and redrawn in the document's own fonts, while an invisible text
// layer carries an ASCII copy of the page text for later decryption.
async function rewritePdf(buffer, transformText, mode) {
  const inFlag = await readLayerFlag(buffer);
  const layerFonts = await readLayerFonts(buffer);
  // The four shared codes are replayed from a note kept beside the layer, so the round trip
  // is exact even though ( ) \ / { } [ ] encrypt alike.
  const ambKey = mode === 'plain' ? await readLayerAmb(buffer) : '';
  // Letters are bare digits, so the case and width notes travel with the layer.
  const decrypting = mode === 'plain';
  const caseNote = decrypting ? await readLayerNote(buffer, LAYER_CASE) : '';
  const widthNote = decrypting ? await readLayerNote(buffer, LAYER_WIDTH) : '';
  let caseCollected = '';
  const noteCursor = { i: 0 };
  let widthCollected = '';
  const ambState = { i: 0 };
  let ambCollected = '';
  const readText = inFlag === 'cipher' ? stripLayerEscapes : inFlag === 'plain' ? unescapeLayer : s => s;

  const fontNames = await readFontNames(buffer);
  const pdf = await getPdfDoc(buffer);
  const out = await PDFDocument.create();
  const layerFont = await out.embedFont(StandardFonts.Helvetica);
  const generics = genericFonts();
  const collected = [];
  const genericChain = (generics.length ? generics : []).map(g => g.family).concat(['Arial']).join(', ');

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const { canvas, ctx } = await renderPage(page, viewport);
    const items = await getItems(page);
    const pageFonts = fontNames[i - 1] || [];

    const transformed = items.map(it => {
      let raw = it.str;
      let tag = null;
      const tm = LAYER_TAG_RE.exec(raw);
      if (tm) { tag = Number(tm[1]); raw = raw.slice(tm[0].length); }
      const content = readText(raw);
      // The notes are per document, so they are built here in run order while encrypting.
      if (mode === 'cipher') {
        caseCollected += letterCaseNote(content);
        widthCollected += letterWidthNote(content);
        ambCollected += ambiguousKey(content);
      }
      let text = mode === 'cipher' ? encryptText(content) : decryptText(content, caseNote, widthNote, noteCursor);
      if (ambKey) text = applyAmbiguousKey(text, ambKey, ambState);
      let font = null;
      let idx = -1;
      if (tag !== null && layerFonts[tag]) {
        idx = tag;
        font = loadFontByFileName(layerFonts[tag]);
      } else {
        font = resolveItemFont(it, pageFonts);
        if (font) {
          const token = path.basename(font.file || '');
          if (token) {
            idx = layerFonts.indexOf(token);
            if (idx < 0) { layerFonts.push(token); idx = layerFonts.length - 1; }
          }
        }
      }
      return {
        item: it,
        text,
        payload: (idx >= 0 ? '[F' + idx + ']' : '') + escapeLayer(text),
        font,
      };
    });
    collected.push(...transformed.map(t => t.text));

    const painted = transformed.filter(t => t.item.str.trim().length > 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // background + ink colour per run, sampled before anything is erased
    for (const t of painted) {
      const g = itemGeom(t.item, viewport);
      const boxW = t.item.width * viewport.scale;
      const bg = modalColor(pixels, g.x, g.y + g.fontPx * 0.5, boxW, Math.max(2, g.fontPx * 0.3), canvas.height);
      t.bg = bg || '#ffffff';
      let bgKey = null;
      if (bg) {
        const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(bg);
        if (m) bgKey = colorKey(+m[1], +m[2], +m[3]);
      }
      const ink = modalColor(pixels, g.x - 2, g.y - g.fontPx, boxW + 4, g.fontPx * 1.25, canvas.height, bgKey);
      t.ink = ink || '#111111';
    }

    // erase original text
    for (const t of painted) {
      const g = itemGeom(t.item, viewport);
      ctx.save();
      ctx.fillStyle = t.bg;
      ctx.fillRect(g.x - 2, g.y - g.fontPx, t.item.width * viewport.scale + 4, g.fontPx * 1.3);
      ctx.restore();
    }

    // draw transformed text in the original font, fitted to the original run width
    for (const t of painted) {
      const g = itemGeom(t.item, viewport);
      const family = t.font ? `${t.font.family}, ${genericChain}` : genericChain;
      const target = t.item.width * viewport.scale;
      ctx.font = `${g.fontPx}px ${family}`;
      let natural = ctx.measureText(t.text).width;
      let sizeMul = 1;
      if (natural > 0.5 && target > 0.5) {
        const ratio = target / natural;
        if (ratio < SQUASH_LIMIT) sizeMul = Math.max(MIN_SIZE_MUL, ratio / SQUASH_LIMIT);
      }
      if (sizeMul !== 1) {
        ctx.font = `${g.fontPx * sizeMul}px ${family}`;
        natural = ctx.measureText(t.text).width;
      }
      let sx = 1;
      if (natural > 0.5 && target > 0.5) sx = Math.min(MAX_FIT, Math.max(MIN_FIT, target / natural));
      ctx.save();
      ctx.fillStyle = t.ink;
      ctx.translate(g.x, g.y);
      if (g.angle) ctx.rotate(g.angle);
      if (Math.abs(sx - 1) > 0.005) ctx.scale(sx, 1);
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }

    const pageSize = page.getViewport({ scale: 1 });
    const imgPage = out.addPage([pageSize.width, pageSize.height]);
    const img = await out.embedPng(canvas.toBuffer('image/png'));
    imgPage.drawImage(img, { x: 0, y: 0, width: pageSize.width, height: pageSize.height });

    for (const t of transformed) {
      drawHiddenText(
        imgPage,
        t.payload,
        t.item.transform[4],
        t.item.transform[5],
        runFontSize(t.item),
        layerFont,
        pageSize.width,
        t.item.width
      );
    }
  }

  out.getInfoDict().set(PDFName.of(LAYER_FLAG), PDFString.of(mode === 'plain' ? 'plain' : 'cipher'));
  if (layerFonts.length) out.getInfoDict().set(PDFName.of(LAYER_FONTS), PDFString.of(layerFonts.join('|')));
  // ( ) \ / { } [ ] share four codes, so the note is carried into the plain output as well;
  // without it a slash would come back as a backslash on the next pass.
  if (ambKey && !ambCollected) ambCollected = ambKey;
  if (ambCollected) out.getInfoDict().set(PDFName.of(LAYER_AMBIG), PDFString.of(ambCollected));
  if (caseCollected) out.getInfoDict().set(PDFName.of(LAYER_CASE), PDFString.of(caseCollected));
  if (widthCollected) out.getInfoDict().set(PDFName.of(LAYER_WIDTH), PDFString.of(widthCollected));
  return { buffer: Buffer.from(await out.save()), text: collected.join('\n') };
}

// ---------- docx helpers ----------

const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const unescapeXml = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = s => s.replace(/[&<>"']/g, c => XML_ESCAPE[c]);

async function processDocx(buffer, transformText) {
  const zip = await JSZip.loadAsync(buffer);
  const targets = Object.keys(zip.files).filter(f =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(f));
  for (const f of targets) {
    const xml = await zip.files[f].async('string');
    const updated = xml.replace(/<w:t([^>]*)>([\s\S]*?)<\/w:t>/g, (m, attrs, content) =>
      `<w:t${attrs}>${escapeXml(transformText(unescapeXml(content)))}</w:t>`);
    zip.file(f, updated);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function extractDocxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.files['word/document.xml'];
  if (!doc) return '';
  const xml = await doc.async('string');
  return unescapeXml(xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));
}

// ---------- routes ----------

app.get('/', (req, res) => res.render('index'));

app.post('/api/process', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const action = req.body.action;
    if (action !== 'encrypt' && action !== 'decrypt')
      return res.status(400).json({ error: 'Unknown action' });

    const name = req.file.originalname;
    const buf = req.file.buffer;
    const head = buf.slice(0, 4).toString('latin1');
    const ext = path.extname(name).toLowerCase();
    const transform = action === 'encrypt' ? encryptText : decryptText;
  // Plain text and docx have nowhere to keep the letter notes, so those go through the
  // cipher without them and small letters come back as big ones.

    let outBuffer, downloadName, preview = '';

    if (head.startsWith('%PDF') || ext === '.pdf') {
      const r = await rewritePdf(buf, transform, action === 'encrypt' ? 'cipher' : 'plain');
      outBuffer = r.buffer;
      preview = r.text.slice(0, 1000);
    } else if (head.startsWith('PK') || ext === '.docx') {
      outBuffer = await processDocx(buf, transform);
      const plain = await extractDocxText(outBuffer);
      preview = plain.slice(0, 1000);
    } else {
      const text = buf.toString('utf8');
      const out = transform(text);
      outBuffer = Buffer.from(out, 'utf8');
      preview = out.slice(0, 1000);
    }

    const parsed = path.parse(name);
    downloadName = action === 'encrypt'
      ? `${parsed.name}_encrypted${parsed.ext}`
      : (name.toLowerCase().endsWith('.enc')
          ? name.slice(0, -4)
          : (/^(.*)_encrypted(\.[^.]+)$/i.test(name)
              ? name.replace(/^(.*)_encrypted(\.[^.]+)$/i, '$1$2')
              : `${parsed.name}_decrypted${parsed.ext}`));

    res.json({ filename: downloadName, preview, content: outBuffer.toString('base64') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(3000, () => console.log('Encryptor System running at http://localhost:3000'));
}

module.exports = {
  encryptText, decryptText, escapeLayer, unescapeLayer, stripLayerEscapes, stripLayerTags,
  rewritePdf, genericFonts, resolveItemFont, readFontNames, readLayerFlag, readLayerFonts, getPdfDoc, getItems, itemGeom, renderPage,
  readLayerAmb, ambiguousKey, applyAmbiguousKey,
  letterCaseNote, letterWidthNote,
  readLayerNote,
  RENDER_SCALE, MIN_FIT, MAX_FIT, WIDTH_TOLERANCE,
};
