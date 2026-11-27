// extract-frames.js — video input for Genetic Color Grading.
// A video in → 4 evenly spaced preview frames out. The agent shows the
// contact sheet, the user picks frame 1–4, and that frame becomes the
// --image for the rest of the workflow (rank → evolve → bake).
//
// Frames are taken at 12.5%, 37.5%, 62.5% and 87.5% of the duration —
// not at 0% / 100%, where videos often start/end on black frames.
//
// Requires ffmpeg + ffprobe in PATH (any ffmpeg 5+ works; tested on 8.x).
// If they are missing, the script exits with a clear install hint and
// does nothing else.
//
// SCOPE: grading is done on the chosen frame only. There is NO video
// output and NO re-encoding — the deliverable stays the graded image +
// baked .cube, which the user applies to the video in DaVinci Resolve.
//
// Usage:
//   node extract-frames.js --video in.mp4 --out ./run1 [--frames 4] [--cell 320]
//   Writes: <out>/frame-1.png … frame-4.png, <out>/frames.png (2×2 sheet
//   with numbered badges 1–4), <out>/frames.json (video, duration,
//   timestamps, frame files).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { parseArgs, composeImageSheet, saveJSON, ensureDir, decodePNG } = require('./session.js');

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function probeDuration(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'json', videoPath,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const d = JSON.parse(out).format;
  const dur = d && parseFloat(d.duration);
  if (!isFinite(dur) || dur <= 0) throw new Error('ffprobe could not read a duration from ' + videoPath);
  return dur;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.video || !opts.out) {
    console.log('Usage: node extract-frames.js --video in.mp4 --out ./run1 [--frames 4] [--cell 320]');
    process.exit(opts.help ? 0 : 1);
  }
  const videoPath = path.resolve(opts.video);
  if (!fs.existsSync(videoPath)) {
    console.error('video not found: ' + videoPath);
    process.exit(1);
  }
  if (!which('ffmpeg') || !which('ffprobe')) {
    console.error('ffmpeg/ffprobe not found in PATH — video input needs them.\n' +
      'Install ffmpeg (https://ffmpeg.org/download.html) and re-run:\n' +
      '  macOS:   brew install ffmpeg\n' +
      '  Ubuntu:  sudo apt install ffmpeg\n' +
      '  Windows: winget install Gyan.FFmpeg  (or choco install ffmpeg)');
    process.exit(1);
  }
  const t0 = Date.now();
  const outDir = path.resolve(opts.out);
  ensureDir(outDir);
  const nFrames = parseInt(opts.frames || '4', 10) || 4;
  if (nFrames < 1 || nFrames > 16) {
    console.error('--frames must be 1..16 (got ' + opts.frames + ')');
    process.exit(1);
  }
  // Evenly spaced fractions across the duration (never 0% / 100%).
  const fractions = [];
  for (let i = 0; i < nFrames; i++) fractions.push((i + 0.5) / nFrames);
  const duration = probeDuration(videoPath);
  console.log('video: ' + path.basename(videoPath) + ' (' + duration.toFixed(2) + 's)');

  const frames = [];
  for (let i = 0; i < nFrames; i++) {
    const t = duration * fractions[i];
    const file = path.join(outDir, 'frame-' + (i + 1) + '.png');
    // -ss after -i: frame-accurate seek (slower, but the frame is the one
    // at that timestamp, not the nearest keyframe).
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-i', videoPath, '-ss', t.toFixed(3),
      '-frames:v', '1', file,
    ], { stdio: 'inherit' });
    const img = decodePNG(fs.readFileSync(file));
    frames.push({ file: path.basename(file), time: +t.toFixed(3), fraction: fractions[i], w: img.width, h: img.height });
    console.log('frame ' + (i + 1) + ': t=' + t.toFixed(2) + 's -> ' + path.basename(file) + ' (' + img.width + 'x' + img.height + ')');
  }

  const sheet = composeImageSheet(
    frames.map((f, i) => {
      const img = decodePNG(fs.readFileSync(path.join(outDir, f.file)));
      return { data: img.data, width: img.width, height: img.height, label: String(i + 1) };
    }),
    { cols: 2, cellW: parseInt(opts.cell || '320', 10) },
  );
  const sheetFile = path.join(outDir, 'frames.png');
  fs.writeFileSync(sheetFile, sheet.png);
  console.log('wrote ' + sheetFile + ' (' + sheet.width + 'x' + sheet.height + ', ' + nFrames + ' frames)');

  saveJSON(path.join(outDir, 'frames.json'), {
    tool: 'genetic-color-grading/extract-frames',
    version: 1,
    video: path.basename(opts.video),
    videoPath,
    duration: +duration.toFixed(3),
    frames,
    sheet: 'frames.png',
  });
  console.log('total: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main();
