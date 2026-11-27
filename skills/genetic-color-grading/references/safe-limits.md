# Safe limits — the 18 indicators

Every candidate genome is judged before the user sees it. The judge
(`evaluateSafeCandidate`) runs the pipeline at 96px; if nothing warns,
it re-checks at 144px. A candidate passes only if no indicator warns.
Gen 0 accepts variants with up to `GEN0_TOLERANCE` (2) warnings, shown
as badges; a degenerate variant (mean luma outside [8, 247], or >90% of
channels at 0 or 255, or NaN) is vetoed outright.

Each indicator has a threshold slider (right = strictest) and two kill
counts (historical/session and current generation). A kill increments
EVERY indicator that triggered. Disabling an indicator stops it from
blocking and stops its amber icon.

## Esenciales (9)

| id | What it watches |
|----|-----------------|
| `clipH` | highlight clipping (channels at 255) |
| `clipL` | shadow clipping (channels at 0) |
| `flatTone` | tonal flattening |
| `localContrast` | local contrast drop (max 30%) |
| `overContrast` | excessive contrast |
| `meanLuma` | mean luminance change (max 25%) |
| `hueShift` | hue shift |
| `flatColor` | colour flattening |
| `overSat` | excessive saturation |

## Opcionales (9)

| id | What it watches |
|----|-----------------|
| `poster` | posterization / banding |
| `gamut` | out-of-gamut (≥0.15%) |
| `neutralTint` | neutral tones with a colour tint |
| `whiteBalance` | white-balance error |
| `gmTint` | green–magenta tint |
| `detailLoss` | detail loss ≥5% in 0–5 / 250–255 |
| `bwPoint` | black/white point error |
| `lowSSIM` | SSIM below threshold (strictest) |
| `gmsd` | gradient magnitude similarity deviation |

## How a step is measured

`analyzePipelineDetailed` runs the genome step by step at 96px (or
144px). Before each step it snapshots the buffer; after `applyOp` it
counts channels that left [0, 255] while they were in-range before
(that is the step's real gamut) and clamps the buffer, exactly as the
real pipeline does, so the next step receives the same input as always.
`stepDiagnostics(before, after, npix, gamutRaw, w, h)` computes the 18
indicators for that step. Warnings are recorded per step
(`map[step] = messages`) and per indicator (`ids`).

## Deliberately NOT indicators

Do not re-propose these unprompted — they were evaluated and rejected:
MS-SSIM, FSIM, edge preservation, sharpness as a blocker, histogram
EMD, histogram entropy, palette size. LPIPS / NIQE / BRISQUE are
excluded (they need AI models).

## Repair

`repairToSafe` softens each offending gene halfway toward its neutral
value (tone-mapping/saturation/hue operators keep their categorical
choice; only their amount is softened), up to 10 iterations. If nothing
passes, the variant converges to the identity genome.
