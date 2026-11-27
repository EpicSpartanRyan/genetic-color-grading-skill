// bake.js — final outputs of Genetic Color Grading, headless.
// Winning genome in → dithered final image + baked 65^3 .cube out.
// The .cube carries only the punctual steps (the 5 spatial steps —
// Dehaze, Retinex, Clarity, Laplaciano local, Guided Detail — cannot be
// baked into a LUT); if any spatial gene is active the export warns,
// exactly as the web app's export toast does. The exported IMAGE does
// include the spatial steps.
//
// Usage:
//   node bake.js --image in.png --genome genome.json --out ./final [--name title]
//   node bake.js --image in.png --genomes gen3.json --pick 4 --out ./final
//   --dither: none | bayer2 | bayer4 | bayer8 | bn256 | bn512 | fs | hybrid
//     (default fs = Floyd-Steinberg, as in the web app)
//   Writes: <out>/<name>.png and <out>/<name>.cube
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, loadImageAndEngine, renderGenome, cubeText, saveJSON, loadJSON, ensureDir, eng, encodePNG } = require('./session.js');

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.image || !opts.out || (!opts.genome && !opts.genomes)) {
    console.log('Usage: node bake.js --image in.png --genome genome.json --out ./final [--name title] [--dither fs]');
    console.log('       node bake.js --image in.png --genomes gen3.json --pick 4 --out ./final');
    process.exit(opts.help ? 0 : 1);
  }
  const t0 = Date.now();
  const outDir = path.resolve(opts.out);
  ensureDir(outDir);
  const { img } = loadImageAndEngine({
    image: opts.image, luts: opts.luts, dither: opts.dither || 'fs',
  });
  eng.__setGenePhase(false);

  let genome, sourceDesc;
  if (opts.genome) {
    genome = loadJSON(path.resolve(opts.genome));
    sourceDesc = path.basename(opts.genome);
  } else {
    const gen = loadJSON(path.resolve(opts.genomes));
    const pick = parseInt(opts.pick, 10);
    if (!pick || pick < 1 || pick > gen.cells.length) {
      console.error('--pick must be a cell number 1..' + gen.cells.length + ' in ' + opts.genomes);
      process.exit(1);
    }
    const cell = gen.cells[pick - 1];
    genome = cell.genome;
    sourceDesc = path.basename(opts.genomes) + ' cell ' + pick + (cell.kind === 'original' ? ' (original)' : '');
  }
  const name = (opts.name || 'graded').replace(/[^A-Za-z0-9._-]+/g, '_');

  // Spatial genes cannot bake into the .cube — warn, as the web app does.
  const spatial = eng.spatialGenesActive(genome);
  if (spatial.length) {
    console.log('WARNING: spatial steps active (' + spatial.join(', ') + ') — they are IN the exported image but CANNOT be baked into the .cube. The .cube will only carry the punctual steps.');
  }

  // Final image at full resolution, with the chosen dither.
  const rendered = renderGenome(eng, genome, img.width, img.height);
  const pngBuf = encodePNG(rendered);
  const pngFile = path.join(outDir, name + '.png');
  fs.writeFileSync(pngFile, pngBuf);
  console.log('wrote ' + pngFile + ' (' + img.width + 'x' + img.height + ', ' + pngBuf.length + ' bytes)');

  // Baked 65^3 .cube (punctual steps only).
  const cube = cubeText(eng, genome, name);
  const cubeFile = path.join(outDir, name + '.cube');
  fs.writeFileSync(cubeFile, cube);
  const cubeLines = cube.split('\n');
  console.log('wrote ' + cubeFile + ' (' + cubeLines.length + ' lines, ' + cube.length + ' bytes)');
  console.log('cube header: ' + cubeLines.slice(0, 4).join(' | '));
  console.log('cube size line: ' + cubeLines.find(l => l.startsWith('LUT_3D_SIZE')));
  console.log('source: ' + sourceDesc + '  |  dither: ' + (opts.dither || 'fs') + '  |  total: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main();
