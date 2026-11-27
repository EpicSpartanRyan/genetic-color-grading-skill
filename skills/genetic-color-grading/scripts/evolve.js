// evolve.js — one generation of Genetic Color Grading, headless.
// Gen 0 builds the first population from the ancestor + the user's chosen
// genes; later generations breed the picked winners (elitism + guided
// children + immigrants), exactly as the web app's Evolucionar handler.
//
// State lives in <out>/state.json (compass weights, map risk, pins,
// mutation/decay, allowed genes, ancestor); each generation writes
// <out>/gen<N>.json (genomes) and <out>/gen<N>.png (numbered contact
// sheet). The user picks winners by CELL NUMBER (1-based, row-major);
// the centre cell is the original (labelled ORIG) and may be picked —
// it breeds the identity genome.
//
// Usage:
//   Gen 0:  node evolve.js --image in.png --out ./run1 --gen 0 \
//             --genes ./run1/genes.json --pick 1,5,9 [--safe] [--tree]
//   Gen N:  node evolve.js --image in.png --out ./run1 --gen N \
//             --picks 2,5 [--punish 7] [--safe] [--tree]
//   --pick/--picks are 1-based cell numbers. --punish "casts a look"
//   (compass punishment) and excludes that genome from the parents.
//   --safe/--tree default to the values stored in state.json (Gen 0:
//   safe on, tree on). --mutation/--decay override the rates.
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, loadImageAndEngine, renderContactSheet, saveJSON, loadJSON, ensureDir, eng } = require('./session.js');

function gridCells(population, gridSize) {
  // Row-major cells; centre cell is the original (identity genome).
  const total = gridSize * gridSize;
  const center = Math.floor(total / 2);
  const cells = [];
  let pi = 0;
  for (let c = 0; c < total; c++) {
    if (c === center) {
      cells.push({ cell: c, pick: c + 1, kind: 'original', genome: eng.identityGenome(), lineage: 'Original' });
    } else {
      const g = population[pi++];
      cells.push({ cell: c, pick: c + 1, kind: 'variant', genome: g, lineage: g.lineage || '' });
    }
  }
  return cells;
}

function writeGeneration(outDir, generation, gridSize, cells, state) {
  const genFile = path.join(outDir, 'gen' + generation + '.json');
  saveJSON(genFile, {
    tool: 'genetic-color-grading/evolve',
    version: 1,
    generation,
    gridSize,
    cells: cells.map(c => ({ cell: c.cell, pick: c.pick, kind: c.kind, lineage: c.lineage, genome: c.genome })),
  });
  const sheetCells = cells.map(c => ({
    genome: c.genome,
    label: c.kind === 'original' ? 'ORIG' : String(c.pick),
  }));
  const sheet = renderContactSheet(eng, sheetCells, { cols: gridSize, cellW: 320 });
  const pngFile = path.join(outDir, 'gen' + generation + '.png');
  fs.writeFileSync(pngFile, sheet.png);
  saveJSON(path.join(outDir, 'state.json'), state);
  console.log('wrote ' + genFile);
  console.log('wrote ' + pngFile + ' (' + sheet.width + 'x' + sheet.height + ')');
  return { genFile, pngFile };
}

function captureState(generation, gridSize, ancestor, allowedSet) {
  const compass = eng.getCompass();
  const mapRisk = eng.getMapRisk();
  return {
    tool: 'genetic-color-grading/state',
    version: 1,
    generation,
    gridSize,
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.image || !opts.out || opts.gen === undefined) {
    console.log('Usage: node evolve.js --image in.png --out ./run1 --gen 0 --genes genes.json --pick 1,5,9');
    console.log('       node evolve.js --image in.png --out ./run1 --gen N --picks 2,5 [--punish 7]');
    process.exit(opts.help ? 0 : 1);
  }
  const t0 = Date.now();
  const outDir = path.resolve(opts.out);
  ensureDir(outDir);
  const gen = parseInt(opts.gen, 10);
  const { img } = loadImageAndEngine({ image: opts.image, luts: opts.luts, grid: opts.grid });
  eng.__setGenePhase(false);
  const gridSize = eng.getGridSize();

  if (gen === 0) {
    // ---- Gen 0 (mirror newPopulationFromAncestor) ----
    if (!opts.genes || !opts.pick) {
      console.error('Gen 0 needs --genes <genes.json from rank-genes> and --pick <rank numbers, e.g. 1,5,9>');
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
    for (let i = 1; i < eng.getPopSize(); i++) {
      population.push(eng.applyGenePins(safeOn ? eng.makeSafeInitialGenome(anc, i) : eng.softInitialGenome(anc, i)));
    }
    const shuffledPop = eng.shuffled(population);
    eng.setPopulation(shuffledPop);
    eng.setGeneration(0);
    eng.setSelected({});
    // 65^3 grids for the chosen LUTs, on demand (web: ensureLuts65 on confirm).
    chosenIdx.forEach(idx => eng.__ensureLut65Sync(idx));
    const cells = gridCells(shuffledPop, gridSize);
    const state = captureState(0, gridSize, anc, allowedSet);
    writeGeneration(outDir, 0, gridSize, cells, state);
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

  // Restore the population (variants only; centre cell is the original).
  const center = eng.getCenterCell();
  const population = [];
  prevGen.cells.forEach(c => { if (c.kind === 'variant') population.push(c.genome); });
  eng.setPopulation(population);
  eng.setGeneration(gen - 1);

  const picks = parseCellList(opts.picks);
  const punish = parseCellList(opts.punish);
  if (!picks.length) {
    console.error('Gen ' + gen + ' needs --picks <cell numbers, e.g. 2,5>');
    process.exit(1);
  }
  const selected = {};
  picks.forEach(p => { selected[p - 1] = true; });
  eng.setSelected(selected);

  // Punishments first: move the compass away from those looks and
  // exclude them from the parents (web: punished picks are not parents).
  const punishedCells = new Set();
  for (const p of punish) {
    if (p - 1 === eng.getCenterCell()) { console.log('punish: cell ' + p + ' is the original, cannot punish it'); continue; }
    const g = eng.genomeAtCell(p - 1);
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
    const g = eng.genomeAtCell(ci);
    if (g) survivors.push(g);
  });
  if (!survivors.length) {
    console.error(punish.length ? 'only punished cells were picked: choose another variant' : 'no valid picks');
    process.exit(1);
  }

  const rate = eng.mutRate();
  eng.applyDecayOnce(gen);
  eng.resetKillGen();
  eng.compassLearn();
  eng.__clearTreeSeen();
  eng.__clearPunished();
  const next = [];
  survivors.forEach(g => { next.push(eng.cloneGenome(g, 'sobreviviente', 'Elegido')); });
  let immigrants = 2;
  let childCount = eng.getPopSize() - next.length - immigrants;
  if (childCount < 0) { immigrants = Math.max(0, eng.getPopSize() - next.length); childCount = 0; }
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
  const newPop = eng.shuffled(next.slice(0, eng.getPopSize()));
  eng.setPopulation(newPop);
  eng.setGeneration(gen);
  eng.setSelected({});
  const cells = gridCells(newPop, gridSize);
  const newState = captureState(gen, gridSize, state.ancestor, eng.getAllowedSet());
  newState.safe = safeOn;
  newState.tree = treeOn;
  writeGeneration(outDir, gen, gridSize, cells, newState);
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
