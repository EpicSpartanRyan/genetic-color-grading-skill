// evolve.js — one generation of Genetic Color Grading, headless.
// Gen 0 builds the first population from the ancestor + the user's chosen
// genes; later generations breed the picked winners (elitism + guided
// children + immigrants), exactly as the web app's Evolucionar handler.
//
// GRID (v2): every generation is exactly 6 variant cells (3 cols x 2
// rows). There is NO original/centre cell — the user only ever sees and
// picks variants. Picks are cell numbers 1–6.
//
// The engine still thinks in square grids (GRID_SIZE 3, POP_SIZE 8,
// centre cell = original) — that geometry is used ONLY as a retry-budget
// threshold inside makeSafeChild / makeGuidedChild / makeSafeImmigrant.
// This script never calls genomeAtCell() / getCenterCell(): cells map
// 1:1 onto the local 6-genome population, and compass learning runs over
// those 6 cells via compassLearn6() below (a verbatim twin of the
// engine's compassLearn, same math, same constants — the engine's
// version iterates its own 9-cell grid and cannot see this grid).
//
// State lives in <out>/state.json (compass weights, map risk, pins,
// mutation/decay, allowed genes, ancestor); each generation writes
// <out>/gen<N>.json (genomes) and <out>/gen<N>.png (numbered contact
// sheet). The user picks winners by CELL NUMBER (1-based, row-major).
//
// Usage:
//   Gen 0:  node evolve.js --image in.png --out ./run1 --gen 0 \
//             --genes ./run1/genes.json --pick 1,3,5 [--safe] [--tree]
//   Gen N:  node evolve.js --image in.png --out ./run1 --gen N \
//             --picks 2,5 [--punish 4] [--safe] [--tree]
//   --pick/--picks are 1-based cell numbers (1..6). --punish "casts a
//   look" (compass punishment) and excludes that genome from the
//   parents. --safe/--tree default to the values stored in state.json
//   (Gen 0: safe on, tree on). --mutation/--decay override the rates.
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, loadImageAndEngine, renderContactSheet, stripSpatialGenes, saveJSON, loadJSON, ensureDir, eng } = require('./session.js');

// Grid: 3 columns x 2 rows = 6 variant cells, no original.
const GRID_COLS = 3;
const POP = GRID_COLS * 2;

function gridCells(population) {
  // Row-major cells; every cell is a variant, 1:1 with the population.
  return population.map((g, i) => ({ cell: i, pick: i + 1, kind: 'variant', genome: g, lineage: g.lineage || '' }));
}

function writeGeneration(outDir, generation, cells, state) {
  const genFile = path.join(outDir, 'gen' + generation + '.json');
  saveJSON(genFile, {
    tool: 'genetic-color-grading/evolve',
    version: 2,
    generation,
    cols: GRID_COLS,
    rows: POP / GRID_COLS,
    cellCount: cells.length,
    cells: cells.map(c => ({ cell: c.cell, pick: c.pick, kind: c.kind, lineage: c.lineage, genome: c.genome })),
  });
  const sheetCells = cells.map(c => ({ genome: c.genome, label: String(c.pick) }));
  const sheet = renderContactSheet(eng, sheetCells, { cols: GRID_COLS, cellW: 320 });
  const pngFile = path.join(outDir, 'gen' + generation + '.png');
  fs.writeFileSync(pngFile, sheet.png);
  saveJSON(path.join(outDir, 'state.json'), state);
  console.log('wrote ' + genFile);
  console.log('wrote ' + pngFile + ' (' + sheet.width + 'x' + sheet.height + ')');
  return { genFile, pngFile };
}

function captureState(generation, ancestor, allowedSet) {
  const compass = eng.getCompass();
  const mapRisk = eng.getMapRisk();
  return {
    tool: 'genetic-color-grading/state',
    version: 2,
    generation,
    gridCols: GRID_COLS,
    ancestor,
    allowedSet,
    compass: {
      w: compass.w, picks: compass.picks, chosen: compass.chosen,
      punishments: compass.punishments, enabled: compass.enabled,
      remember: compass.remember, force: compass.force, on: compass.on,
    },
    mapRisk, mapEvals: eng.getMapEvals(),
    mapDupes: eng.getMapDupes(), mapRiskDiscards: eng.getMapRiskDiscards(),
    genePins: eng.getGenePins(),
    mutationPct: eng.getMutationPct(),
    decayPct: eng.getDecayPct(),
    killSession: eng.getKillSession(),
    killGen: eng.getKillGen(),
    decayAppliedForGen: eng.getDecayAppliedForGen(),
    safe: eng.__isSafeOn(), tree: eng.__isTreeOn(),
  };
}

function restoreState(state) {
  const compass = eng.getCompass();
  Object.assign(compass, {
    w: state.compass.w || {}, picks: state.compass.picks || 0,
    chosen: state.compass.chosen || 0, punishments: state.compass.punishments || 0,
    enabled: state.compass.enabled || {}, remember: !!state.compass.remember,
    force: state.compass.force !== undefined ? state.compass.force : 0.7,
    on: state.compass.on !== undefined ? state.compass.on : true,
  });
  const mr = eng.getMapRisk();
  Object.keys(mr).forEach(k => delete mr[k]);
  Object.assign(mr, state.mapRisk || {});
  eng.__setMapEvals(state.mapEvals || 0);
  eng.__setMapDupes(state.mapDupes || 0);
  eng.__setMapRiskDiscards(state.mapRiskDiscards || 0);
  eng.setGenePins(state.genePins || eng.defaultHuePin());
  eng.setMutationPct(state.mutationPct !== undefined ? state.mutationPct : 32);
  eng.setDecayPct(state.decayPct !== undefined ? state.decayPct : 2);
  eng.__setDecayAppliedForGen(state.decayAppliedForGen !== undefined ? state.decayAppliedForGen : -1);
  eng.setAllowedSet(state.allowedSet || {});
  const ks = eng.getKillSession();
  Object.keys(ks).forEach(k => delete ks[k]);
  Object.assign(ks, state.killSession || {});
  const kg = eng.getKillGen();
  Object.keys(kg).forEach(k => delete kg[k]);
  Object.assign(kg, state.killGen || {});
  if (state.safe !== undefined) eng.__setSafeOn(!!state.safe);
  if (state.tree !== undefined) eng.__setTreeOn(!!state.tree);
}

function parseCellList(s) {
  if (!s) return [];
  return String(s).split(',').map(x => parseInt(x.trim(), 10)).filter(n => isFinite(n) && n >= 1);
}

// Matrix x vector (copy of the engine's matVecMul — it is not exported).
function matVecMul(M, v) {
  var o = new Array(v.length);
  for (var i = 0; i < v.length; i++) {
    var s = 0, Mi = M[i];
    for (var j = 0; j < v.length; j++) s += Mi[j] * v[j];
    o[i] = s;
  }
  return o;
}

// Compass learning over THIS grid: verbatim twin of the engine's
// compassLearn() (same Bradley-Terry math, same constants), except the
// cell loop runs over the 6 local genomes instead of the engine's 9-cell
// square grid with a centre original. The engine's version cannot be
// used here: it iterates genomeAtCell() over GRID_SIZE*GRID_SIZE cells
// and always counts the identity genome as an unpicked "rest" feature.
//
// Constants are the engine's (engine.js: COMPASS_LR=0.3, COMPASS_DECAY=
// 0.85, BT_TEMP=sqrt(active rewards)). compassSave()/updateCompassUI()
// are no-ops in Node and are skipped. `selected` maps 0-based cell
// index -> true for the picked winners.
function compassLearn6(population, selected) {
  const compass = eng.getCompass();
  if (!compass.on) return; // genePhase is forced false in this script.
  const chosenF = [], restF = [];
  for (let ci = 0; ci < population.length; ci++) {
    const g = population[ci];
    if (!g) continue;
    if (eng.isPunishedGenome(g)) continue; // already punished instantly: do not count twice
    const f = eng.rewardFeaturesFor(g);
    if (!f) continue;
    if (selected[ci]) chosenF.push(f); else restF.push(f);
  }
  if (!chosenF.length || !restF.length) return;
  const all = chosenF.concat(restF);
  // Mean and deviation of each reward within this generation.
  const means = {}, sds = {};
  eng.REWARD_FEATURES.forEach(function (rf) {
    let m = 0, i;
    for (i = 0; i < all.length; i++) m += all[i][rf.id];
    m /= all.length;
    let v = 0;
    for (i = 0; i < all.length; i++) { const d = all[i][rf.id] - m; v += d * d; }
    means[rf.id] = m; sds[rf.id] = Math.sqrt(v / all.length);
  });
  // Only active indices learn: z rows, whitening and gradient live in
  // their subspace; an ignored index's weight neither moves nor decays.
  const actIdx = eng.compassActiveIdx();
  if (!actIdx.length) return;
  const BT_TEMP = Math.sqrt(actIdx.length); // tempered BT score: same direction, later sigmoid saturation; the gradient is NOT divided
  function zRow(f) {
    return actIdx.map(function (fi) {
      const rf = eng.REWARD_FEATURES[fi], sd = sds[rf.id];
      return sd > 1e-9 ? (f[rf.id] - means[rf.id]) / sd : 0;
    });
  }
  const zC = chosenF.map(zRow), zR = restF.map(zRow);
  // Whitening: differences and weights to the decorrelated space. The
  // score of each pair is identical in both spaces (w'·dz' = w·dz); what
  // changes is the direction of the gradient.
  const wh = eng.compassWhiten(zC.concat(zR));
  const wArr = actIdx.map(function (fi) { return compass.w[eng.REWARD_FEATURES[fi].id] || 0; });
  let zwC = zC, zwR = zR, wW = wArr;
  if (wh) {
    zwC = zC.map(function (z) { return matVecMul(wh.W, z); });
    zwR = zR.map(function (z) { return matVecMul(wh.W, z); });
    wW = matVecMul(wh.Wi, wArr);
  }
  function scoreW(zw) {
    let s = 0;
    for (let fi = 0; fi < zw.length; fi++) s += wW[fi] * zw[fi];
    return s / BT_TEMP; // tempered score
  }
  const scC = zwC.map(scoreW), scR = zwR.map(scoreW);
  const grad = actIdx.map(function () { return 0; });
  for (let a = 0; a < zwC.length; a++) {
    for (let b = 0; b < zwR.length; b++) {
      const diff = scC[a] - scR[b];
      if (diff > 30) continue; // pair already predicted with certainty: contributes nothing
      const omP = 1 / (1 + Math.exp(diff)); // 1 − σ(diff), bounded by the if
      for (let fi2 = 0; fi2 < grad.length; fi2++) {
        const dz = zwC[a][fi2] - zwR[b][fi2];
        if (dz) grad[fi2] += omP * dz;
      }
    }
  }
  const npairs = chosenF.length * restF.length;
  let dW = grad.map(function (gv) { return 0.3 * gv / npairs; }); // COMPASS_LR = 0.3
  if (wh) dW = matVecMul(wh.W, dW); // the step, back to weight space
  actIdx.forEach(function (fi, k) {
    const rf = eng.REWARD_FEATURES[fi];
    const wOld = (compass.w[rf.id] || 0) * 0.85; // COMPASS_DECAY = 0.85
    compass.w[rf.id] = eng.clampCompassW(wOld + dW[k]);
  });
  compass.picks++; compass.chosen += chosenF.length;
  // (compassSave() / updateCompassUI() are no-ops in Node.)
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.image || !opts.out || opts.gen === undefined) {
    console.log('Usage: node evolve.js --image in.png --out ./run1 --gen 0 --genes genes.json --pick 1,3,5');
    console.log('       node evolve.js --image in.png --out ./run1 --gen N --picks 2,5 [--punish 4]');
    process.exit(opts.help ? 0 : 1);
  }
  const t0 = Date.now();
  const outDir = path.resolve(opts.out);
  ensureDir(outDir);
  const gen = parseInt(opts.gen, 10);
  const { img } = loadImageAndEngine({ image: opts.image, luts: opts.luts });
  eng.__setGenePhase(false);

  if (gen === 0) {
    // ---- Gen 0 (mirror newPopulationFromAncestor) ----
    // 6 cells: 1 ancestor clone + 5 soft-initial genomes.
    if (!opts.genes || !opts.pick) {
      console.error('Gen 0 needs --genes <genes.json from rank-genes> and --pick <rank numbers, e.g. 1,3,5>');
      process.exit(1);
    }
    const ranked = loadJSON(path.resolve(opts.genes));
    const byRank = {};
    ranked.genes.forEach(g => { byRank[g.rank] = g; });
    const picks = parseCellList(opts.pick);
    const chosenIdx = picks.map(r => byRank[r]).filter(Boolean).map(g => g.lutIdx);
    if (!chosenIdx.length) {
      console.error('no valid ranks in --pick (valid: 1..' + ranked.genes.length + ')');
      process.exit(1);
    }
    const allowedSet = {};
    chosenIdx.forEach(idx => { allowedSet['lut' + idx] = true; });
    eng.FIXED_KEYS.forEach(k => { allowedSet[k] = true; });
    ['tonemapAmt', 'satAmt', 'hueselShift', 'curvesLift', 'curvesGamma', 'curvesGain', 'curvesShad', 'curvesHigh']
      .forEach(k => { allowedSet[k] = true; });
    eng.setAllowedSet(allowedSet);
    if (opts.safe !== undefined) eng.__setSafeOn(opts.safe === true || opts.safe === 'true' || opts.safe === '1');
    if (opts.tree !== undefined) eng.__setTreeOn(opts.tree === true || opts.tree === 'true' || opts.tree === '1');
    if (opts.mutation !== undefined) eng.setMutationPct(parseInt(opts.mutation, 10));
    if (opts.decay !== undefined) eng.setDecayPct(parseInt(opts.decay, 10));

    eng.resetGenePins();
    eng.resetKillGen();
    const anc = eng.ancestorGenome();
    const safeOn = eng.__isSafeOn();
    let first = eng.cloneGenome(anc, 'ancestro', 'Base');
    if (safeOn && eng.warnKeyCount(eng.analyzePipeline(first)) > 0) first = eng.repairToSafe(first);
    eng.applyGenePins(first);
    const population = [first];
    for (let i = 1; i < POP; i++) {
      population.push(eng.applyGenePins(safeOn ? eng.makeSafeInitialGenome(anc, i) : eng.softInitialGenome(anc, i)));
    }
    const shuffledPop = eng.shuffled(population);
    eng.setPopulation(shuffledPop);
    eng.setGeneration(0);
    eng.setSelected({});
    // 65^3 grids for the chosen LUTs, on demand (web: ensureLuts65 on confirm).
    chosenIdx.forEach(idx => eng.__ensureLut65Sync(idx));
    const cells = gridCells(shuffledPop);
    const state = captureState(0, anc, allowedSet);
    writeGeneration(outDir, 0, cells, state);
    console.log('Gen 0: ' + chosenIdx.length + ' genes chosen (' + chosenIdx.map(i => eng.lutName(i)).join(', ') + ')');
    console.log('safe limits: ' + (safeOn ? 'on' : 'off') + ', tree: ' + (eng.__isTreeOn() ? 'on' : 'off') +
      ', mutation: ' + eng.getMutationPct() + '%, decay: ' + eng.getDecayPct() + '%/gen');
    console.log('total: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    return;
  }

  // ---- Gen N (mirror the Evolucionar click handler) ----
  const statePath = path.join(outDir, 'state.json');
  const prevGenPath = path.join(outDir, 'gen' + (gen - 1) + '.json');
  if (!fs.existsSync(statePath) || !fs.existsSync(prevGenPath)) {
    console.error('missing ' + statePath + ' or ' + prevGenPath + ' — run Gen 0 first, then Gen 1, 2, ... in order');
    process.exit(1);
  }
  const state = loadJSON(statePath);
  if (state.generation !== gen - 1) {
    console.error('state.json is at generation ' + state.generation + ' but --gen ' + gen + ' needs generation ' + (gen - 1) + ' as previous');
    process.exit(1);
  }
  const prevGen = loadJSON(prevGenPath);
  restoreState(state);
  if (opts.safe !== undefined) eng.__setSafeOn(opts.safe === true || opts.safe === 'true' || opts.safe === '1');
  if (opts.tree !== undefined) eng.__setTreeOn(opts.tree === true || opts.tree === 'true' || opts.tree === '1');
  if (opts.mutation !== undefined) eng.setMutationPct(parseInt(opts.mutation, 10));
  if (opts.decay !== undefined) eng.setDecayPct(parseInt(opts.decay, 10));

  // Restore the population: all cells are variants (v1 files had a
  // centre original cell — it is dropped here, and any spatial genes a
  // v1 genome carried are stripped).
  const population = [];
  prevGen.cells.forEach(c => { if (c.kind === 'variant') population.push(stripSpatialGenes(c.genome)); });
  if (population.length !== POP) {
    console.error('gen' + (gen - 1) + '.json has ' + population.length + ' variant cells, expected ' + POP + ' — regenerate it with this version of evolve.js');
    process.exit(1);
  }
  eng.setPopulation(population);
  eng.setGeneration(gen - 1);

  const picks = parseCellList(opts.picks);
  const punish = parseCellList(opts.punish);
  if (!picks.length) {
    console.error('Gen ' + gen + ' needs --picks <cell numbers 1..' + POP + ', e.g. 2,5>');
    process.exit(1);
  }
  const selected = {};
  picks.forEach(p => { if (p >= 1 && p <= POP) selected[p - 1] = true; });
  eng.setSelected(selected);

  // Punishments first: move the compass away from those looks and
  // exclude them from the parents (web: punished picks are not parents).
  const punishedCells = new Set();
  for (const p of punish) {
    if (p < 1 || p > POP) { console.log('punish: cell ' + p + ' out of range 1..' + POP + ', skipped'); continue; }
    const g = population[p - 1];
    if (!g) { console.log('punish: cell ' + p + ' has no genome, skipped'); continue; }
    const res = eng.__punishLook(g, population);
    if (res) {
      punishedCells.add(p - 1);
      console.log('punished cell ' + p + ' (' + (res.undone ? 'undone' : 'applied') + ')');
    }
  }

  // Survivors = picked genomes, minus punished ones.
  const survivors = [];
  Object.keys(selected).forEach(k => {
    const ci = parseInt(k, 10);
    if (punishedCells.has(ci)) return;
    const g = population[ci];
    if (g) survivors.push(g);
  });
  if (!survivors.length) {
    console.error(punish.length ? 'only punished cells were picked: choose another variant' : 'no valid picks');
    process.exit(1);
  }

  const rate = eng.mutRate();
  eng.applyDecayOnce(gen);
  eng.resetKillGen();
  compassLearn6(population, selected);
  eng.__clearTreeSeen();
  eng.__clearPunished();
  const next = [];
  survivors.forEach(g => { next.push(eng.cloneGenome(g, 'sobreviviente', 'Elegido')); });
  let immigrants = 2;
  let childCount = POP - next.length - immigrants;
  if (childCount < 0) { immigrants = Math.max(0, POP - next.length); childCount = 0; }
  const safeOn = eng.__isSafeOn();
  const treeOn = eng.__isTreeOn();
  for (let i = 0; i < childCount; i++) {
    const a = survivors[(Math.random() * survivors.length) | 0];
    let b = survivors.length > 1 ? survivors[(Math.random() * survivors.length) | 0] : a;
    if (survivors.length > 1) {
      let guard = 0;
      while (b === a && guard++ < 6) b = survivors[(Math.random() * survivors.length) | 0];
    }
    if (treeOn) next.push(eng.makeGuidedChild(a, b, rate, safeOn));
    else if (safeOn) next.push(eng.makeSafeChild(a, b, rate));
    else {
      const child = eng.crossover(a, b);
      eng.mutate(child, rate);
      eng.applyGenePins(child);
      child.lineage = 'Cruce';
      next.push(child);
    }
  }
  for (let i = 0; i < immigrants; i++) {
    const imm = safeOn ? eng.makeSafeImmigrant() : eng.randomGenome();
    eng.applyGenePins(imm);
    next.push(imm);
  }
  const newPop = eng.shuffled(next.slice(0, POP));
  eng.setPopulation(newPop);
  eng.setGeneration(gen);
  eng.setSelected({});
  const cells = gridCells(newPop);
  const newState = captureState(gen, state.ancestor, eng.getAllowedSet());
  newState.safe = safeOn;
  newState.tree = treeOn;
  writeGeneration(outDir, gen, cells, newState);
  const compass = eng.getCompass();
  const w = compass.w;
  const topWeights = Object.keys(w).sort((a, b) => Math.abs(w[b]) - Math.abs(w[a])).slice(0, 5)
    .map(k => k + ' ' + (w[k] >= 0 ? '+' : '') + w[k].toFixed(2));
  console.log('Gen ' + gen + ': ' + survivors.length + ' survivor(s), ' + childCount + ' children, ' + immigrants + ' immigrants');
  console.log('compass picks: ' + compass.picks + ', top weights: ' + (topWeights.join(', ') || '(none yet)'));
  console.log('mutation now: ' + eng.getMutationPct() + '% (decayed ' + eng.getDecayPct() + '%)');
  console.log('total: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main();
