// session.js — shared helpers for the Genetic Color Grading CLI scripts.
// Loads the image + engine, renders genomes, builds contact sheets and
// .cube text. No DOM, no network, stdlib only.
'use strict';
const fs = require('fs');
const path = require('path');
const eng = require('./engine.js');
const { decodePNG, encodePNG } = require('./png.js');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) out[key.slice(0, eq)] = key.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function resolveLutsDir(opts) {
  if (opts.luts) return path.resolve(opts.luts);
  if (process.env.GCG_LUTS_DIR) return path.resolve(process.env.GCG_LUTS_DIR);
  return path.join(__dirname, '..', 'luts');
}

function loadImageAndEngine(opts) {
  // opts: {image, luts, grid, safe, tree, dither, mutation, decay}
  if (!opts.image) throw new Error('missing --image <file.png>');
  const imgPath = path.resolve(opts.image);
  if (!fs.existsSync(imgPath)) throw new Error('image not found: ' + imgPath);
  const ext = path.extname(imgPath).toLowerCase();
  if (ext !== '.png') {
    throw new Error('only PNG input is supported in v1 (got ' + ext + ') — convert to PNG first, e.g. with any image editor or `ffmpeg -i in.jpg out.png`');
  }
  const img = decodePNG(fs.readFileSync(imgPath));
  const lutsDir = resolveLutsDir(opts);
  if (!fs.existsSync(path.join(lutsDir, 'luts-part-000.bin')) && !fs.existsSync(path.join(lutsDir, 'luts.bin'))) {
    throw new Error('LUT data not found in ' + lutsDir + ' — run `node setup-luts.js` first (downloads the v0.1.0 LUT zip; see README.md)');
  }
  const lutInfo = eng.loadLutsFromParts(lutsDir);
  eng.__setSourceImage(img.data, img.width, img.height);
  eng.__resetSessionState();
  if (opts.grid) eng.setGridSize(parseInt(opts.grid, 10));
  if (opts.safe !== undefined) eng.__setSafeOn(opts.safe === true || opts.safe === 'true' || opts.safe === '1');
  if (opts.tree !== undefined) eng.__setTreeOn(opts.tree === true || opts.tree === 'true' || opts.tree === '1');
  if (opts.dither) eng.__setDither(eng.__ditherDesc(opts.dither));
  if (opts.mutation !== undefined) eng.setMutationPct(parseInt(opts.mutation, 10));
  if (opts.decay !== undefined) eng.setDecayPct(parseInt(opts.decay, 10));
  return { eng, img, imgPath, lutInfo };
}

// Render one genome at w×h (downscaled from the source) with the current
// dither setting. Returns {data: Uint8ClampedArray RGBA, width, height}.
function renderGenome(eng, genome, w, h) {
  const src = eng.__downscaleFloat(eng.__getSourceFloat(), eng.getTW(), eng.getTH(), w, h);
  const u8 = new Uint8ClampedArray(src.data.length);
  for (let i = 0; i < src.data.length; i++) u8[i] = Math.round(src.data[i]);
  const view = { data: u8, width: w, height: h };
  const out = eng.processGenome(view, genome, eng.currentDither());
  return { data: out.data, width: w, height: h };
}

// 5x7 pixel font for digits (and a few letters), for cell-number badges.
const FONT5x7 = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
};

function drawBadge(sheet, sheetW, x, y, text, scale) {
  // Solid dark badge with white text, scale = pixel size multiplier.
  const cw = 6 * scale, ch = 7 * scale;
  const w = text.length * cw + 2 * scale, h = ch + 2 * scale;
  const r = 0, g = 0, b = 0;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const o = ((y + yy) * sheetW + (x + xx)) * 4;
      sheet[o] = r; sheet[o + 1] = g; sheet[o + 2] = b; sheet[o + 3] = 255;
    }
  }
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = FONT5x7[text[ci]];
    if (!glyph) continue;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x + scale + ci * cw + gx * scale + sx;
            const py = y + scale + gy * scale + sy;
            const o = (py * sheetW + px) * 4;
            sheet[o] = 255; sheet[o + 1] = 255; sheet[o + 2] = 255; sheet[o + 3] = 255;
          }
        }
      }
    }
  }
}

// Render a contact sheet from cells [{genome, label}] in row-major order.
// cols: columns; cellW: cell width in px (height follows image aspect).
// Returns {png: Buffer, cells: [{label, x, y, w, h}], width, height}.
function renderContactSheet(eng, cells, opts) {
  opts = opts || {};
  const cols = opts.cols || 3;
  const cellW = opts.cellW || 320;
  const gap = opts.gap || 6;
  const img = { w: eng.getTW(), h: eng.getTH() };
  const cellH = Math.max(8, Math.round(cellW * img.h / img.w));
  const rows = Math.ceil(cells.length / cols);
  const sheetW = cols * cellW + (cols + 1) * gap;
  const sheetH = rows * cellH + (rows + 1) * gap;
  const sheet = new Uint8ClampedArray(sheetW * sheetH * 4);
  for (let i = 0; i < sheet.length; i += 4) { sheet[i] = 24; sheet[i + 1] = 24; sheet[i + 2] = 28; sheet[i + 3] = 255; }
  const layout = [];
  cells.forEach((cell, i) => {
    const cx = i % cols, cy = Math.floor(i / cols);
    const x = gap + cx * (cellW + gap), y = gap + cy * (cellH + gap);
    const rendered = renderGenome(eng, cell.genome, cellW, cellH);
    for (let yy = 0; yy < cellH; yy++) {
      for (let xx = 0; xx < cellW; xx++) {
        const si = (yy * cellW + xx) * 4;
        const di = ((y + yy) * sheetW + (x + xx)) * 4;
        sheet[di] = rendered.data[si]; sheet[di + 1] = rendered.data[si + 1];
        sheet[di + 2] = rendered.data[si + 2]; sheet[di + 3] = 255;
      }
    }
    if (cell.label !== undefined && cell.label !== null && cell.label !== '') {
      drawBadge(sheet, sheetW, x + 6, y + 6, String(cell.label), 2);
    }
    layout.push({ label: cell.label, x, y, w: cellW, h: cellH });
  });
  return { png: encodePNG({ data: sheet, width: sheetW, height: sheetH }), cells: layout, width: sheetW, height: sheetH };
}

// Spatial steps removed (skill v2): the skill pipeline is punctual-only
// (7 steps). The engine was built without Dehaze, Retinex, Clarity,
// Laplaciano local and Guided Detail, so no genome the engine creates can
// carry them — but genomes loaded from JSON files (e.g. a v1 gen file)
// still might. Strip them so a loaded genome can never reintroduce a
// spatial gene into the run or the bake recipe.
const SPATIAL_KEYS = ['dehaze', 'retinex', 'clarity', 'loclap', 'guided'];
function stripSpatialGenes(genome) {
  if (!genome || !genome.values) return genome;
  for (const k of SPATIAL_KEYS) delete genome.values[k];
  if (Array.isArray(genome.order)) genome.order = genome.order.filter(k => SPATIAL_KEYS.indexOf(k) < 0);
  return genome;
}

// Compose a contact sheet from plain decoded images (not genomes).
// images: [{data: Uint8ClampedArray RGBA, width, height, label}].
// Box-average downscale to cellW; numbered badges like renderContactSheet.
// Returns {png: Buffer, cells: [{label, x, y, w, h}], width, height}.
function composeImageSheet(images, opts) {
  opts = opts || {};
  const cols = opts.cols || 2;
  const cellW = opts.cellW || 320;
  const gap = opts.gap || 6;
  const cellH = Math.max(8, Math.round(cellW * images[0].height / images[0].width));
  const rows = Math.ceil(images.length / cols);
  const sheetW = cols * cellW + (cols + 1) * gap;
  const sheetH = rows * cellH + (rows + 1) * gap;
  const sheet = new Uint8ClampedArray(sheetW * sheetH * 4);
  for (let i = 0; i < sheet.length; i += 4) { sheet[i] = 24; sheet[i + 1] = 24; sheet[i + 2] = 28; sheet[i + 3] = 255; }
  const layout = [];
  images.forEach((im, i) => {
    const cx = i % cols, cy = Math.floor(i / cols);
    const x = gap + cx * (cellW + gap), y = gap + cy * (cellH + gap);
    const sx = im.width / cellW, sy = im.height / cellH;
    for (let yy = 0; yy < cellH; yy++) {
      const y0 = Math.floor(yy * sy), y1 = Math.max(y0 + 1, Math.min(im.height, Math.ceil((yy + 1) * sy)));
      for (let xx = 0; xx < cellW; xx++) {
        const x0 = Math.floor(xx * sx), x1 = Math.max(x0 + 1, Math.min(im.width, Math.ceil((xx + 1) * sx)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const o = (py * im.width + px) * 4;
            r += im.data[o]; g += im.data[o + 1]; b += im.data[o + 2]; n++;
          }
        }
        const di = ((y + yy) * sheetW + (x + xx)) * 4;
        sheet[di] = Math.round(r / n); sheet[di + 1] = Math.round(g / n); sheet[di + 2] = Math.round(b / n); sheet[di + 3] = 255;
      }
    }
    if (im.label !== undefined && im.label !== null && im.label !== '') {
      drawBadge(sheet, sheetW, x + 6, y + 6, String(im.label), 2);
    }
    layout.push({ label: im.label, x, y, w: cellW, h: cellH });
  });
  return { png: encodePNG({ data: sheet, width: sheetW, height: sheetH }), cells: layout, width: sheetW, height: sheetH };
}

// .cube text for a genome — same format as the web app's bakedLutBlob().
// title: shown in TITLE; the baked LUT is 65^3.
function cubeText(eng, genome, title) {
  const data = eng.buildBakedLut(genome);
  const S = eng.LUT65_SIZE;
  const steps = eng.chainStepsOf(genome);
  const parts = [
    'TITLE "' + String(title || 'LUT horneada').replace(/"/g, '') + '"',
    '# LUT horneada de Genetic Color Grading: aplicada sola a',
    '# intensidad 1 equivale a aplicar, en este orden:',
  ];
  if (!steps.length) parts.push('#   (sin pasos activos: LUT identidad)');
  steps.forEach((st, i) => {
    if (st.lut !== undefined) parts.push('#   ' + (i + 1) + '. ' + eng.lutName(st.lut) + ' x ' + st.amt.toFixed(4));
    else if (st.key === 'exp') parts.push('#   ' + (i + 1) + '. Exposición ' + (st.v > 0 ? '+' : '') + st.v.toFixed(2) + ' EV');
    else if (st.key === 'wbk') parts.push('#   ' + (i + 1) + '. Balance de blancos ' + Math.round(st.v) + 'K');
    else if (st.key === 'curves') {
      const cp = st.p || [st.v, 0, 1, 1, 0, 0];
      parts.push('#   ' + (i + 1) + '. Contraste y curvas S ' + (cp[0] > 0 ? '+' : '') + cp[0].toFixed(2) +
        ' · lift ' + (cp[1] > 0 ? '+' : '') + cp[1].toFixed(2) + ' · gamma ' + cp[2].toFixed(2) +
        ' · gain ' + cp[3].toFixed(2) + ' · sombras ' + (cp[4] > 0 ? '+' : '') + cp[4].toFixed(2) +
        ' · luces ' + (cp[5] > 0 ? '+' : '') + cp[5].toFixed(2));
    }
    else if (st.key === 'tonemap') parts.push('#   ' + (i + 1) + '. Tone mapping ' + (eng.TONEMAP_NAMES[Math.round(st.v)] || '') + ' x ' + (st.v2 !== undefined ? st.v2 : 1).toFixed(4));
    else if (st.key === 'sat') parts.push('#   ' + (i + 1) + '. Saturación ' + (eng.SAT_NAMES[Math.round(st.v)] || '') + ' x ' + (st.v2 !== undefined ? st.v2 : 1).toFixed(4));
    else if (st.key === 'huesel') parts.push('#   ' + (i + 1) + '. Hue selectivo ' + Math.round(st.v) + '° ' + (st.v2 > 0 ? '+' : '') + Math.round(st.v2 || 0) + '°');
    else parts.push('#   ' + (i + 1) + '. ' + st.key);
  });
  parts.push('LUT_3D_SIZE ' + S, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0');
  for (let p = 0; p < data.length; p += 3) {
    parts.push(data[p].toFixed(6) + ' ' + data[p + 1].toFixed(6) + ' ' + data[p + 2].toFixed(6));
  }
  return parts.join('\n') + '\n';
}

function saveJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function loadJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { parseArgs, resolveLutsDir, loadImageAndEngine, renderGenome, renderContactSheet, composeImageSheet, stripSpatialGenes, SPATIAL_KEYS, cubeText, saveJSON, loadJSON, ensureDir, eng, decodePNG, encodePNG };
