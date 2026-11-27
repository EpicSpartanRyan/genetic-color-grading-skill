# Pipeline — the 12 steps

The pipeline is a float32 chain, quantized once at the very end. Every
step is a gene (a value in a fixed range, 0–1 unless noted); a genome is
the set of all gene values plus their order. Genomes are rendered with
`processGenomeFd` (float chain, no quantize) and `processGenome`
(float chain + one final quantization, with the chosen dither).

| # | Step | Gene(s) | Notes |
|---|------|---------|-------|
| 1 | Exposición | `exp` | ±EV |
| 2 | Balance de blancos | `wbk` | Kelvin; sub-genes for tint/green-magenta |
| 3 | Dehaze | `dehaze` | **spatial** |
| 4 | Retinex | `retinex` | **spatial** |
| 5 | Contraste y curvas | `curves` | S-curve + lift/gamma/gain/shadows/highlights |
| 6 | Clarity | `clarity` | **spatial** |
| 7 | Tone mapping | `tonemap` + `tonemapAmt` | operator (0 Lineal, 1 Reinhard, 2 ACES, 3 Filmic, 4 Curva S, 5 AgX) + amount. Per-operator gains make all operators land at comparable strength at intensity 1 (Filmic 0.35, AgX 0.55). |
| 8 | Laplaciano local | `loclap` | **spatial** |
| 9 | Guided Detail | `guided` | **spatial** |
| 10 | Saturación | `sat` + `satAmt` | model (CIELCh, OKLCh, HCT, …) + amount |
| 11 | Hue / Color selectivo | `huesel` + `hueselShift` | target hue + shift. Pinned at 0,0 by default on a new image / Gen 0 (unlockable). |
| 12 | LUTs 3D | `lut0`…`lut72` | one gene per LUT, 0–1. The 73 LUTs are the pruned set (see `lut-formats.md`). |

## Punctual vs spatial

- **Puntuales** (point operations): steps 1, 2, 5, 7, 10, 11 and the
  LUTs. Each output pixel depends only on its own input value. They
  **bake into a `.cube`**: the baked LUT is a 65³ grid built by running
  the punctual chain over every node (`buildBakedLut`).
- **Espaciales** (neighbourhood operations): Dehaze, Retinex, Clarity,
  Laplaciano local, Guided Detail. Each output pixel depends on its
  neighbours. They **cannot** bake into a `.cube`: the exported image
  carries them, the baked LUT does not, and the export warns with a
  visible message when any is active (`spatialGenesActive`).

## Gen 0

`softInitialGenome` draws 1–2 pipeline steps with large shifts and the
tone-mapping operator across the full 0–5 range, with LUTs up to 0.95
(tiered: 0.55 / 0.75 / 0.95). `makeSafeInitialGenome` retries up to 14
times and accepts a variant that passes the judge or scores ≤
`GEN0_TOLERANCE` (2) without being degenerate; otherwise it repairs the
best candidate (`repairToSafe`: soften offending genes halfway toward
neutral, up to 10 iterations, else identity). The ancestor clone is
repaired too if it warns. Safe-limits repair attenuates by half instead
of zeroing, so repaired variants stay visible routes.

## Pins

A global pin locks a gene's value for all following generations and
children (enforced after crossover/mutation, in repair, in tree
proposals/polish and in immigrants). Pins are session-only. Hue /
Color selectivo is pinned at 0,0 by default.

## Dither is not a step

Dithering is applied once, at the very end, when quantizing float →
8-bit. Default Floyd-Steinberg. See `lut-formats.md`.
