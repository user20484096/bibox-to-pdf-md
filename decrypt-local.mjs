#!/usr/bin/env node
/**
 * Decrypt BiBox 2.0 offline-synced files and create searchable PDFs.
 *
 * Reads the Chrome IndexedDB blob to extract the page-to-hash mapping,
 * decrypts each page image (AES-256-CTR), embeds invisible text overlay
 * from BiBox pageData (with full Unicode support), and combines them
 * into a searchable PDF.
 *
 * Usage: node decrypt-local.mjs [--output <dir>] [--no-text] [--debug-text]
 *                                [--save-images]
 */

import { createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// -- BiBox AES-256-CTR constants (hardcoded in the Electron app) --
const KEY = Buffer.from("helloWorldhelloWorldhelloWorld32");
const IV = Buffer.from("1234567890ab1234567890ab00000000", "hex");

function decrypt(buf) {
  const d = createDecipheriv("aes-256-ctr", KEY, IV);
  return Buffer.concat([d.update(buf), d.final()]);
}

// -- Path helpers --
function hashToFilePath(syncDir, hash) {
  return join(syncDir, hash.slice(0, 3), hash.slice(3, 6), hash.slice(6, 9), hash);
}

// -- Extract page mapping from Chrome IndexedDB blob --
function extractPageMapping(blobPath) {
  const buf = readFileSync(blobPath);
  const text = buf.toString("latin1");

  const urlRe =
    /https:\/\/static\.bibox2\.westermann\.de\/bookpages\/[A-Za-z0-9+/=]+\/(\d+)\.png/g;
  const urls = [];
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    urls.push({ pos: m.index, end: m.index + m[0].length, page: parseInt(m[1]) });
  }

  const md5Re = /[0-9a-f]{32}/g;
  const hashes = [];
  while ((m = md5Re.exec(text)) !== null) {
    hashes.push({ pos: m.index, hash: m[0] });
  }

  const pairs = [];
  for (const u of urls) {
    const next = hashes.find((h) => h.pos > u.end && h.pos < u.end + 400);
    if (next) pairs.push({ page: u.page, hash: next.hash, pos: u.pos });
  }

  const byPage = {};
  for (const p of pairs) {
    (byPage[p.page] ??= []).push(p);
  }

  const pages = [];
  const maxPage = Math.max(...Object.keys(byPage).map(Number));
  for (let i = 1; i <= maxPage; i++) {
    const entries = byPage[i];
    if (!entries) continue;
    entries.sort((a, b) => a.pos - b.pos);
    pages.push({ page: i, hash: entries.length >= 2 ? entries[1].hash : entries[0].hash });
  }

  return pages;
}

// -- Extract book titles from LevelDB --
// Searches for the serialized record pattern: "\x02idI<varint>..."\x05title"<varint_len><title>...pagenumI"
// The pagenumI field distinguishes book metadata from material/license records.
function extractBookTitles(ldbDir) {
  const titles = {};
  const titleMarker = Buffer.from([0x22, 0x05, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x22]); // "\x05title"
  const idMarker = Buffer.from([0x22, 0x02, 0x69, 0x64, 0x49]);                       // "\x02idI"

  for (const f of readdirSync(ldbDir)) {
    if (!f.endsWith(".ldb") && !f.endsWith(".log")) continue;
    const buf = readFileSync(join(ldbDir, f));

    let idx = 0;
    while (true) {
      idx = buf.indexOf(titleMarker, idx);
      if (idx === -1) break;

      // Read varint length + title string after the marker
      const titleStart = idx + titleMarker.length;
      const { value: titleLen, end: strStart } = readVarint(buf, titleStart);
      if (titleLen <= 0 || titleLen > 200 || strStart + titleLen > buf.length) { idx += 8; continue; }
      const title = buf.subarray(strStart, strStart + titleLen).toString("utf8");

      // Confirm this is a book record: pagenumI must follow within 200 bytes
      const afterTitle = buf.subarray(strStart + titleLen, Math.min(buf.length, strStart + titleLen + 200));
      if (afterTitle.indexOf("pagenumI") === -1) { idx += 8; continue; }

      // Search backwards for idI to get the book ID
      const before = buf.subarray(Math.max(0, idx - 200), idx);
      const idPos = before.lastIndexOf(idMarker);
      if (idPos === -1) { idx += 8; continue; }
      const bookId = decodeVarint(before, idPos + idMarker.length);
      if (bookId > 0 && title.length > 1) titles[bookId] ??= title;

      idx = strStart + titleLen;
    }
  }
  return titles;
}

// -- Read a varint from buffer, return { value, end } --
function readVarint(buf, pos) {
  let result = 0, shift = 0, byte;
  do { byte = buf[pos++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte >= 128 && pos < buf.length);
  return { value: result, end: pos };
}

// -- Decode a protobuf-style varint (zigzag-encoded) from buffer at offset --
function decodeVarint(buf, pos) {
  let result = 0, shift = 0, byte;
  do { byte = buf[pos++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte >= 128);
  return (result >>> 1) ^ -(result & 1);
}

// -- Extract book ID from blob --
function extractBookId(blobPath) {
  const buf = readFileSync(blobPath);
  const pos = buf.indexOf("bookIdI");
  if (pos === -1) return null;
  return decodeVarint(buf, pos + 7);
}

// -- Find all blob files that contain bookRedaData --
function findBlobFiles(idbBlobDir) {
  const blobs = [];
  if (!existsSync(idbBlobDir)) return blobs;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          const buf = readFileSync(full);
          const text = buf.toString("latin1");
          if (text.includes("bookIdI") && text.includes("static.bibox2.westermann.de")) {
            blobs.push(full);
          }
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(idbBlobDir);
  return blobs;
}

// -- Find and decrypt all pageData JSONs for text overlay --
// Returns array of pageData maps (one per book).
function findAllPageData(syncDir, ldbDir) {
  const hashRe = /pageDataHash.{1,5}([0-9a-f]{32})/g;
  const candidates = new Set();

  for (const f of readdirSync(ldbDir)) {
    if (!f.endsWith(".ldb") && !f.endsWith(".log")) continue;
    const buf = readFileSync(join(ldbDir, f));
    const text = buf.toString("latin1");
    let m;
    while ((m = hashRe.exec(text)) !== null) {
      candidates.add(m[1]);
    }
  }

  const results = [];
  for (const hash of candidates) {
    const filePath = hashToFilePath(syncDir, hash);
    if (!existsSync(filePath)) continue;

    try {
      const dec = decrypt(readFileSync(filePath));
      const text = dec.toString("utf8");
      if (!text.startsWith("{")) continue;
      const data = JSON.parse(text);
      const keys = Object.keys(data);
      if (keys.length > 0 && data[keys[0]] && "txt" in data[keys[0]]) {
        results.push(data);
      }
    } catch { /* not valid page data */ }
  }

  return results;
}

// -- Extract supplemental material references from blob --
function extractMaterials(blobBuf) {
  const titleKey = Buffer.from([0x22, 0x05, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x22]); // "title"
  const fileKey = Buffer.from([0x22, 0x04, 0x66, 0x69, 0x6c, 0x65, 0x22]);         // "file"
  // md5sum field: UTF-16LE key "md5sum" with type marker 0x63, length 0x0c
  const md5Key = Buffer.from([0x63, 0x0c, 0x6d, 0x00, 0x64, 0x00, 0x35, 0x00, 0x73, 0x00, 0x75, 0x00, 0x6d, 0x00]);

  if (blobBuf.indexOf("materialsA") === -1) return [];

  function readLenStr(pos) {
    let len = 0, shift = 0, byte;
    do { byte = blobBuf[pos++]; len |= (byte & 0x7f) << shift; shift += 7; } while (byte >= 128);
    return { str: blobBuf.subarray(pos, pos + len).toString("latin1"), end: pos + len };
  }

  const materials = [];
  let pos = blobBuf.indexOf("materialsA");
  while (true) {
    pos = blobBuf.indexOf(titleKey, pos);
    if (pos === -1) break;
    const t = readLenStr(pos + titleKey.length);
    const fPos = blobBuf.indexOf(fileKey, t.end);
    if (fPos === -1 || fPos > t.end + 200) { pos = t.end; continue; }
    const f = readLenStr(fPos + fileKey.length);
    const ext = f.str.includes(".") ? f.str.split(".").pop() : "";

    // Extract md5sum hash (within 4000 bytes after file field — keywords can be very long)
    let md5sum = null;
    const mPos = blobBuf.indexOf(md5Key, f.end);
    if (mPos !== -1 && mPos < f.end + 4000) {
      const hashStart = mPos + md5Key.length + 2; // skip 0x22 0x20
      md5sum = blobBuf.subarray(hashStart, hashStart + 32).toString("ascii");
      if (!/^[0-9a-f]{32}$/.test(md5sum)) md5sum = null;
    }

    materials.push({ title: t.str, file: f.str, ext, md5sum });
    pos = f.end;
  }
  return materials;
}

// -- Group page text into word segments with bounding boxes --
// cds format per character: [x1, x2, y1, y2] in units of 1/1000 of page percentage
// Handles line-broken words (e.g. "zugelas-\nsenen") where characters within one
// "word" (no space) jump to a new line. These are split into separate segments.
function extractWords(txt, cds) {
  if (!txt || !cds || cds.length === 0) return [];

  const words = [];

  function pushSegment(text, startIdx, endIdx) {
    const fc = cds[startIdx];
    const lc = cds[endIdx];
    if (!fc || !lc || (fc[0] === 0 && fc[2] === 0)) return;
    const w = (lc[1] - fc[0]) / 1000;
    if (w <= 0) return;
    words.push({
      text,
      x: fc[0] / 1000,
      w,
      y: fc[2] / 1000,
      h: (fc[3] - fc[2]) / 1000,
    });
  }

  let segStart = -1;
  let segChars = "";

  for (let i = 0; i <= txt.length; i++) {
    const ch = i < txt.length ? txt[i] : " ";
    const isSpace = ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

    if (isSpace) {
      if (segStart !== -1 && segChars) pushSegment(segChars, segStart, i - 1);
      segStart = -1;
      segChars = "";
      continue;
    }

    if (segStart === -1) {
      segStart = i;
      segChars = ch;
    } else {
      // Check if this character jumped to a new line (y changed significantly)
      const prevCoord = cds[i - 1];
      const curCoord = cds[i];
      if (prevCoord && curCoord && prevCoord[2] !== 0 && curCoord[2] !== 0 &&
          Math.abs(curCoord[2] - prevCoord[2]) > 500) {
        // Line break within word — flush previous segment
        if (segChars) pushSegment(segChars, segStart, i - 1);
        segStart = i;
        segChars = ch;
      } else {
        segChars += ch;
      }
    }
  }

  return words;
}

// -- Reconstruct structured text from BiBox txt + cds data --
// Groups characters into lines based on y-coordinate, detects paragraph breaks
// from y-gaps, headings from character height, and list items from patterns.
// Layout info: x-position for indentation, height tiers for heading levels.
function formatPageText(txt, cds, { markdown = false } = {}) {
  if (!txt || !cds || cds.length === 0) return "";

  // Build lines: group characters by y-coordinate, track x-position and height
  const lines = [];
  let lineChars = "";
  let lineY = -1;
  let lineH = 0;
  let lineX = 99999;
  let charCount = 0;
  let heightSum = 0;

  for (let i = 0; i < txt.length; i++) {
    const c = cds[i];
    if (!c || (c[0] === 0 && c[2] === 0)) {
      lineChars += txt[i];
      continue;
    }

    const y = c[2];
    const h = c[3] - c[2];
    const x = c[0];

    if (lineY === -1) {
      lineY = y;
      lineH = h;
      lineX = x;
      lineChars += txt[i];
      heightSum += h;
      charCount++;
    } else if (Math.abs(y - lineY) > 200) {
      const gap = y - lineY;
      lines.push({ text: lineChars.trim(), y: lineY, h: lineH, x: lineX, gapAfter: gap });
      lineChars = txt[i];
      lineY = y;
      lineH = h;
      lineX = x;
      heightSum += h;
      charCount++;
    } else {
      if (x < lineX) lineX = x;
      lineChars += txt[i];
      heightSum += h;
      charCount++;
    }
  }
  if (lineChars.trim()) {
    lines.push({ text: lineChars.trim(), y: lineY, h: lineH, x: lineX, gapAfter: 0 });
  }

  if (lines.length === 0) return "";

  const bodyH = charCount > 0 ? Math.round(heightSum / charCount) : 1452;
  const paraGapThreshold = bodyH * 2;

  // Merge continuation lines: join lines where a word was broken at line end
  // e.g. "Gleichungs" + "systeme" -> "Gleichungssysteme"
  // or "Graphen linearer Funktionen" + "mit DGS 35" (same indent, no para break)
  for (let i = lines.length - 1; i > 0; i--) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (!prev.text || !cur.text) continue;
    // Don't merge across paragraph breaks
    if (prev.gapAfter > paraGapThreshold) continue;
    // Don't merge different text sizes (heading + body)
    if (Math.abs(prev.h - cur.h) > 200) continue;
    // Detect word continuation: previous line ends with letter, next starts with letter
    const endsWithLetter = /[a-zäöüß]$/i.test(prev.text);
    const startsWithLower = /^[a-zäöüß]/.test(cur.text);
    if (endsWithLetter && startsWithLower) {
      // Join continuation lines with space
      prev.text = prev.text + " " + cur.text;
      prev.gapAfter = cur.gapAfter;
      lines.splice(i, 1);
    }
  }

  // Build output
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.text) continue;

    const isParagraphBreak = i > 0 && lines[i - 1].gapAfter > paraGapThreshold;
    if (isParagraphBreak && parts.length > 0) {
      parts.push("");
    }

    const cleaned = cleanText(line.text);
    if (!cleaned) continue;

    if (!markdown) {
      parts.push(cleaned);
      continue;
    }

    // List detection first (before heading check, since bullet chars can be large)
    // » bullets: the marker is often alone on its line, text follows on next line(s)
    if (/^[»›]\s*$/.test(cleaned)) {
      // Bare bullet marker — merge with following line(s)
      let bulletText = "";
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next.text) { i++; continue; }
        const nextCleaned = cleanText(next.text);
        if (!nextCleaned) { i++; continue; }
        // Stop merging at next heading, bullet, or paragraph break
        if (/^[»›•·]/.test(nextCleaned) || next.h > bodyH * 1.35) break;
        if (next.gapAfter > paraGapThreshold) { bulletText += (bulletText ? " " : "") + nextCleaned; i++; break; }
        bulletText += (bulletText ? " " : "") + nextCleaned;
        i++;
      }
      if (bulletText) parts.push(`- ${bulletText}`);
      continue;
    }
    if (/^[»›]\s+/.test(cleaned)) {
      parts.push(`- ${cleaned.replace(/^[»›]\s*/, "")}`);
      continue;
    }
    if (/^[•·]\s*/.test(cleaned)) {
      parts.push(`- ${cleaned.replace(/^[•·]\s*/, "")}`);
      continue;
    }
    if (/^[a-z]\)\s/.test(cleaned)) {
      parts.push(`  - ${cleaned}`);
      continue;
    }
    if (/^\(\s*\d+\s*\)\s/.test(cleaned)) {
      parts.push(`    - ${cleaned}`);
      continue;
    }

    // Heading detection by character height tiers
    // Skip standalone page numbers (1-3 digits displayed on book page)
    if (/^\d{1,3}$/.test(cleaned)) continue;

    if (line.h > bodyH * 1.7) {
      parts.push(`## ${cleaned}`);
      continue;
    }
    if (line.h > bodyH * 1.35) {
      parts.push(`### ${cleaned}`);
      continue;
    }
    if (line.h > bodyH * 1.2) {
      parts.push(`#### ${cleaned}`);
      continue;
    }

    // TOC-like entry: text ending with page number → format as list item
    const tocMatch = cleaned.match(/^(.+?)\s+(\d{1,3})$/);
    if (tocMatch && cleaned.length < 80) {
      parts.push(`- ${tocMatch[1]} — ${tocMatch[2]}`);
      continue;
    }

    parts.push(cleaned);
  }

  return parts.join("\n");
}

// -- Clean up BiBox OCR text artifacts --
// BiBox stores text with spaces before punctuation (e.g. "Prof . Dr .")
function cleanText(text) {
  return text
    .replace(/ \. /g, ". ")      // "Prof . Dr ." -> "Prof. Dr."
    .replace(/ \./g, ".")         // trailing " ."
    .replace(/ ,/g, ",")          // " ," -> ","
    .replace(/ ;/g, ";")
    .replace(/ :/g, ":")
    .replace(/ \?/g, "?")
    .replace(/ !/g, "!")
    .replace(/ \)/g, ")")
    .replace(/\( /g, "(")
    .replace(/\. -/g, ".-")      // "Best. -Nr." -> "Best.-Nr."
    .replace(/:\/\/ /g, "://")   // "https:// " -> "https://"
    .replace(/www\. /g, "www.")  // "www. " -> "www."
    .replace(/\. de\b/g, ".de")  // "schroedel. de" -> "schroedel.de"
    .replace(/\. com\b/g, ".com")
    .replace(/\. org\b/g, ".org")
    .replace(/\. net\b/g, ".net")
    .replace(/ +/g, " ")          // collapse multiple spaces
    .trim();
}

// -- Find LibreOffice soffice binary --
let _soffice = undefined;
function findSoffice() {
  if (_soffice !== undefined) return _soffice;
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"]
    : process.platform === "darwin"
      ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
      : ["/usr/bin/soffice"];
  for (const p of candidates) {
    if (existsSync(p)) { _soffice = p; return p; }
  }
  // Try PATH
  try { execSync("soffice --version", { stdio: "ignore", timeout: 5000 }); _soffice = "soffice"; return "soffice"; }
  catch { _soffice = null; return null; }
}

// -- Convert file to text via LibreOffice headless --
function sofficeToText(tmpPath, tmpDir) {
  const soffice = findSoffice();
  if (!soffice) return null;
  try {
    execSync(`${JSON.stringify(soffice)} --headless --convert-to txt:Text --outdir ${JSON.stringify(tmpDir)} ${JSON.stringify(tmpPath)}`, { stdio: "ignore", timeout: 30000 });
    const txtPath = tmpPath.replace(/\.[^.]+$/, ".txt");
    if (existsSync(txtPath)) {
      const text = readFileSync(txtPath, "utf8");
      try { unlinkSync(txtPath); } catch {}
      return text;
    }
  } catch {}
  return null;
}

// -- Extract text from a decrypted buffer --
// Tries native tools first (textutil on macOS, pdftotext), falls back to LibreOffice.
function bufferToText(buf, ext, tmpDir) {
  const tmpPath = join(tmpDir, `_convert.${ext}`);
  try {
    writeFileSync(tmpPath, buf);
    if (["doc", "docx", "rtf"].includes(ext)) {
      if (process.platform === "darwin") {
        try { return execSync(`textutil -convert txt -stdout ${JSON.stringify(tmpPath)}`, { encoding: "utf8", timeout: 10000 }); }
        catch {}
      }
      return sofficeToText(tmpPath, tmpDir);
    }
    if (ext === "pdf") {
      try { return execSync(`pdftotext -layout ${JSON.stringify(tmpPath)} -`, { encoding: "utf8", timeout: 10000 }); }
      catch {}
      return sofficeToText(tmpPath, tmpDir);
    }
  } catch { return null; }
  finally { try { unlinkSync(tmpPath); } catch {} }
  return null;
}

// -- Convert a decrypted material file to markdown --
function convertToMarkdown(buf, fileName, outDir) {
  const ext = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
  const text = bufferToText(buf, ext, outDir);
  if (!text) return false;
  const mdName = fileName.replace(/\.[^.]+$/, ".md");
  writeFileSync(join(outDir, mdName), text, "utf8");
  return true;
}


// -- Find a Unicode TTF font on the system --
function findUnicodeFont() {
  const winFonts = "C:\\Windows\\Fonts";
  const candidates = process.platform === "win32"
    ? [
        join(winFonts, "arialuni.ttf"),
        join(winFonts, "arial.ttf"),
        join(winFonts, "segoeui.ttf"),
      ]
    : [
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// -- Main --
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const noText = args.includes("--no-text");
  const debugText = args.includes("--debug-text");
  const saveImages = args.includes("--save-images");
  const saveMaterials = args.includes("--materials");
  const saveMaterialsMd = args.includes("--materials-markdown");
  const bookFilter = args.includes("--book")
    ? parseInt(args[args.indexOf("--book") + 1])
    : null;
  const outputDir = args.includes("--output")
    ? resolve(args[args.indexOf("--output") + 1])
    : join(process.cwd(), "books");

  const biboxDataDir = process.platform === "win32"
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "BiBox 2.0")
    : join(homedir(), "Library", "Application Support", "BiBox 2.0");
  const syncDir = join(biboxDataDir, "synchronizedFiles");
  const idbBlobDir = join(biboxDataDir, "IndexedDB", "app_angular_0.indexeddb.blob");
  const ldbDir = join(biboxDataDir, "IndexedDB", "app_angular_0.indexeddb.leveldb");

  if (!existsSync(syncDir)) {
    console.error("BiBox synchronizedFiles not found at:", syncDir);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  const blobFiles = findBlobFiles(idbBlobDir);
  if (blobFiles.length === 0) {
    console.error("No IndexedDB blobs with book data found.");
    process.exit(1);
  }

  // Load all page text data (always, for text/markdown export; --no-text only skips PDF overlay)
  console.log("Loading page text data...");
  const allPageData = findAllPageData(syncDir, ldbDir);
  if (allPageData.length > 0) {
    for (const pd of allPageData) {
      const ids = Object.keys(pd);
      const withText = ids.filter((id) => pd[id].txt?.length > 0).length;
      console.log(`  Found text data: ${withText}/${ids.length} pages.`);
    }
  } else {
    console.log("  No page text data found. PDF will not be searchable.");
  }

  // Find Unicode font (only needed for PDF text overlay)
  let fontPath = null;
  if (!noText && allPageData.length > 0) {
    fontPath = findUnicodeFont();
    if (fontPath) {
      console.log(`  Using font: ${fontPath}`);
    } else {
      console.log("  Warning: No Unicode font found. Some characters may be missing.");
    }
  }

  // Extract book titles
  const bookTitles = extractBookTitles(ldbDir);

  console.log(`\nGefundene Bücher:`);
  for (const blobPath of blobFiles) {
    const id = extractBookId(blobPath);
    const title = bookTitles[id] || `Book ${id}`;
    console.log(`  ${title} (ID ${id})`);
  }

  for (const blobPath of blobFiles) {
    const bookId = extractBookId(blobPath);

    if (bookFilter && bookId !== bookFilter) continue;

    const bookTitle = bookTitles[bookId];
    const bookLabel = bookTitle ? `${bookTitle} (${bookId})` : `Book ${bookId}`;
    const pages = extractPageMapping(blobPath);

    if (pages.length === 0) {
      console.log(`\n${bookLabel}: keine Seiten gefunden, überspringe.`);
      continue;
    }

    const existing = pages.filter((p) => existsSync(hashToFilePath(syncDir, p.hash)));
    console.log(`\n${bookLabel}: ${pages.length} Seiten, ${existing.length} lokal verfügbar`);

    if (existing.length === 0) {
      console.log("  Keine lokalen Dateien, überspringe.");
      continue;
    }

    // Match pageData to this book by page count (closest match)
    let pageDataMap = null;
    let sortedPageIds = null;
    if (allPageData.length > 0) {
      pageDataMap = allPageData.find((pd) => Object.keys(pd).length === pages.length)
        || allPageData.reduce((best, pd) =>
          Math.abs(Object.keys(pd).length - pages.length) < Math.abs(Object.keys(best).length - pages.length) ? pd : best
        );
      sortedPageIds = Object.keys(pageDataMap).map(Number).sort((a, b) => a - b);
      // Only use if page count is close enough (within 20%)
      if (Math.abs(sortedPageIds.length - pages.length) > pages.length * 0.2) {
        pageDataMap = null;
        sortedPageIds = null;
      }
    }

    // Output directory for this book
    const baseName = bookTitle
      ? bookTitle.replace(/[\/\\:*?"<>|]/g, "-")
      : `book-${bookId}`;
    const dirName = bookTitle ? `${baseName} (${bookId})` : baseName;
    const bookDir = join(outputDir, dirName);
    const pdfPath = join(bookDir, `${baseName}.pdf`);

    if (!force && existsSync(pdfPath)) {
      console.log(`  Bereits vorhanden, überspringe. (--force zum Überschreiben)`);
      continue;
    }

    mkdirSync(bookDir, { recursive: true });

    // Build PDF
    const pdf = await PDFDocument.create();

    // Embed Unicode font via fontkit (only for text overlay)
    let font;
    if (!noText) {
      if (fontPath) {
        pdf.registerFontkit(fontkit);
        const fontBytes = readFileSync(fontPath);
        font = await pdf.embedFont(fontBytes, { subset: false });
      } else {
        font = await pdf.embedFont(StandardFonts.Helvetica);
      }
    }

    console.log(`  PDF erstellen${noText ? " (nur Bilder)" : " (mit Text-Overlay)"}...`);
    let count = 0;

    for (const { page, hash } of pages) {
      const filePath = hashToFilePath(syncDir, hash);
      if (!existsSync(filePath)) {
        console.log(`  Page ${page}: file missing, skipping.`);
        continue;
      }

      const encrypted = readFileSync(filePath);
      const decrypted = decrypt(encrypted);

      let ext;
      if (decrypted[0] === 0xff && decrypted[1] === 0xd8) ext = "jpg";
      else if (decrypted[0] === 0x89 && decrypted[1] === 0x50) ext = "png";
      else {
        console.log(`  Page ${page}: unknown image format, skipping.`);
        continue;
      }

      // Save individual page image
      if (saveImages) {
        const imgDir = join(bookDir, "images");
        mkdirSync(imgDir, { recursive: true });
        writeFileSync(join(imgDir, `page-${String(page).padStart(4, "0")}.${ext}`), decrypted);
      }

      let image;
      try {
        image = ext === "jpg" ? await pdf.embedJpg(decrypted) : await pdf.embedPng(decrypted);
      } catch (err) {
        console.log(`  Page ${page}: failed to embed image: ${err.message}`);
        continue;
      }

      const { width, height } = image;
      const pdfPage = pdf.addPage([width, height]);
      pdfPage.drawImage(image, { x: 0, y: 0, width, height });

      // Add text overlay for searchability and copy/paste
      if (!noText && font && sortedPageIds && page >= 1 && page <= sortedPageIds.length) {
        const pageId = sortedPageIds[page - 1];
        const pd = pageDataMap[pageId];
        if (pd?.txt && pd?.cds) {
          const words = extractWords(pd.txt, pd.cds);
          for (const w of words) {
            const x = (w.x / 100) * width;
            const y = height - ((w.y / 100) * height) - ((w.h / 100) * height);
            const targetW = (w.w / 100) * width;

            let widthAt1;
            try { widthAt1 = font.widthOfTextAtSize(w.text, 1); }
            catch { continue; }
            if (widthAt1 <= 0) continue;
            const fontSize = Math.min(targetW / widthAt1, (w.h / 100) * height);
            if (fontSize < 0.5) continue;

            try {
              pdfPage.drawText(w.text, {
                x, y, size: fontSize, font,
                color: debugText ? rgb(1, 0, 0) : rgb(0, 0, 0),
                opacity: debugText ? 0.5 : 0,
              });
            } catch { /* skip unencodable chars */ }
          }
        }
      }

      count++;
      if (count % 50 === 0) process.stdout.write(`  ${count}/${existing.length} Seiten...\r`);
    }

    process.stdout.write(`  PDF speichern...`);
    const pdfBytes = await pdf.save();
    const outPath = join(bookDir, `${baseName}.pdf`);
    writeFileSync(outPath, pdfBytes);
    console.log(` ${count} Seiten, ${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB -> ${outPath}`);

    // Export text and markdown
    if (sortedPageIds && pageDataMap) {
      console.log("  Text und Markdown exportieren...");
      let plainText = "";
      let markdown = "";

      for (const { page } of pages) {
        const pageId = (page >= 1 && page <= sortedPageIds.length) ? sortedPageIds[page - 1] : null;
        const pd = pageId != null ? pageDataMap[pageId] : null;

        plainText += `${pd?.txt || ""}\n\n`;
        markdown += `${pd?.txt ? formatPageText(pd.txt, pd.cds, { markdown: true }) : ""}\n\n`;
      }

      const txtPath = join(bookDir, `${baseName}.txt`);
      const mdPath = join(bookDir, `${baseName}.md`);
      writeFileSync(txtPath, plainText, "utf8");
      writeFileSync(mdPath, markdown, "utf8");
      console.log(`  -> ${txtPath}`);
      console.log(`  -> ${mdPath}`);
    }

    // Export supplemental material reference
    console.log("  Zusatzmaterial-Referenz erstellen...");
    const blobBuf = readFileSync(blobPath);
    const materials = extractMaterials(blobBuf);
    if (materials.length > 0) {
      const unique = [...new Map(materials.map((m) => [m.title + m.file, m])).values()];
      const byExt = {};
      for (const m of unique) (byExt[m.ext] ??= []).push(m);

      let md = `# Zusatzmaterial — ${bookTitle || `Book ${bookId}`}\n\n`;
      md += `Insgesamt ${unique.length} Dateien.\n\n`;
      for (const [ext, items] of Object.entries(byExt).sort()) {
        md += `## ${ext.toUpperCase()} (${items.length})\n\n`;
        for (const m of items) md += `- ${m.title} — \`${m.file}\`\n`;
        md += "\n";
      }

      const matPath = join(bookDir, "Zusatzmaterial.md");
      writeFileSync(matPath, md, "utf8");
      console.log(`  -> ${matPath} (${unique.length} Einträge)`);

      // Download and/or convert materials
      if ((saveMaterials || saveMaterialsMd) && unique.some((m) => m.md5sum)) {
        const matDir = join(bookDir, "Zusatzmaterial");
        mkdirSync(matDir, { recursive: true });
        let saved = 0, converted = 0, skipped = 0;

        for (const m of unique) {
          if (!m.md5sum) { skipped++; continue; }
          const filePath = hashToFilePath(syncDir, m.md5sum);
          if (!existsSync(filePath)) { skipped++; continue; }

          const decrypted = decrypt(readFileSync(filePath));
          const outName = m.file.replace(/[\/\\:*?"<>|]/g, "-");

          if (saveMaterials) {
            writeFileSync(join(matDir, outName), decrypted);
            saved++;
          }

          if (saveMaterialsMd) {
            const mdOut = convertToMarkdown(decrypted, outName, matDir);
            if (mdOut) converted++;
          }
        }

        if (saveMaterials) console.log(`  Materialien gespeichert: ${saved} Dateien -> ${matDir}`);
        if (saveMaterialsMd) console.log(`  Materialien konvertiert: ${converted} Markdown-Dateien -> ${matDir}`);
        if (skipped > 0) console.log(`  ${skipped} Materialien übersprungen (kein Hash oder nicht lokal)`);
      }
    } else {
      console.log("  Kein Zusatzmaterial gefunden.");
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
