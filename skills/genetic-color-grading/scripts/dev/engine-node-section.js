// ---------------------------------------------------------------------------
// NODE SECTION — twins of the browser-only functions, written for Node.js.
// These replace canvas / WebGL / IndexedDB / DOM code from the web app with
// pure JS equivalents. Semantics are kept identical wherever possible;
// known deviations are marked "DEVIATION" and listed in references/.
// ---------------------------------------------------------------------------

// --- image store -----------------------------------------------------------
var __sourceFloat = null;   // Float32Array RGBA, 0..255, the loaded source image
var __sourceW = 0, __sourceH = 0;
var __safeOn = true;
var __treeOn = true;
var __dither = { kind: 'fs', n: null, m: null, label: 'floyd-steinberg' };

function __setSourceImage(data, w, h) {
  __sourceFloat = new Float32Array(data.length);
  for (var i = 0; i < data.length; i++) __sourceFloat[i] = data[i];
  __sourceW = w; __sourceH = h;
  TW = w; TH = h; sW = w; sH = h;
  monoBaseCache = null; monoOrigMetrics = null; monoMetricsCache = {};
  featCache = {}; rewardOrigCct = null;
}

function __getSourceFloat() { return __sourceFloat; }

function __downscaleFloat(src, sw, sh, dw, dh) {
  // Box-average downscale. DEVIATION: the web app uses canvas drawImage
  // (bilinear-ish smoothing); pixel values at 96/144px differ slightly.
  // The 18 indicators are robust to this (they threshold proportions).
  var out = new Float32Array(dw * dh * 4);
  var xr = sw / dw, yr = sh / dh;
  for (var y = 0; y < dh; y++) {
    var y0 = Math.floor(y * yr), y1 = Math.min(sh, Math.ceil((y + 1) * yr));
    if (y1 <= y0) y1 = y0 + 1;
    for (var x = 0; x < dw; x++) {
      var x0 = Math.floor(x * xr), x1 = Math.min(sw, Math.ceil((x + 1) * xr));
      if (x1 <= x0) x1 = x0 + 1;
      var r = 0, g = 0, b = 0, a = 0, n = 0;
      for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++) {
        var o = (yy * sw + xx) * 4;
        r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; n++;
      }
      var o2 = (y * dw + x) * 4;
      out[o2] = r / n; out[o2 + 1] = g / n; out[o2 + 2] = b / n; out[o2 + 3] = a / n;
    }
  }
  return { data: out, w: dw, h: dh };
}

function __downscaleU8(src, sw, sh, dw, dh) {
  var f = __downscaleFloat(src, sw, sh, dw, dh);
  var u8 = new Uint8ClampedArray(f.data.length);
  for (var i = 0; i < f.data.length; i++) u8[i] = Math.round(f.data[i]);
  return { data: u8, w: dw, h: dh };
}

// --- settings twins --------------------------------------------------------
function safeBoundsOn() { return __safeOn; }
function __setSafeOn(v) { __safeOn = !!v; }
function __isSafeOn() { return __safeOn; }
function treeOn() { return __treeOn; }
function __setTreeOn(v) { __treeOn = !!v; }
function __isTreeOn() { return __treeOn; }
function currentDither() { return __dither; }
function __setDither(d) { __dither = d; }
function __ditherDesc(kind) {
  // Same mapping as the web app's currentDither(), minus the DOM select.
  switch (kind) {
    case 'none': return null;
    case 'bayer2': return { kind: 'ordered', n: 2, m: BAYER_NORM[2], label: 'bayer-2x2' };
    case 'bayer4': return { kind: 'ordered', n: 4, m: BAYER_NORM[4], label: 'bayer-4x4' };
    case 'bayer8': return { kind: 'ordered', n: 8, m: BAYER_NORM[8], label: 'bayer-8x8' };
    case 'bn256': return { kind: 'ordered', n: 256, m: BN256_NORM, label: 'bluenoise-256' };
    case 'bn512': return { kind: 'ordered', n: 512, m: BN512_NORM, label: 'bluenoise-512' };
    case 'fs': return { kind: 'fs', n: null, m: null, label: 'floyd-steinberg' };
    case 'hybrid': return { kind: 'hybrid', n: null, m: null, bn: BN512_RAW, label: 'bluenoise-512-floyd-steinberg-oklch' };
    default: return { kind: 'fs', n: null, m: null, label: 'floyd-steinberg' };
  }
}
function currentHdr() { return null; } // no HDR export in v1
function __setGenePhase(v) { genePhase = !!v; }
function __setGenePower(idx, power, previewPower) {
  geneSafePower[idx] = power;
  geneIntensity[idx] = (previewPower !== undefined) ? previewPower : power;
}
function compassLoad() {}
function compassSave() {}

// --- analyzePipelineDetailed twin (judge at 96px / 144px) -----------------
// Faithful twin of the web app's analyzePipelineDetailed: same iteration
// over g.order, same applyOp calls, same raw-gamut counting + clamp,
// same stepDiagnostics({msgs, ids}) shape, same final degenerate stats.
// Only the downscale differs: __downscaleFloat (box average) instead of
// canvas drawImage (bilinear smoothing). DEVIATION: pixel values at
// 96/144px differ slightly; the 18 indicators threshold proportions, so
// verdicts are robust to it.
function analyzePipelineDetailed(g, maxDimOverride) {
  var map = {}, allIds = {};
  if (!g || !__sourceFloat || !TW || !TH) return { map: map, ids: allIds };
  var maxD = maxDimOverride || 144, sc = Math.min(maxD / TW, maxD / TH, 1);
  var aw = Math.max(8, Math.round(TW * sc)), ah = Math.max(8, Math.round(TH * sc));
  var base = __downscaleFloat(__sourceFloat, TW, TH, aw, ah);
  var n = base.data.length, npix = aw * ah;
  var fd = new Float32Array(n);
  for (var q = 0; q < n; q++) fd[q] = base.data[q];
  var view = { data: fd, width: aw, height: ah };
  for (var i = 0; i < g.order.length; i++) {
    var key = g.order[i], f = FBY[key];
    if (!f) continue;
    var before = null;
    if (f.key2) {
      if (g.values[key] === undefined) continue;
      var arr = geneParams(f, g.values);
      if (paramsNeutral(key, arr)) continue;
      before = fd.slice();
      try { DIAG_RAW_GAMUT = true; applyOp(view, key, arr); DIAG_RAW_GAMUT = false; } catch (e) { DIAG_RAW_GAMUT = false; continue; }
    } else {
      var v = g.values[key];
      if (v === f.def || v === undefined) continue;
      before = fd.slice();
      try { DIAG_RAW_GAMUT = true; applyOp(view, key, v); DIAG_RAW_GAMUT = false; } catch (e) { DIAG_RAW_GAMUT = false; continue; }
    }
    // fd holds the step's RAW output (unclamped): count channels outside
    // [0,255] that were in-range before — that is the step's real gamut —
    // then clamp fd immediately, as the real pipeline does.
    var gamutRaw = 0;
    for (var gi = 0; gi < fd.length; gi += 4) {
      for (var gc = 0; gc < 3; gc++) {
        var ga = fd[gi + gc], gb = before[gi + gc];
        if ((ga < 0 || ga > 255) && gb >= 0 && gb <= 255) gamutRaw++;
        fd[gi + gc] = ga < 0 ? 0 : ga > 255 ? 255 : ga;
      }
    }
    var diag = stepDiagnostics(before, fd, npix, gamutRaw, aw, ah);
    var msgs = diag.msgs || [];
    if (msgs.length) {
      map[key] = msgs;
      for (var idk in diag.ids) if (Object.prototype.hasOwnProperty.call(diag.ids, idk)) allIds[idk] = true;
    }
  }
  var lumSum = 0, c0 = 0, c255 = 0, tot = 0;
  for (var fi = 0; fi < fd.length; fi += 4) {
    lumSum += 0.299 * fd[fi] + 0.587 * fd[fi + 1] + 0.114 * fd[fi + 2];
    for (var fc = 0; fc < 3; fc++) { var fv = fd[fi + fc]; tot++; if (fv <= 0) c0++; else if (fv >= 255) c255++; }
  }
  var fmean = npix ? lumSum / npix : 0;
  var final = { mean: fmean, pct0: tot ? 100 * c0 / tot : 0, pct255: tot ? 100 * c255 / tot : 0 };
  return { map: map, ids: allIds, final: final };
}

function analyzePipeline(g, maxDimOverride) {
  var d = analyzePipelineDetailed(g, maxDimOverride);
  var warned = [];
  for (var id in d.ids) if (d.ids[id]) warned.push(id);
  return warned;
}

// --- mono base twin ---------------------------------------------------------
function monoBase96() {
  if (monoBaseCache) return monoBaseCache;
  if (!__sourceFloat || !TW || !TH) return null;
  var sc = Math.min(96 / TW, 96 / TH, 1);
  var aw = Math.max(8, Math.round(TW * sc)), ah = Math.max(8, Math.round(TH * sc));
  var d = __downscaleU8(__sourceFloat, TW, TH, aw, ah);
  monoBaseCache = { data: d.data, w: aw, h: ah };
  return monoBaseCache;
}

// --- gene trigger twins -----------------------------------------------------
function lutTriggersAt(idx, inten) {
  if (!TW || !TH || !__sourceFloat) return false;
  var d = analyzePipelineDetailed(singleLutGenome(idx, inten), 96);
  for (var k in d.ids) if (Object.prototype.hasOwnProperty.call(d.ids, k)) return true;
  return false;
}

function geneStartIntensity(idx) {
  var lo = 0.01, hi = 1, best = null;
  if (lutTriggersAt(idx, 0.01)) return 0.01;
  if (!lutTriggersAt(idx, 1)) return null;
  for (var it = 0; it < 12; it++) {
    var mid = (lo + hi) / 2;
    if (lutTriggersAt(idx, mid)) { best = mid; hi = mid; } else lo = mid;
  }
  if (best === null) best = hi;
  return best;
}

// --- compass / map session twins --------------------------------------------
function compassNewImage() {
  compass.stats = {};
  featCache = {}; rewardOrigCct = null;
  mapRisk = {}; mapEvals = 0; mapDupes = 0; mapRiskDiscards = 0; treeSeen = {};
  punishedRecords = {};
  if (!compass.remember) { compass.w = {}; compass.picks = 0; compass.chosen = 0; compass.punishments = 0; }
}

function __resetSessionState() {
  compassNewImage();
  genePins = defaultHuePin();
  monoMetricsCache = {}; monoOrigMetrics = null; monoBaseCache = null;
  geneIntensity = {}; geneSafePower = {};
  generation = 0; population = []; selected = {};
  killSession = {}; killGen = {};
}

// --- 65^3 LUT cache twins ---------------------------------------------------
function ensureLut65(id, cb) {
  cb = cb || function() {};
  if (genePhase) { cb(null); return; }
  if (!LUTS[id]) { cb(null); return; }
  if (lut65Cache.has(id)) { cb(lut65Cache.get(id)); return; }
  var d = upsample33to65(LUTS[id]);
  lut65Cache.set(id, d);
  cb(d);
}

function ensure65ForGenome(g, done) {
  var ids = [];
  try { activeLutsOf(g).forEach(function(a) { ids.push(a.id); }); } catch (e) {}
  ids.forEach(function(id) {
    if (!lut65Cache.has(id) && LUTS[id]) lut65Cache.set(id, upsample33to65(LUTS[id]));
  });
  if (done) done();
}

function __ensureLut65Sync(id) {
  if (!LUTS[id]) return null;
  if (lut65Cache.has(id)) return lut65Cache.get(id);
  var d = upsample33to65(LUTS[id]);
  lut65Cache.set(id, d);
  return d;
}

// --- punish twin ------------------------------------------------------------
// Node twin of the math inside compassPunishToggle (the DOM half is
// excluded). Punishes a genome's look: moves the compass weights away
// from the genome's whitened reward features. Returns the applied deltas.
function __clearPunished() { punishedRecords = {}; }
function __clearTreeSeen() { treeSeen = {}; }
function __setMapEvals(v) { mapEvals = v; }
function __setMapDupes(v) { mapDupes = v; }
function __setMapRiskDiscards(v) { mapRiskDiscards = v; }
function __setDecayAppliedForGen(v) { decayAppliedForGen = v; }
function __punishLook(g, gridGenomes) {
  var sig = genomeSignature(g);
  var rec = punishedRecords[sig];
  if (rec) {
    for (var id in rec.deltas) compass.w[id] = clampCompassW((compass.w[id] || 0) - rec.deltas[id]);
    delete punishedRecords[sig];
    compass.punishments = Math.max(0, compass.punishments - 1);
    return { undone: true, deltas: rec.deltas };
  }
  var f = rewardFeaturesFor(g);
  if (!f) return null;
  var allF = [];
  for (var ci = 0; ci < gridGenomes.length; ci++) {
    var ff = rewardFeaturesFor(gridGenomes[ci]);
    if (ff) allF.push(ff);
  }
  if (allF.length < 2) return null;
  // Grid means/sds over ALL reward features (population stddev, /N).
  var meansP = {}, sdsP = {};
  REWARD_FEATURES.forEach(function(rf) {
    var m = 0, i;
    for (i = 0; i < allF.length; i++) m += allF[i][rf.id];
    m /= allF.length;
    var v = 0;
    for (i = 0; i < allF.length; i++) { var d = allF[i][rf.id] - m; v += d * d; }
    meansP[rf.id] = m; sdsP[rf.id] = Math.sqrt(v / allF.length);
  });
  var actIdxP = compassActiveIdx();
  function zRowP(ff) {
    return actIdxP.map(function(fi) {
      var rf = REWARD_FEATURES[fi], sd = sdsP[rf.id];
      return sd > 1e-9 ? (ff[rf.id] - meansP[rf.id]) / sd : 0;
    });
  }
  var zPun = zRowP(f);
  var whP = compassWhiten(allF.map(zRowP));
  if (whP) zPun = matVecMul(whP.W, zPun);
  var deltas = {};
  actIdxP.forEach(function(fi, k) {
    var rf = REWARD_FEATURES[fi];
    var z = zPun[k];
    if (Math.abs(z) < 0.03) return;
    var old = compass.w[rf.id] || 0;
    var nw = clampCompassW(old - COMPASS_PUNISH_LR * z);
    if (nw !== old) deltas[rf.id] = nw - old;
    compass.w[rf.id] = nw;
  });
  punishedRecords[sig] = { deltas: deltas, cell: -1 };
  compass.punishments++;
  return { undone: false, deltas: deltas };
}

// --- LUT loading ------------------------------------------------------------
var LUT_PARTS_MD5 = 'b1cf6e4308dcde4a852576ee935fc31f';

function loadLutsFromParts(dir) {
  var crypto = require('crypto');
  var fs = require('fs');
  var path = require('path');
  var buf;
  var joined = path.join(dir, 'luts.bin');
  if (fs.existsSync(joined)) {
    buf = fs.readFileSync(joined);
  } else {
    var bufs = [];
    for (var i = 0; i < 350; i++) {
      bufs.push(fs.readFileSync(path.join(dir, 'luts-part-' + String(i).padStart(3, '0') + '.bin')));
    }
    buf = Buffer.concat(bufs);
  }
  var md5 = crypto.createHash('md5').update(buf).digest('hex');
  if (md5 !== LUT_PARTS_MD5) throw new Error('LUT parts md5 mismatch: got ' + md5 + ', want ' + LUT_PARTS_MD5);
  var per = 33 * 33 * 33 * 3;
  var total = per * LUT_EXT_DEFS.length;
  if (buf.length !== total * 4) throw new Error('LUT data size mismatch: got ' + buf.length + ' bytes, want ' + (total * 4));
  var all;
  if (buf.byteOffset % 4 === 0) {
    all = new Float32Array(buf.buffer, buf.byteOffset, total);
  } else {
    all = new Float32Array(total);
    for (var k = 0; k < total; k++) all[k] = buf.readFloatLE(k * 4);
  }
  LUTS.length = 0;
  for (var j = 0; j < LUT_EXT_DEFS.length; j++) LUTS.push(all.subarray(j * per, (j + 1) * per));
  return { count: LUT_EXT_DEFS.length, md5: md5, bytes: buf.length };
}
