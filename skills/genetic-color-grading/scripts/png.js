// png.js — minimal PNG decode/encode, Node.js stdlib only (node:zlib).
// Decode: color types 0, 2, 3, 4, 6; bit depths 1/2/4/8/16; non-interlaced.
// Encode: 8-bit RGBA, per-row adaptive filter (0-4, minimum absolute sum).
// Throws a clear error for interlaced (Adam7) images.
'use strict';
const zlib = require('node:zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePNG(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('not a PNG file (bad signature)');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (interlace !== 0) throw new Error('interlaced PNG (Adam7) not supported — re-save as non-interlaced');
      if (width === 0 || height === 0) throw new Error('PNG has zero width or height');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width) throw new Error('PNG missing IHDR');
  if (idat.length === 0) throw new Error('PNG missing IDAT');
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported PNG color type ' + colorType);
  if (bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4 && bitDepth !== 8 && bitDepth !== 16) {
    throw new Error('unsupported PNG bit depth ' + bitDepth);
  }
  if ((colorType === 2 || colorType === 4 || colorType === 6) && bitDepth !== 8 && bitDepth !== 16) {
    throw new Error('unsupported PNG bit depth ' + bitDepth + ' for color type ' + colorType);
  }
  const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8)); // bytes per pixel for filtering
  const rowBits = width * channels * bitDepth;
  const rowBytes = Math.ceil(rowBits / 8);
  if (raw.length < height * (rowBytes + 1)) throw new Error('PNG IDAT too short');

  const out = new Uint8ClampedArray(width * height * 4);
  let p = 0;
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = Buffer.from(raw.subarray(p, p + rowBytes));
    p += rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 0) { /* none */ }
      else if (filter === 1) row[x] = (row[x] + a) & 0xff;
      else if (filter === 2) row[x] = (row[x] + b) & 0xff;
      else if (filter === 3) row[x] = (row[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paeth(a, b, c)) & 0xff;
      else throw new Error('unknown PNG filter type ' + filter + ' on row ' + y);
    }
    // Expand the row into RGBA.
    if (bitDepth === 8) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (colorType === 6) {
          out[o] = row[x * 4]; out[o + 1] = row[x * 4 + 1]; out[o + 2] = row[x * 4 + 2]; out[o + 3] = row[x * 4 + 3];
        } else if (colorType === 2) {
          out[o] = row[x * 3]; out[o + 1] = row[x * 3 + 1]; out[o + 2] = row[x * 3 + 2]; out[o + 3] = 255;
        } else if (colorType === 0) {
          const g = row[x]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
        } else if (colorType === 4) {
          const g = row[x * 2]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = row[x * 2 + 1];
        } else if (colorType === 3) {
          const idx = row[x] * 3;
          out[o] = palette[idx]; out[o + 1] = palette[idx + 1]; out[o + 2] = palette[idx + 2];
          out[o + 3] = trns && idx / 3 < trns.length ? trns[idx / 3] : 255;
        }
      }
    } else if (bitDepth === 16) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (colorType === 6) {
          out[o] = row[x * 8]; out[o + 1] = row[x * 8 + 2]; out[o + 2] = row[x * 8 + 4]; out[o + 3] = row[x * 8 + 6];
        } else if (colorType === 2) {
          out[o] = row[x * 6]; out[o + 1] = row[x * 6 + 2]; out[o + 2] = row[x * 6 + 4]; out[o + 3] = 255;
        } else if (colorType === 0) {
          const g = row[x * 2]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
        } else if (colorType === 4) {
          const g = row[x * 4]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = row[x * 4 + 2];
        }
      }
    } else {
      // Sub-byte depths (1/2/4): grayscale or palette.
      const perByte = 8 / bitDepth;
      const mask = (1 << bitDepth) - 1;
      for (let x = 0; x < width; x++) {
        const byte = row[Math.floor(x / perByte)];
        const shift = 8 - bitDepth * ((x % perByte) + 1);
        const v = (byte >> shift) & mask;
        const o = (y * width + x) * 4;
        if (colorType === 0) {
          const g = Math.round(v * 255 / mask);
          out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
        } else if (colorType === 3) {
          const idx = v * 3;
          out[o] = palette[idx]; out[o + 1] = palette[idx + 1]; out[o + 2] = palette[idx + 2];
          out[o + 3] = trns && v < trns.length ? trns[v] : 255;
        }
      }
    }
    prev = row;
  }
  return { data: out, width, height };
}

function encodePNG(img) {
  const { data, width, height } = img;
  if (!data || data.length < width * height * 4) throw new Error('encodePNG: bad image data');
  const bpp = 4;
  const rowBytes = width * bpp;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    const row = Buffer.from(data.subarray(rowStart, rowStart + rowBytes));
    // Try all 5 filters; keep the one with the smallest sum of |signed byte|.
    let bestFilter = 0, bestScore = Infinity, bestRow = null;
    for (let f = 0; f <= 4; f++) {
      const cand = Buffer.from(row);
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = ((a + b) >> 1);
        else if (f === 4) pred = paeth(a, b, c);
        cand[x] = (row[x] - pred) & 0xff;
      }
      let score = 0;
      for (let x = 0; x < rowBytes; x++) {
        const s = cand[x] < 128 ? cand[x] : cand[x] - 256;
        score += Math.abs(s);
      }
      if (score < bestScore) { bestScore = score; bestFilter = f; bestRow = cand; }
    }
    raw[y * (rowBytes + 1)] = bestFilter;
    bestRow.copy(raw, y * (rowBytes + 1) + 1);
    prev = row;
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    const crc = crc32(Buffer.concat([Buffer.from(type, 'latin1'), data]));
    out.writeUInt32BE(crc >>> 0, 8 + data.length);
    return out;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// CRC-32 (IEEE) with a lazily built table.
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) | 0;
}

module.exports = { decodePNG, encodePNG };
