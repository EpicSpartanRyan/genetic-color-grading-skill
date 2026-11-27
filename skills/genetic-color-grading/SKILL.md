---
name: genetic-color-grading
license: MIT
description: Evolutionary color grading of a photo — a genetic algorithm explores a 12-step grading pipeline and 73 curated 3D LUTs, the user picks the winners of each generation, and the run ends with a dithered final image plus a baked 65^3 .cube LUT for DaVinci Resolve. Use when the user asks to grade, enhance, or color-grade an image with this genetic method, to evolve a look over generations, or to bake a .cube from a graded image. Always use the scripts in this skill (scripts/rank-genes.js, evolve.js, bake.js) — never re-implement the pipeline by hand.
---

# Genetic Color Grading

Evolutionary color grading. The user is the fitness function: the agent
shows candidate looks, the user picks the winners, the algorithm breeds
the next generation from them. End state: a dithered final image and a
baked 65³ `.cube` 3D LUT (for DaVinci Resolve, Premiere, etc.).

## Setup (once per machine)

```sh
node scripts/setup-luts.js --url https://github.com/EpicSpartanRyan/genetic-color-grading-skill/releases/download/v0.1.0/luts.zip --md5 bb8bb1709a825e8ff2d1367a46e38fdf
```

Downloads the LUT data zip (73 LUTs, 350 parts), verifies its md5, unpacks
into `luts/`. The zip URL is the `luts.zip` asset of a GitHub Release of
this repo. Without the LUTs every script refuses to run with a clear error.

Requires Node.js 18+ (stdlib only — no native dependencies, no `sharp`).

## Workflow

All scripts take `--image <photo.png>` (PNG only in v1 — convert first if
needed) and write into an `--out <run-dir>` that holds the whole run.

### 1. Gene phase — rank the LUTs for this image

```sh
node scripts/rank-genes.js --image photo.png --out ./run1
```

Writes `genes.json` (ranked survivors + why each other gene was hidden)
and `genes.png` (contact sheet). Show the user `genes.png` and ask them
to pick genes **by rank number** — the sheet never shows LUT names
(blind selection: choosing by look only, no human bias).

### 2. Gen 0 — first population from the chosen genes

```sh
node scripts/evolve.js --image photo.png --out ./run1 --gen 0 \
  --genes ./run1/genes.json --pick 1,5,9
```

`--pick` = the rank numbers the user chose. Writes `gen0.json`,
`gen0.png` (9 cells: 8 variants + the original in the centre, labelled
ORIG) and `state.json` (compass weights, map risk, pins, rates).
Show the user `gen0.png` and ask them to pick winners **by cell number**
(1–9, row-major; the centre cell is the original and may be picked).

### 3. Evolve — one generation per user choice

```sh
node scripts/evolve.js --image photo.png --out ./run1 --gen 1 --picks 2,7
node scripts/evolve.js --image photo.png --out ./run1 --gen 2 --picks 3,8 --punish 4
```

`--picks` = winning cell numbers of the previous grid. `--punish <cell>`
casts a look (moves the compass away from it) and excludes it from the
parents. Each run writes `gen<N>.json`, `gen<N>.png` and updates
`state.json`. Repeat until the user is happy with a cell.

### 4. Bake — final image + .cube

```sh
node scripts/bake.js --image photo.png --genomes ./run1/gen2.json --pick 4 --out ./run1/final
```

Writes `<name>.png` (full resolution, dithered — Floyd-Steinberg by
default, `--dither none|bayer2|bayer4|bayer8|bn256|bn512|fs|hybrid`) and
`<name>.cube` (65³, with the recipe in `#` comments). Hand both files to
the user; the `.cube` drops straight into DaVinci Resolve
(Project Settings → Color Management → Lookup Tables, or drag onto a node).

## Human-in-the-loop — HARD RULES

- **STOP and ask the user to pick winners before every generation.**
  Never auto-pick winners, never advance a generation on your own guess
  of what looks good. If the user has not picked, do nothing.
- **Never pick for the user, even if they ask you to "choose the best".**
  Ask them to look at the sheet and give cell numbers. (The whole point
  of the tool is the user's eye as the fitness function.)
- **Show the contact sheet, not the names.** Gene previews are numbered,
  never named. Do not tell the user which LUT a cell uses before they
  pick — that would reintroduce the bias the blind selection removes.
  After the run is finished, the `.cube` comments name the recipe.
- **One generation per user decision.** Do not chain generations.

## What the engine does (short version)

- 12-step pipeline, float32 end to end, quantized once at the end:
  Exposición, Balance de blancos, Dehaze, Retinex, Contraste y curvas,
  Clarity, Tone mapping (Lineal, Reinhard, ACES, Filmic, Curva S, AgX),
  Laplaciano local, Guided Detail, Saturación, Hue / Color selectivo,
  then one of the 73 LUTs 3D. See `references/pipeline.md`.
- **18 safe-limit indicators** judge every candidate before the user
  sees it; broken variants are discarded or repaired, never shown.
  See `references/safe-limits.md`.
- **Compass**: session-only reward learning over 19 indicators — it
  learns what the user picks and steers the next generation toward it.
  **There is no neural network**: it is a linear Bradley-Terry model.
  See `references/compass.md`.
- **Map / Tree**: the map pre-filters gene-combination proposals from
  real past verdicts (never replacing the 18-indicator judge); the tree
  proposes guided children and polishes the compass winner by
  coordinate descent. See `references/map-tree.md`.
- **Punctual vs spatial**: the first 7 steps + LUTs are punctual (each
  pixel from its own value only) and bake into the `.cube`. Dehaze,
  Retinex, Clarity, Laplaciano local and Guided Detail are spatial (they
  use the pixel neighbourhood) and **cannot** bake: the exported image
  carries them, the `.cube` does not, and the export warns when any is
  active. See `references/pipeline.md` and `references/lut-formats.md`.

## Details

- `references/pipeline.md` — the 12 steps, punctual vs spatial, what bakes.
- `references/safe-limits.md` — the 18 indicators and their thresholds.
- `references/compass.md` — the 19 rewards, Bradley-Terry, tempering.
- `references/map-tree.md` — Map risk and Tree proposals/polish.
- `references/lut-formats.md` — the 73-LUT package, the 65³ bake, dithering.
- `scripts/engine.js` — the engine, extracted verbatim from the web app
  (see `scripts/dev/` to regenerate it). `scripts/session.js` — shared
  helpers. `scripts/png.js` — minimal PNG codec (stdlib only).
