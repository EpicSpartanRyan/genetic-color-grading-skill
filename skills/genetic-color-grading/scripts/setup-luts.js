// setup-luts.js — fetch the Genetic Color Grading LUT data package.
// The 73 LUTs ship as ONE zip (a GitHub Release asset): it contains the
// 350 parts (luts-part-000.bin ... luts-part-349.bin, 90 KB each) whose
// concatenation is the 31,480,812-byte LUT blob (md5
// b1cf6e4308dcde4a852576ee935fc31f). This script downloads the zip,
// verifies its md5 (if --md5 is given), unpacks the parts, then verifies
// the joined md5. Stdlib only: https/http + node:zlib (a minimal ZIP
// reader for stored/deflated entries).
//
// Usage:
//   node setup-luts.js --url https://github.com/<owner>/<repo>/releases/download/<tag>/luts.zip [--dir <dir>] [--md5 <hex>]
//   node setup-luts.js --zip ./luts.zip [--dir <dir>]   (local file, no download)
//   Default --dir is <skill>/luts. Default expected joined md5 is the
//   known LUT blob md5; pass --md5 "" to skip the joined check.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('node:zlib');
const { parseArgs } = require('./session.js');

const EXPECTED_JOINED_MD5 = 'b1cf6e4308dcde4a852576ee935fc31f';
const PART_COUNT = 350;
const DEFAULT_URL = 'https://github.com/EpicSpartanRyan/genetic-color-grading-skill/releases/download/v0.1.0/luts.zip';
const DEFAULT_ZIP_MD5 = 'bb8bb1709a825e8ff2d1367a46e38fdf';

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

function download(url, maxRedirects) {
  const lib = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: { 'User-Agent': 'genetic-color-grading-skill/setup-luts' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if ((maxRedirects || 5) <= 0) return reject(new Error('too many redirects'));
        return resolve(download(new URL(res.headers.location, url).toString(), (maxRedirects || 5) - 1));
      }
      if (res.statusCode !== 200) return reject(new Error('download failed: HTTP ' + res.statusCode + ' for ' + url));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Minimal ZIP reader: central directory, stored (0) + deflated (8) only.
function unzip(buf) {
  const EOCD = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (EOCD < 0) throw new Error('not a ZIP file (no end-of-central-directory record)');
  const total = buf.readUInt16LE(EOCD + 10);
  const cdOffset = buf.readUInt32LE(EOCD + 16);
  const files = {};
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry at ' + p);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('unsupported ZIP method ' + method + ' for ' + name);
    if (data.length !== uncompSize) throw new Error('size mismatch for ' + name);
    files[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url && !opts.zip) opts.url = DEFAULT_URL;
  if (opts.url && !opts.md5) opts.md5 = DEFAULT_ZIP_MD5;
  if (opts.help || (!opts.url && !opts.zip)) {
    console.log('Usage: node setup-luts.js [--url <release-zip-url>] [--dir <dir>] [--md5 <hex>]');
    console.log('       (no --url: uses the v0.1.0 Release asset ' + DEFAULT_URL + ')');
    console.log('       node setup-luts.js --zip ./luts.zip [--dir <dir>]');
    process.exit(opts.help ? 0 : 1);
  }
  const dir = path.resolve(opts.dir || path.join(__dirname, '..', 'luts'));
  fs.mkdirSync(dir, { recursive: true });

  let zipBuf;
  if (opts.zip) {
    zipBuf = fs.readFileSync(path.resolve(opts.zip));
    console.log('read local zip: ' + zipBuf.length + ' bytes');
  } else {
    console.log('downloading ' + opts.url + ' ...');
    zipBuf = await download(opts.url);
    console.log('downloaded ' + zipBuf.length + ' bytes');
  }
  if (opts.md5) {
    const got = md5(zipBuf);
    if (got !== opts.md5.toLowerCase()) {
      console.error('ZIP md5 mismatch: got ' + got + ', expected ' + opts.md5);
      process.exit(1);
    }
    console.log('zip md5 OK: ' + got);
  }
  const files = unzip(zipBuf);
  const names = Object.keys(files);
  console.log('zip contains ' + names.length + ' entries');
  const parts = names.filter(n => /^luts-part-\d{3}\.bin$/.test(path.basename(n))).sort();
  if (parts.length === PART_COUNT) {
    const bufs = parts.map(n => files[n]);
    const joined = Buffer.concat(bufs);
    const joinedMd5 = md5(joined);
    const wantJoined = opts['joined-md5'] !== undefined ? opts['joined-md5'] : EXPECTED_JOINED_MD5;
    if (wantJoined && joinedMd5 !== wantJoined.toLowerCase()) {
      console.error('joined LUT md5 mismatch: got ' + joinedMd5 + ', expected ' + wantJoined);
      process.exit(1);
    }
    parts.forEach((n, i) => {
      fs.writeFileSync(path.join(dir, 'luts-part-' + String(i).padStart(3, '0') + '.bin'), files[n]);
    });
    console.log('wrote ' + PART_COUNT + ' parts to ' + dir);
    console.log('joined md5 OK: ' + joinedMd5 + ' (' + joined.length + ' bytes)');
  } else if (files['luts.bin']) {
    const joined = files['luts.bin'];
    const joinedMd5 = md5(joined);
    const wantJoined = opts['joined-md5'] !== undefined ? opts['joined-md5'] : EXPECTED_JOINED_MD5;
    if (wantJoined && joinedMd5 !== wantJoined.toLowerCase()) {
      console.error('luts.bin md5 mismatch: got ' + joinedMd5 + ', expected ' + wantJoined);
      process.exit(1);
    }
    fs.writeFileSync(path.join(dir, 'luts.bin'), joined);
    console.log('wrote luts.bin to ' + dir + ' (md5 ' + joinedMd5 + ', ' + joined.length + ' bytes)');
  } else {
    console.error('zip has neither the 350 luts-part-*.bin files (' + parts.length + ' found) nor luts.bin');
    process.exit(1);
  }
  console.log('setup complete. LUTs ready in ' + dir);
}

main().catch(e => { console.error('setup-luts failed: ' + (e && e.message ? e.message : e)); process.exit(1); });
