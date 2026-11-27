// rank-genes.js — headless gene phase of Genetic Color Grading.
// Image in → ranked/filtered gene list + preview contact sheet out.
//
// Pipeline (identical to the web app's gene phase, same order):
//   1. Trigger power per LUT: geneStartIntensity(idx) — the lowest
//      intensity that trips any of the 18 safe-limit indicators
//      (null = never triggers, even at full power).
//   2. Sort by trigger power, descending.
//   3. Adaptive monotony maxima: per-indicator worst delta over all
//      genes, thresholds clamped to min(def, worst) — same as
//      applyAdaptiveMonoMaxes().
//   4. Monotony filter: monoFailsFor(idx) — a gene that flattens the
//      image on any of the 7 discriminators is hidden (and can no
//      longer champion its family).
//   5. Family dedup: in power order, the first gene of a family is the
//      champion; later genes whose 9^3 signature is within 15.5 of any
//      champion are hidden.
//   6. Min-power auto-adjust: median of ALL finite trigger powers;
//      genes below it are hidden. (Null-power genes survive: they never
//      trip a limit, so no power threshold applies to them.)
//
// Blind selection: the contact sheet labels cells with NUMBERS only —
// never LUT names. genes.json maps numbers to LUTs; the agent shows the
// user only the sheet, and the user picks by number.
//
// Usage:
//   node rank-genes.js --image in.png --out ./run1 [--previews-100]
//     [--luts <dir>] [--grid 3] [--cell 320]
//   Writes: <out>/genes.json, <out>/genes.png
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, loadImageAndEngine, renderContactSheet, saveJSON, ensureDir, eng } = require('./session.js');

function monoDelta(orig, trans, id) {
  // Same formulas as the web app's monoDelta().
  if (id === 'hueEntropy') return orig.hueEntropy - trans.hueEntropy;
  if (id === 'distinct') return orig.distinct > 0 ? (orig.distinct - trans.distinct) / orig.distinct * 100 : 0;
  if (id === 'abSpread') return orig.abSpread > 1e-9 ? (orig.abSpread - trans.abSpread) / orig.abSpread * 100 : 0;
  if (id === 'colorfulness') return orig.colorfulness > 1e-9 ? (orig.colorfulness - trans.colorfulness) / orig.colorfulness * 100 : 0;
  if (id === 'meanSat') return orig.meanSat - trans.meanSat;
  if (id === 'dominant') return (trans.dominantShare - orig.dominantShare) * 100;
  if (id === 'localVar') return orig.localVar > 1e-9 ? (orig.localVar - trans.localVar) / orig.localVar * 100 : 0;
  return 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.image || !opts.out) {
    console.log('Usage: node rank-genes.js --image in.png --out ./run1 [--previews-100] [--luts <dir>] [--cell 320]');
    console.log('  --previews-100  render gene previews at intensity 1 instead of trigger power');
    process.exit(opts.help ? 0 : 1);
  }
  const t0 = Date.now();
  const outDir = path.resolve(opts.out);
  ensureDir(outDir);
  const { img } = loadImageAndEngine({ image: opts.image, luts: opts.luts, grid: 3 });
  eng.__setGenePhase(true);
  const previews100 = !!opts['previews-100'];
  const n = eng.LUT_EXT_DEFS.length;

  // 1. Trigger powers.
  const powers = [];
  for (let idx = 0; idx < n; idx++) {
    let p = null;
    try { p = eng.geneStartIntensity(idx); } catch (e) { p = 0.5; }
    eng.__setGenePower(idx, p, previews100 ? 1 : p);
    powers.push(p);
  }
  console.log('trigger powers: ' + powers.filter(p => p !== null).length + '/' + n + ' trigger; ' +
    powers.filter(p => p === null).length + ' never trigger  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');

  // 2. Sort by power desc (nulls last, stable by index).
  const order = powers.map((p, idx) => ({ idx, p }))
    .sort((a, b) => {
      if (a.p === null && b.p === null) return a.idx - b.idx;
      if (a.p === null) return 1;
      if (b.p === null) return -1;
      return (b.p - a.p) || (a.idx - b.idx);
    })
    .map(d => d.idx);

  // 3. Adaptive monotony maxima (applyAdaptiveMonoMaxes).
  const orig = eng.monoOrig();
  const thresholds = {};
  const adaptedMax = {};
  if (orig) {
    const worst = {};
    eng.MONO_INDICATORS.forEach(ind => { worst[ind.id] = 0; });
    for (const idx of order) {
      const trans = eng.monoMetricsFor(idx);
      if (!trans) continue;
      eng.MONO_INDICATORS.forEach(ind => {
        const d = monoDelta(orig, trans, ind.id);
        if (isFinite(d) && d > worst[ind.id]) worst[ind.id] = d;
      });
    }
    eng.MONO_INDICATORS.forEach(ind => {
      let w = worst[ind.id]; if (!(w > 0)) w = 0;
      let adapt = w === 0 ? 0 : Math.ceil(w / ind.step - 1e-9) * ind.step;
      adapt = Math.round(adapt / ind.step) * ind.step;
      if (ind.step < 1) adapt = parseFloat(adapt.toFixed(2));
      ind.max = adapt;
      adaptedMax[ind.id] = adapt;
      let val = Math.min(ind.def, adapt);
      if (ind.step < 1) val = parseFloat(val.toFixed(2));
      thresholds[ind.id] = val;
    });
    eng.setMonoThresholds(thresholds);
  }

  // 4. Monotony filter (applyMonoFilter). Detached genes cannot champion.
  const monoHidden = new Set();
  const monoKills = {};
  eng.MONO_INDICATORS.forEach(ind => { monoKills[ind.id] = 0; });
  for (const idx of order) {
    const fails = eng.monoFailsFor(idx);
    const ids = Object.keys(fails);
    if (ids.length) {
      ids.forEach(id => { monoKills[id]++; });
      monoHidden.add(idx);
    }
  }

  // 5. Family dedup (applySimilarityFilter) over the mono survivors,
  //    in power order; null-power genes are skipped (no signature race).
  const aliveAfterMono = order.filter(idx => !monoHidden.has(idx));
  const decorated = aliveAfterMono
    .map(idx => ({ idx, p: powers[idx] }))
    .filter(d => typeof d.p === 'number' && isFinite(d.p));
  const champions = [];
  const familyHidden = new Set();
  for (const d of decorated) {
    const sig = eng.lutSignature(d.idx);
    if (!sig) continue;
    let dup = false;
    for (let c = 0; c < champions.length; c++) {
      if (eng.lutSignatureDistance(sig, champions[c]) <= eng.SIMILARITY_THRESHOLD) { dup = true; break; }
    }
    if (dup) familyHidden.add(d.idx); else champions.push(sig);
  }

  // 6. Min-power auto-adjust (autoAdjustGeneMinPower) over ALL finite
  //    powers, then filter (applyMinPowerFilter). Null powers survive.
  const finitePowers = powers.filter(p => typeof p === 'number' && isFinite(p)).sort((a, b) => b - a);
  const minPower = finitePowers.length ? finitePowers[Math.ceil(finitePowers.length / 2) - 1] : 0;
  const minPowerHidden = new Set();
  for (const idx of aliveAfterMono) {
    const p = powers[idx];
    if (typeof p !== 'number' || !isFinite(p)) continue;
    if (p < minPower - 1e-9) minPowerHidden.add(idx);
  }

  // Survivors, in power order. Rank numbers are 1-based, blind.
  const survivors = aliveAfterMono.filter(idx => !familyHidden.has(idx) && !minPowerHidden.has(idx));
  const ranked = survivors.map((idx, i) => ({
    rank: i + 1,
    lutIdx: idx,
    name: eng.lutName(idx),
    power: powers[idx],
    mono: eng.monoMetricsFor(idx),
  }));
  const hidden = order.filter(idx => !survivors.includes(idx)).map(idx => ({
    lutIdx: idx,
    name: eng.lutName(idx),
    power: powers[idx],
    reason: monoHidden.has(idx) ? 'monotony' : familyHidden.has(idx) ? 'family' : minPowerHidden.has(idx) ? 'min-power' : 'unknown',
    monoFails: monoHidden.has(idx) ? Object.keys(eng.monoFailsFor(idx)) : [],
  }));

  // Contact sheet: survivors at their preview intensity (trigger power,
  // or 1.0 with --previews-100). Labels are rank numbers only.
  const cells = ranked.map(r => ({
    genome: eng.singleLutGenome(r.lutIdx, previews100 ? 1 : (r.power === null ? 1 : r.power)),
    label: String(r.rank),
  }));
  const sheet = renderContactSheet(eng, cells, { cols: 3, cellW: parseInt(opts.cell || '320', 10) });
  fs.writeFileSync(path.join(outDir, 'genes.png'), sheet.png);

  const report = {
    tool: 'genetic-color-grading/rank-genes',
    version: 1,
    image: path.basename(opts.image),
    imageSize: { w: img.width, h: img.height },
    previews100,
    totalGenes: n,
    survivors: ranked.length,
    minPower,
    monoThresholds: thresholds,
    monoKills,
    familyChampions: champions.length,
    genes: ranked,
    hidden,
  };
  saveJSON(path.join(outDir, 'genes.json'), report);

  console.log('survivors: ' + ranked.length + '/' + n +
    '  (monotony -' + monoHidden.size + ', family -' + familyHidden.size + ', min-power -' + minPowerHidden.size + ')');
  console.log('min-power threshold: ' + minPower.toFixed(3));
  console.log('mono kills: ' + JSON.stringify(monoKills));
  console.log('wrote ' + path.join(outDir, 'genes.json'));
  console.log('wrote ' + path.join(outDir, 'genes.png') + ' (' + sheet.width + 'x' + sheet.height + ', ' + ranked.length + ' cells)');
  console.log('total: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main();
