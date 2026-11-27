// build-engine.js — extracts the pure (non-DOM, non-GPU) Genetic Color Grading
// engine from the browser export HTML, verbatim, into a Node.js module.
//
// Method: split the engine source into top-level statements (string/comment
// aware), classify each statement by the names it defines and uses, then
// compute the dependency closure from a seed list. Browser-only functions
// are excluded by name (their Node twins live in engine-node-section.js,
// appended to the generated module). UI names that kept code still calls
// get no-op stubs in the shim.
//
// Usage: node build-engine.js [--html <export-html-path>]
//   --html: extract the inline engine script from the export HTML first
//   (takes the largest <script>...</script> block without a src attribute).
//   Without --html, uses ./engine.js (the previously extracted script).
// Output: ../genetic-color-grading-skill/skills/genetic-color-grading/scripts/engine.js
//         + build-engine-report.json
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const IS_DEV = path.basename(SCRIPT_DIR) === 'dev';
const SKILL_SCRIPTS = IS_DEV
  ? path.join(SCRIPT_DIR, '..')
  : path.join(SCRIPT_DIR, '..', 'genetic-color-grading-skill', 'skills', 'genetic-color-grading', 'scripts');
const OUT = path.join(SKILL_SCRIPTS, 'engine.js');
const REPORT = path.join(SCRIPT_DIR, 'build-engine-report.json');
const NODE_SECTION = path.join(SCRIPT_DIR, 'engine-node-section.js');

let SRC = path.join(SCRIPT_DIR, 'engine-raw.js');
const htmlArg = process.argv.indexOf('--html');
if (htmlArg >= 0 && process.argv[htmlArg + 1]) {
  const html = fs.readFileSync(process.argv[htmlArg + 1], 'utf8');
  // Largest inline <script> block (the engine); skip <script src=...> tags.
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let best = '', m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].length > best.length) best = m[1];
  }
  if (best.length < 100000) throw new Error('no large inline <script> found in ' + process.argv[htmlArg + 1] + ' (largest was ' + best.length + ' chars)');
  fs.writeFileSync(SRC, best);
  console.log('extracted inline script from HTML:', best.length, 'chars ->', SRC);
}

const src = fs.readFileSync(SRC, 'utf8');

// ---------------------------------------------------------------------------
// 0. Unwrap the outer IIFE: the engine is `(function(){ "use strict"; ... })();`
//    Split the body, not the wrapper.
// ---------------------------------------------------------------------------
function stripStringsCommentsLenient(t) {
  let out = '', i = 0, n = t.length, state = null;
  while (i < n) {
    const c = t[i], nx = t[i + 1];
    if (state === 'sq') { if (c === '\\') { out += '  '; i += 2; } else { out += (c === "'") ? "'" : ' '; if (c === "'") state = null; i++; } continue; }
    if (state === 'dq') { if (c === '\\') { out += '  '; i += 2; } else { out += (c === '"') ? '"' : ' '; if (c === '"') state = null; i++; } continue; }
    if (state === 'line') { if (c === '\n') { state = null; out += c; } else out += ' '; i++; continue; }
    if (state === 'block') { if (c === '*' && nx === '/') { state = null; out += '*/'; i += 2; } else { out += (c === '\n') ? '\n' : ' '; i++; } continue; }
    if (c === "'") { state = 'sq'; out += "'"; i++; continue; }
    if (c === '"') { state = 'dq'; out += '"'; i++; continue; }
    if (c === '/' && nx === '/') { state = 'line'; out += '  '; i += 2; continue; }
    if (c === '/' && nx === '*') { state = 'block'; out += '/*'; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

let body = src;
const iifeHead = /^\s*\(function\s*\(\s*\)\s*\{/.exec(src);
if (iifeHead) {
  // The file ends with the outer IIFE close: ...})();  (the inner boot
  // IIFE closes just before it). Slice from the head's '{' to the last '}'.
  const openIdx = src.indexOf('{', iifeHead.index);
  const closeIdx = src.lastIndexOf('}');
  if (openIdx > 0 && closeIdx > openIdx) body = src.slice(openIdx + 1, closeIdx);
  console.log('IIFE unwrapped: body bytes', body.length, 'of', src.length);
  console.log('body head:', JSON.stringify(body.slice(0, 60)));
  console.log('body tail:', JSON.stringify(body.slice(-60)));
} else {
  console.log('no IIFE wrapper found; splitting whole source');
}

// ---------------------------------------------------------------------------
// 1. Split into top-level statements (ES5 source: no template literals,
//    no arrow functions, no classes — only '...' "..." strings and comments).
// ---------------------------------------------------------------------------
function splitStatements(s) {
  const stmts = [];
  let i = 0, n = s.length;
  let start = 0;
  let depthB = 0, depthP = 0, depthK = 0;
  let state = null; // 'sq' | 'dq' | 'line' | 'block' | 'regex' | 'class'
  function stmtHead(t) {
    // Skip leading whitespace and comments: a statement may start with
    // a /* ... */ header comment before `function`/`if`/`for`/...
    const stripped = t.replace(/^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n?)*/g, '');
    const m = /^\s*(function|if|for|while|switch|try|do)\b/.exec(stripped);
    return m ? m[1] : null;
  }
  function prevSignificant(j) {
    while (j >= 0 && (s[j] === ' ' || s[j] === '\n' || s[j] === '\t' || s[j] === '\r')) j--;
    return j;
  }
  function isRegexStart(j) {
    // '/' begins a regex literal when the previous significant token is
    // not an identifier, number, string end, ')' or ']'.
    const p = prevSignificant(j - 1);
    if (p < 0) return true;
    const c = s[p];
    if (/[A-Za-z0-9_$]/.test(c)) {
      // could be a keyword like return/typeof/case — check the word
      let k = p;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(s[k])) k--;
      const w = s.slice(k + 1, p + 1);
      return /^(return|typeof|case|delete|void|in|of|new|instanceof|throw|yield|else|do)$/.test(w);
    }
    // A '/' after '}' starts a new statement, so it is a regex literal,
    // not division (a block followed by '/ 2' is a syntax error).
    return c !== ')' && c !== ']' && c !== '"' && c !== "'";
  }
  while (i < n) {
    const c = s[i], nx = s[i + 1];
    if (state === 'sq') { if (c === '\\') i += 2; else { if (c === "'") state = null; i++; } continue; }
    if (state === 'dq') { if (c === '\\') i += 2; else { if (c === '"') state = null; i++; } continue; }
    if (state === 'line') { if (c === '\n') state = null; i++; continue; }
    if (state === 'block') { if (c === '*' && nx === '/') { state = null; i += 2; } else i++; continue; }
    if (state === 'regex') {
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { state = 'class'; i++; continue; }
      if (c === '/') { state = null; i++; continue; }
      if (c === '\n') { state = null; i++; continue; }
      i++; continue;
    }
    if (state === 'class') {
      if (c === '\\') { i += 2; continue; }
      if (c === ']') { state = 'regex'; i++; continue; }
      i++; continue;
    }
    if (c === "'") { state = 'sq'; i++; continue; }
    if (c === '"') { state = 'dq'; i++; continue; }
    if (c === '/' && nx === '/') { state = 'line'; i += 2; continue; }
    if (c === '/' && nx === '*') { state = 'block'; i += 2; continue; }
    if (c === '/' && isRegexStart(i)) { state = 'regex'; i++; continue; }
    if (c === '{') depthB++;
    else if (c === '}') {
      depthB--;
      if (depthB === 0 && depthP === 0 && depthK === 0) {
        const head = stmtHead(s.slice(start, i + 1));
        if (head) { stmts.push(s.slice(start, i + 1)); start = i + 1; }
      }
    }
    else if (c === '(') depthP++;
    else if (c === ')') depthP--;
    else if (c === '[') depthK++;
    else if (c === ']') depthK--;
    else if (c === ';' && depthB === 0 && depthP === 0 && depthK === 0) {
      stmts.push(s.slice(start, i + 1)); start = i + 1;
    }
    i++;
  }
  if (start < n) stmts.push(s.slice(start));
  return stmts.filter(t => t.trim().length > 0);
}

// ---------------------------------------------------------------------------
// 2. Per-statement analysis: defines / uses / tainted.
// ---------------------------------------------------------------------------
const KEYWORDS = new Set(('break case catch continue debugger default delete do else finally for function if in instanceof new return switch this throw try typeof var void while with yield let const class extends super import export of get set static await async').split(' '));
const BROWSER_DENY = new Set(['document', 'window', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'Worker', 'navigator', 'location', 'alert', 'confirm', 'Image', 'Blob', 'FileReader', 'Audio', 'OffscreenCanvas', 'HTMLCanvasElement', 'HTMLImageElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'gl', 'XMLHttpRequest', 'FormData', 'HTMLElement', 'Node', 'Element', 'CustomEvent', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver']);
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const BUILTINS = new Set(('Math JSON Array Object String Number Boolean RegExp Date Error TypeError RangeError SyntaxError ReferenceError parseInt parseFloat isNaN isFinite Float32Array Float64Array Uint8Array Uint8ClampedArray Uint16Array Uint32Array Int8Array Int16Array Int32Array ArrayBuffer DataView Map Set WeakMap WeakSet Promise Symbol BigInt console require module exports process Buffer global globalThis setTimeout clearTimeout setInterval clearInterval decodeURIComponent encodeURIComponent decodeURI encodeURI eval Infinity NaN __dirname __filename atob btoa structuredClone queueMicrotask TextEncoder TextDecoder URL URLSearchParams').split(' '));

function stripStringsComments(t) {
  let out = '', i = 0, n = t.length, state = null;
  function prevSignificant(j) {
    while (j >= 0 && (t[j] === ' ' || t[j] === '\n' || t[j] === '\t' || t[j] === '\r')) j--;
    return j;
  }
  function isRegexStart(j) {
    const p = prevSignificant(j - 1);
    if (p < 0) return true;
    const c = t[p];
    if (/[A-Za-z0-9_$]/.test(c)) {
      let k = p;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(t[k])) k--;
      const w = t.slice(k + 1, p + 1);
      return /^(return|typeof|case|delete|void|in|of|new|instanceof|throw|yield|else|do)$/.test(w);
    }
    // A '/' after '}' starts a new statement, so it is a regex literal,
    // not division (a block followed by '/ 2' is a syntax error).
    return c !== ')' && c !== ']' && c !== '"' && c !== "'";
  }
  while (i < n) {
    const c = t[i], nx = t[i + 1];
    if (state === 'sq') { if (c === '\\') i += 2; else { if (c === "'") state = null; i++; } continue; }
    if (state === 'dq') { if (c === '\\') i += 2; else { if (c === '"') state = null; i++; } continue; }
    if (state === 'line') { if (c === '\n') { state = null; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && nx === '/') { state = null; i += 2; } else i++; continue; }
    if (state === 'regex') {
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { state = 'class'; i++; continue; }
      if (c === '/') { state = null; i++; continue; }
      if (c === '\n') { state = null; i++; continue; }
      i++; continue;
    }
    if (state === 'class') {
      if (c === '\\') { i += 2; continue; }
      if (c === ']') { state = 'regex'; i++; continue; }
      i++; continue;
    }
    if (c === "'") { state = 'sq'; out += ' '; i++; continue; }
    if (c === '"') { state = 'dq'; out += ' '; i++; continue; }
    if (c === '/' && nx === '/') { state = 'line'; i += 2; continue; }
    if (c === '/' && nx === '*') { state = 'block'; i += 2; continue; }
    if (c === '/' && isRegexStart(i)) { state = 'regex'; i++; continue; }
    out += c; i++;
  }
  return out;
}

function analyzeUses(clean) {
  const locals = new Set();
  // All names in var declarator lists (var a=1, b=2, c;), not just the first.
  const varRe = /\bvar\s+/g;
  let m;
  while ((m = varRe.exec(clean)) !== null) {
    let j = varRe.lastIndex;
    let depth = 0, segStart = j;
    while (j <= clean.length) {
      const c = clean[j];
      if (c === undefined || (c === ';' && depth === 0)) {
        const seg = clean.slice(segStart, j);
        const idm = /^\s*([A-Za-z_$][\w$]*)/.exec(seg);
        if (idm) locals.add(idm[1]);
        break;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        const seg = clean.slice(segStart, j);
        const idm = /^\s*([A-Za-z_$][\w$]*)/.exec(seg);
        if (idm) locals.add(idm[1]);
        segStart = j + 1;
      }
      j++;
    }
  }
  const fnRe = /\bfunction\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnRe.exec(clean)) !== null) if (m[1]) locals.add(m[1]);
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  while ((m = catchRe.exec(clean)) !== null) locals.add(m[1]);
  const paramRe = /\bfunction\b[^(]*\(([^)]*)\)/g;
  while ((m = paramRe.exec(clean)) !== null) {
    m[1].split(',').forEach(p => { const id = p.trim().split(/\s+/)[0]; if (/^[A-Za-z_$][\w$]*$/.test(id)) locals.add(id); });
  }
  const uses = new Set();
  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(clean)) !== null) {
    const id = m[0];
    if (KEYWORDS.has(id)) continue;
    if (id === 'true' || id === 'false' || id === 'null' || id === 'undefined' || id === 'this') continue;
    if (locals.has(id)) continue;
    let j = m.index - 1;
    while (j >= 0 && (clean[j] === ' ' || clean[j] === '\n' || clean[j] === '\t' || clean[j] === '\r')) j--;
    if (j >= 0 && clean[j] === '.') continue;
    // Object-literal key: identifier followed by ':' with '{' or ',' before it.
    let k = IDENT_RE.lastIndex;
    while (k < clean.length && (clean[k] === ' ' || clean[k] === '\n' || clean[k] === '\t' || clean[k] === '\r')) k++;
    if (k < clean.length && clean[k] === ':' && j >= 0 && (clean[j] === '{' || clean[j] === ',')) continue;
    uses.add(id);
  }
  return { uses, locals };
}

function topLevelSegments(clean) {
  const segs = [];
  let depth = 0, cur = '', i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { segs.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  segs.push(cur);
  return segs;
}

function analyzeStatement(text) {
  const clean = stripStringsComments(text);
  const trimmed = clean.trim();
  const { uses } = analyzeUses(clean);
  const defines = new Set();
  let kind = 'expr';
  if (/^(?:function\s+[A-Za-z_$][\w$]*\s*\()/.test(trimmed)) {
    kind = 'function';
    defines.add(/^function\s+([A-Za-z_$][\w$]*)/.exec(trimmed)[1]);
  } else if (/^var\b/.test(trimmed)) {
    kind = 'var';
    const rest = trimmed.replace(/^var\b/, '');
    for (const seg of topLevelSegments(rest)) {
      const m = /^\s*([A-Za-z_$][\w$]*)/.exec(seg);
      if (m) defines.add(m[1]);
    }
  } else if (/^\s*\(/.test(trimmed)) {
    kind = 'iife';
  } else {
    const m = /^([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(trimmed);
    if (m) {
      kind = 'assign';
      defines.add(m[1]);
      for (const seg of topLevelSegments(trimmed)) {
        const m2 = /,\s*([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(',' + seg);
        if (m2) defines.add(m2[1]);
      }
    }
  }
  const tainted = [...uses].some(u => BROWSER_DENY.has(u));
  return { text, clean, defines, uses, tainted, kind };
}

// ---------------------------------------------------------------------------
// 3. Seeds, forced exclusions, and names the Node section provides.
// ---------------------------------------------------------------------------
const SEEDS = new Set([
  'FILTERS', 'FBY', 'CANON', 'FIXED_HEAD', 'FIXED_KEYS', 'GENES',
  'LUT_SIZE', 'LUT_DEFS', 'LUTS', 'LUT_EXT_DEFS', 'LUT65_SIZE', 'LUT65_NODES', 'lut65Cache',
  'INDICATORS', 'IND_BY_ID', 'indicatorEnabled', 'indicatorThresholds', 'killSession', 'killGen',
  'REWARD_FEATURES', 'MONO_INDICATORS', 'MONO_BY_ID', 'monoEnabled', 'monoThresholds', 'monoKills',
  'monoMasterOn', 'monoMetricsCache', 'monoOrigMetrics', 'monoBaseCache',
  'compass', 'featCache', 'rewardOrigCct', 'mapRisk', 'mapEvals', 'mapDupes', 'mapRiskDiscards',
  'treeSeen', 'mapUiLast', 'punishedRecords', 'COMPASS_W_MAX', 'COMPASS_BAR_MAX', 'COMPASS_LR',
  'COMPASS_DECAY', 'COMPASS_PUNISH_LR', 'GEN0_TOLERANCE', 'SIMILARITY_THRESHOLD',
  'TONEMAP_GAIN', 'TONEMAP_NAMES', 'SAT_NAMES', 'AGX_IN', 'AGX_OUT', 'AGX_MIN_EV', 'AGX_RANGE',
  'SRGB_TO_LINEAR', 'XN', 'YN', 'ZN', 'DELTA', 'D3', 'BAYER8', 'BAYER_MATS', 'BAYER_NORM',
  'BN256_B64', 'BN512_B64', 'BN256_NORM', 'BN512_NORM', 'BN512_RAW',
  'SPATIAL_GENE_LABELS', 'DIAG_RAW_GAMUT', 'genePhase', 'allowedSet', 'genePins',
  'mutationPct', 'decayPct', 'decayAppliedForGen', 'generation', 'population', 'selected',
  'ancestorValues', 'pendingOrder', 'geneIntensity', 'geneSafePower', 'lutSignatures',
  'CUSTOM_BY_IDX', 'GRID_SIZE', 'POP_SIZE', 'CENTER_CELL', 'TW', 'TH', 'sW', 'sH', 'source',
  'identityGenome', 'cloneGenome', 'singleLutGenome', 'ancestorGenome',
  'geneParams', 'subGenesOf', 'paramsNeutral', 'isFixedNeutral', 'isStepAtDefault',
  'chainStepsOf', 'fixOrder', 'applyGridSize',
  'processGenomeFd', 'processGenome', 'applyOp', 'applyLut3D', 'sampleLutFloat', 'sampleLutSrc',
  'resampleLutTo33', 'upsample33to65', 'getRenderLut', 'lutC01', 'lutSat', 'lutCurve', 'lutAces',
  'lutName', 'activeLutsOf', 'lutSignature', 'lutSignatureDistance',
  'hasLut65', 'lut65KeyFor', 'buildBakedLut', 'buildBakedLut33', 'evalChainAt',
  'bakePointStep', 'bakeEnc', 'bakeLin', 'srgbLin', 'srgbLin255', 'encode255',
  'applyDither', 'floydSteinbergQuantize', 'hybridQuantize', 'normBayer',
  'spatialGenesActive', 'stepDiagnostics', 'indOn', 'indThr', 'recordKill', 'recordKills',
  'warnKeyCount', 'evaluateSafeCandidate', 'evaluateSafeCandidateInner',
  'crossover', 'orderCrossover', 'mutate', 'mutantOf', 'mutRate',
  'makeSafeChild', 'makeSafeImmigrant', 'makeGuidedChild', 'polishChild',
  'makeSafeInitialGenome', 'softInitialGenome', 'repairToSafe', 'softenGene',
  'applyGenePins', 'resetGenePins', 'resetGenKills', 'defaultHuePin', 'randomGenome',
  'allowedFilters', 'isAllowedKey', 'randIn', 'gauss', 'clampVal', 'shuffled',
  'genomeSignature', 'cubeSignature', 'genomeJSON', 'genomeAtCell',
  'monoMetricsFor', 'monoFailsFor', 'computeMonoMetrics', 'monoOn', 'monoThr',
  'monoRealFromPos', 'monoSliderPos', 'monoOrig',
  'rewardFeaturesFor', 'rewardFeaturesCompute', 'compassLearn', 'compassScore',
  'compassScoreFor', 'compassWhiten', 'compassZ', 'compassActiveIdx', 'compassObserve',
  'compassEnabled', 'compassHasSignal', 'clampCompassW', 'isPunishedGenome', 'origCct',
  'mapRiskScore', 'mapObserve', 'applyDecayOnce',
]);

const EXCLUDE = new Set([
  'analyzePipelineDetailed', 'analyzePipeline', 'monoBase96', 'lutTriggersAt',
  'geneStartIntensity', 'computeGeneStartIntensities', 'safeBoundsOn', 'treeOn',
  'currentDither', 'currentHdr', 'compassLoad', 'compassSave', 'compassNewImage',
  'ensureLut65', 'ensure65ForGenome', 'getLutTex', 'renderThumbCpu', 'renderGeneThumbCpu',
  'renderDithered', 'renderChain', 'renderFullFloat', 'applyOpGpu', 'buildOps',
  'downloadLutCube', 'exportBaked', 'exportBoth', 'exportImage', 'buildBakedLutAsync',
  'runUpsampleWorker', 'finishLut65', 'idb65Get', 'idb65Put', 'idbOpen', 'idbGetAll',
  'idbPut', 'idbDelete', 'lut65StatusShow',
  'applyMonoFilter', 'applyMinPowerFilter', 'autoAdjustGeneMinPower',
  'applyAdaptiveMonoMaxes', 'applySimilarityFilter', 'startGenePhase', 'refilterGenes',
  'sortGeneCards', 'renderPopulation', 'newPopulationFromAncestor', 'compassPunishToggle',
  'renderPreviewHiRes', 'buildFullImageBlob', 'assembleUltraHdr', 'buildUltraHdrBlob',
  'buildGainMapCanvas', 'embedJpegMeta', 'embedPngMeta', 'variantFileInfo',
  'triggerDownload', 'setDownloadsDisabled', 'buildWorkerSource',
]);

const NODE_PROVIDED = new Set([
  'analyzePipelineDetailed', 'analyzePipeline', 'monoBase96', 'lutTriggersAt',
  'geneStartIntensity', 'safeBoundsOn', 'treeOn', 'currentDither', 'currentHdr',
  'compassLoad', 'compassSave', 'compassNewImage', 'ensureLut65', 'ensure65ForGenome',
  '__setSourceImage', '__getSourceFloat', '__sourceFloat', '__sourceW', '__sourceH', '__downscaleFloat',
  '__downscaleU8', '__setSafeOn', '__setTreeOn', '__setDither', '__setGenePhase',
  '__ensureLut65Sync', '__resetSessionState', '__punishLook', '__clearPunished',
  '__ditherDesc', '__setGenePower', '__clearTreeSeen', '__setMapEvals', '__isSafeOn', '__isTreeOn',
  '__setMapDupes', '__setMapRiskDiscards', '__setDecayAppliedForGen', 'loadLutsFromParts', 'LUT_PARTS_MD5',
]);

// ---------------------------------------------------------------------------
// 4. Closure.
// ---------------------------------------------------------------------------
const rawStmts = splitStatements(body);
console.log('top-level statements:', rawStmts.length);
const stmts = rawStmts.map(analyzeStatement);

const definedInSource = new Set();
for (const s of stmts) for (const d of s.defines) definedInSource.add(d);

const needed = new Set(SEEDS);
const included = new Array(stmts.length).fill(false);
let changed = true;
while (changed) {
  changed = false;
  for (let i = 0; i < stmts.length; i++) {
    if (included[i]) continue;
    const s = stmts[i];
    if (s.tainted) continue;
    if ([...s.defines].some(d => EXCLUDE.has(d))) continue;
    if (s.kind === 'iife') continue;
    if (s.defines.size > 0) {
      if ([...s.defines].some(d => needed.has(d))) {
        included[i] = true; changed = true;
        for (const u of s.uses) needed.add(u);
      }
    } else {
      if ([...s.uses].some(u => needed.has(u))) {
        const unresolvable = [...s.uses].filter(u => !definedInSource.has(u) && !needed.has(u) && !NODE_PROVIDED.has(u) && !BUILTINS.has(u));
        if (unresolvable.length === 0) {
          included[i] = true; changed = true;
          for (const u of s.uses) needed.add(u);
        }
      }
    }
  }
}

// Prune top-level expression statements (UI wiring) whose uses will not
// exist in the module. Defining statements (function/var) are never
// pruned — they only run when called. Expression statements run at load
// time, and the ones that wire DOM elements (sMut.addEventListener,
// btnEvolve.addEventListener, syncMutUI(), buildIndicatorList(), ...) use
// names whose source definitions were excluded as browser-only; keeping
// them throws at require() time. The essential initializers
// (SRGB_TO_LINEAR fill, LUT_EXT_DEFS.forEach, FBY/GENES build,
// INDICATORS/MONO_INDICATORS.forEach, resetGenePins()) use only engine
// names that ARE defined by included statements, so they survive.
const definedByIncluded0 = new Set();
for (let i = 0; i < stmts.length; i++) {
  if (!included[i]) continue;
  for (const d of stmts[i].defines) definedByIncluded0.add(d);
}
let prunedCount = 0;
const prunedHeads = [];
for (let i = 0; i < stmts.length; i++) {
  if (!included[i]) continue;
  const s = stmts[i];
  if (s.kind !== 'expr') continue;
  const missingUse = [...s.uses].find(u => !definedByIncluded0.has(u) && !NODE_PROVIDED.has(u) && !BUILTINS.has(u));
  if (missingUse) {
    included[i] = false;
    prunedCount++;
    prunedHeads.push(s.text.replace(/\s+/g, ' ').slice(0, 100));
  }
}
// Rebuild usedByKept from the final included set (pruned statements gone).
const usedByKept = new Set();
for (let i = 0; i < stmts.length; i++) {
  if (!included[i]) continue;
  for (const u of stmts[i].uses) usedByKept.add(u);
}
// Names kept code uses that will NOT exist at runtime: not defined by any
// included statement, not provided by the Node section, not a builtin.
// (Their source definition was excluded as browser-only/tainted, or they
// are UI element variables like sMut.) These get no-op stubs in the shim —
// without them, a top-level `if(sMut) ...` statement throws ReferenceError
// at load time. The set is computed AFTER the closure, from the actual
// included statements, so it cannot miss a name the closure pulled in.
const definedByIncluded = new Set();
for (let i = 0; i < stmts.length; i++) {
  if (!included[i]) continue;
  for (const d of stmts[i].defines) definedByIncluded.add(d);
}
const missing = [...usedByKept].filter(u => !definedByIncluded.has(u) && !NODE_PROVIDED.has(u) && !BUILTINS.has(u));
const excludedReferenced = [...usedByKept].filter(u => EXCLUDE.has(u));
const undefinedUsed = missing;
const calledNames = new Set();
for (let i = 0; i < stmts.length; i++) {
  if (!included[i]) continue;
  for (const u of missing) {
    if (new RegExp('\\b' + u.replace(/\$/g, '\\$') + '\\s*\\(').test(stmts[i].clean)) calledNames.add(u);
  }
}
const stubFnNames = [...new Set(missing)].filter(n => calledNames.has(n)).sort();
const stubDataNames = [...new Set(missing)].filter(n => !calledNames.has(n)).sort();

// ---------------------------------------------------------------------------
// 5. Emit.
// ---------------------------------------------------------------------------
const keptTexts = [];
for (let i = 0; i < stmts.length; i++) if (included[i]) keptTexts.push(stmts[i].text);

const header = `// engine.js — GENERATED FILE. Do not edit by hand.
// Extracted verbatim from the Genetic Color Grading web app
// (~/workspace/goals/color-enhance-studio-gen-tico/files/genetic-color-grading/genetic-color-grading.html,
// inline script, 869287 bytes) by skills/genetic-color-grading/scripts/build-engine.js
// (dependency closure over the pure, non-DOM, non-GPU functions).
// Browser-only functions (canvas, WebGL, IndexedDB, DOM) were excluded;
// their Node twins live in the NODE section at the end of this file.
// To regenerate after a change in the web app, re-run build-engine.js
// from the skill staging directory and re-run the smoke tests.
'use strict';
`;

const shim = `
// ---------------------------------------------------------------------------
// SHIM — no-op stubs for UI functions that kept engine code still calls.
// In Node there is no panel to update; the calls are harmless.
// ---------------------------------------------------------------------------
${stubFnNames.map(n => 'function ' + n + '(){}').join('\n')}
${stubDataNames.map(n => 'var ' + n + ' = undefined;').join('\n')}
var CUSTOM_BY_IDX = (typeof CUSTOM_BY_IDX !== 'undefined') ? CUSTOM_BY_IDX : {};
`;

const nodeSection = fs.readFileSync(NODE_SECTION, 'utf8');

const exportsList = [
  'FILTERS', 'FBY', 'CANON', 'FIXED_HEAD', 'FIXED_KEYS', 'GENES', 'LUT_SIZE', 'LUTS', 'LUT_EXT_DEFS',
  'LUT65_SIZE', 'LUT65_NODES', 'INDICATORS', 'IND_BY_ID', 'REWARD_FEATURES',
  'MONO_INDICATORS', 'MONO_BY_ID', 'SIMILARITY_THRESHOLD', 'GEN0_TOLERANCE',
  'TONEMAP_GAIN', 'TONEMAP_NAMES', 'SAT_NAMES', 'SPATIAL_GENE_LABELS',
  'identityGenome', 'cloneGenome', 'singleLutGenome', 'ancestorGenome',
  'geneParams', 'subGenesOf', 'paramsNeutral', 'chainStepsOf', 'fixOrder', 'applyGridSize',
  'processGenomeFd', 'processGenome', 'applyOp', 'applyLut3D', 'sampleLutFloat',
  'sampleLutSrc', 'resampleLutTo33', 'upsample33to65', 'getRenderLut',
  'buildBakedLut', 'buildBakedLut33', 'evalChainAt', 'bakePointStep', 'lutName',
  'lutSignature', 'lutSignatureDistance',
  'applyDither', 'floydSteinbergQuantize', 'hybridQuantize',
  'spatialGenesActive', 'stepDiagnostics', 'indOn', 'indThr', 'recordKill', 'recordKills',
  'warnKeyCount', 'evaluateSafeCandidate', 'evaluateSafeCandidateInner',
  'crossover', 'mutate', 'mutantOf', 'mutRate', 'makeSafeChild', 'makeSafeImmigrant',
  'makeGuidedChild', 'polishChild', 'makeSafeInitialGenome', 'softInitialGenome',
  'repairToSafe', 'softenGene', 'applyGenePins', 'resetGenePins', 'resetGenKills',
  'defaultHuePin', 'randomGenome', 'allowedFilters', 'isAllowedKey', 'randIn', 'gauss',
  'clampVal', 'shuffled', 'genomeSignature', 'cubeSignature', 'genomeJSON', 'genomeAtCell',
  'monoMetricsFor', 'monoFailsFor', 'computeMonoMetrics', 'monoOn', 'monoThr', 'monoOrig',
  'rewardFeaturesFor', 'rewardFeaturesCompute', 'compassLearn', 'compassScore',
  'compassScoreFor', 'compassWhiten', 'compassZ', 'compassActiveIdx', 'compassObserve',
  'compassEnabled', 'compassHasSignal', 'clampCompassW', 'isPunishedGenome', 'origCct',
  'mapRiskScore', 'mapObserve', 'applyDecayOnce',
  'analyzePipelineDetailed', 'analyzePipeline', 'monoBase96', 'lutTriggersAt',
  'geneStartIntensity', 'safeBoundsOn', 'treeOn', 'currentDither',
  'compassNewImage', 'ensure65ForGenome', 'ensureLut65',
  '__setSourceImage', '__getSourceFloat', '__downscaleFloat', '__downscaleU8', '__setSafeOn', '__setTreeOn',
  '__setDither', '__setGenePhase', '__ensureLut65Sync', '__resetSessionState',
  '__punishLook', '__clearPunished', '__ditherDesc', '__setGenePower', '__clearTreeSeen', '__setMapEvals',
  '__setMapDupes', '__setMapRiskDiscards', '__setDecayAppliedForGen', '__isSafeOn', '__isTreeOn',
  'loadLutsFromParts', 'LUT_PARTS_MD5',
];

const footer = `
// ---------------------------------------------------------------------------
// Exports. Module-level 'var' state (GRID_SIZE, generation, population,
// selected, compass, genePins, TW, TH...) is NOT exported by value — it
// would go stale. Use the accessors below.
// ---------------------------------------------------------------------------
module.exports = {
  ${exportsList.join(',\n  ')},
  getGridSize: function(){ return GRID_SIZE; },
  setGridSize: function(n){ applyGridSize(n); },
  getGeneration: function(){ return generation; },
  setGeneration: function(n){ generation = n; },
  getPopulation: function(){ return population; },
  setPopulation: function(p){ population = p; },
  getSelected: function(){ return selected; },
  setSelected: function(s){ selected = s; },
  getCompass: function(){ return compass; },
  getMapRisk: function(){ return mapRisk; },
  getMapEvals: function(){ return mapEvals; },
  getGenePins: function(){ return genePins; },
  setGenePins: function(p){ genePins = p; },
  getMutationPct: function(){ return mutationPct; },
  setMutationPct: function(v){ mutationPct = v; },
  getTW: function(){ return TW; },
  getTH: function(){ return TH; },
  getGeneIntensity: function(){ return geneIntensity; },
  setGeneIntensity: function(v){ geneIntensity = v; },
  getGeneSafePower: function(){ return geneSafePower; },
  setGeneSafePower: function(v){ geneSafePower = v; },
  getMonoThresholds: function(){ return monoThresholds; },
  getMonoKills: function(){ return monoKills; },
  setMonoThresholds: function(v){ monoThresholds = v; },
  getIndicatorThresholds: function(){ return indicatorThresholds; },
  setIndicatorThresholds: function(v){ indicatorThresholds = v; },
  getKillSession: function(){ return killSession; },
  getKillGen: function(){ return killGen; },
  resetKillGen: function(){ resetGenKills(); },
  getPopSize: function(){ return POP_SIZE; },
  getCenterCell: function(){ return CENTER_CELL; },
  getAllowedSet: function(){ return allowedSet; },
  setAllowedSet: function(s){ allowedSet = s; },
  getDecayPct: function(){ return decayPct; },
  setDecayPct: function(v){ decayPct = v; },
  getMapDupes: function(){ return mapDupes; },
  getMapRiskDiscards: function(){ return mapRiskDiscards; },
  getDecayAppliedForGen: function(){ return decayAppliedForGen; },
};
`;

fs.mkdirSync(SKILL_SCRIPTS, { recursive: true });
fs.writeFileSync(OUT, header + shim + '\n' + keptTexts.join('\n') + '\n' + nodeSection + '\n' + footer);

const report = {
  engineBytes: src.length,
  statements: rawStmts.length,
  includedStatements: keptTexts.length,
  includedBytes: keptTexts.join('\n').length,
  undefinedUsed: undefinedUsed.sort(),
  excludedReferenced: excludedReferenced.sort(),
  stubFnNames: stubFnNames,
  stubDataNames: stubDataNames,
  seedsNotFound: [...SEEDS].filter(s => !definedInSource.has(s) && !NODE_PROVIDED.has(s)).sort(),
};
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
