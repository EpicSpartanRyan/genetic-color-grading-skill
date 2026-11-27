---
name: genetic-color-grading
license: MIT
description: Evolutionary color grading of a photo or a video frame — a genetic algorithm explores a 7-step punctual pipeline and 73 curated 3D LUTs, the user picks the winners of each generation, and the run ends with a dithered final image plus a baked 65^3 .cube LUT for DaVinci Resolve. Everything in the pipeline bakes into the .cube. Use when the user asks to grade, enhance, or color-grade an image or a video with this genetic method, to evolve a look over generations, or to bake a .cube from a graded image. Always use the scripts in this skill (scripts/rank-genes.js, evolve.js, bake.js) — never re-implement the pipeline by hand.
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
Video input additionally needs **ffmpeg + ffprobe in PATH** (any ffmpeg
5+; `extract-frames.js` exits with an install hint if they are missing).

## Workflow

All scripts take `--image <photo.png>` (PNG only in v1 — convert first if
needed) and write into an `--out <run-dir>` that holds the whole run.

### 0. Video input (only if the input is a video)

```sh
node scripts/extract-frames.js --video clip.mp4 --out ./run1
```

Writes `frame-1.png` … `frame-4.png` (at 12.5%, 37.5%, 62.5% and 87.5%
of the duration — never the first/last frame, which are often black),
`frames.png` (2×2 contact sheet with numbered badges 1–4) and
`frames.json`. Show the user `frames.png` and ask them to pick a frame
**by number (1–4)**. The chosen frame becomes `--image` for the rest of
the workflow. Grading is done on that frame only — there is **no video
output and no re-encoding**; the deliverable stays the graded image +
baked `.cube`, which the user applies to the video in DaVinci Resolve.

### 0b. How many iterations? (ask BEFORE gene ranking)

Right after the input image/frame is chosen, and **before** running
`rank-genes.js`, ask the user how many generations (iterations) to run.
**Iterations = total generations including Gen 0**: if the user says 3,
the run is Gen 0 → Gen 1 → Gen 2, then bake. Count your `evolve.js`
calls and **stop after that many generations**, then go to bake — do not
ask again per generation, and do not run extra generations "to see".

### 1. Gene phase — rank the LUTs for this image

```sh
node scripts/rank-genes.js --image photo.png --out ./run1
```

Writes `genes.json` (ranked survivors + why each other gene was hidden)
and `genes.png` (contact sheet). Only the **top 6 survivors** by trigger
power reach the user (fewer if fewer survive — never padded). Show the
user `genes.png` and ask them to pick genes **by rank number** — the
sheet never shows LUT names (blind selection: choosing by look only, no
human bias).

### 2. Gen 0 — first population from the chosen genes

```sh
node scripts/evolve.js --image photo.png --out ./run1 --gen 0 \
  --genes ./run1/genes.json --pick 1,3,5
```

`--pick` = the rank numbers the user chose. Writes `gen0.json`,
`gen0.png` (**6 cells, 3×2, all variants — there is no original cell**)
and `state.json` (compass weights, map risk, pins, rates). Show the user
`gen0.png` and ask them to pick winners **by cell number (1–6,
row-major)**.

### 3. Evolve — one generation per user choice

```sh
node scripts/evolve.js --image photo.png --out ./run1 --gen 1 --picks 2,5
node scripts/evolve.js --image photo.png --out ./run1 --gen 2 --picks 3,6 --punish 4
```

`--picks` = winning cell numbers of the previous grid. `--punish <cell>`
casts a look (moves the compass away from it) and excludes it from the
parents. Each run writes `gen<N>.json`, `gen<N>.png` (**6 cells, no
original**) and updates `state.json`. Repeat until the iteration count
from step 0b is reached, then go to bake.

### 4. Bake — final image + .cube

```sh
node scripts/bake.js --image photo.png --genomes ./run1/gen2.json --pick 4 --out ./run1/final
```

Writes `<name>.png` (full resolution, dithered — Floyd-Steinberg by
default, `--dither none|bayer2|bayer4|bayer8|bn256|bn512|fs|hybrid`) and
`<name>.cube` (65³, with the recipe in `#` comments). The pipeline is
punctual-only, so the `.cube` carries the **full recipe** — nothing is
left out. Hand both files to the user; the `.cube` drops straight into
DaVinci Resolve (Project Settings → Color Management → Lookup Tables,
or drag onto a node).

## Human-in-the-loop — HARD RULES

- **Ask the iteration count up front** (step 0b) and stop after that
  many generations. Never run extra generations on your own.
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

- 7-step punctual pipeline, float32 end to end, quantized once at the
  end: Exposición, Balance de blancos, Contraste y curvas, Tone mapping
  (Lineal, Reinhard, ACES, Filmic, Curva S, AgX), Saturación, Hue /
  Color selectivo, then one of the 73 LUTs 3D. See `references/pipeline.md`.
  **There are no spatial steps in the skill** — Dehaze, Retinex,
  Clarity, Laplaciano local and Guided Detail exist only in the web app;
  the skill's engine was built without them, so everything bakes into
  the `.cube`.
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

## Details

- `references/pipeline.md` — the 7 steps, what bakes.
- `references/safe-limits.md` — the 18 indicators and their thresholds.
- `references/compass.md` — the 19 rewards, Bradley-Terry, tempering.
- `references/map-tree.md` — Map risk and Tree proposals/polish.
- `references/lut-formats.md` — the 73-LUT package, the 65³ bake, dithering.
- `scripts/engine.js` — the engine, extracted verbatim from the web app
  (see `scripts/dev/` to regenerate it), **minus the 5 spatial steps**
  (stripped at build time by `scripts/dev/build-engine.js`).
  `scripts/session.js` — shared helpers. `scripts/png.js` — minimal PNG
  codec (stdlib only). `scripts/extract-frames.js` — video frame
  extraction (needs ffmpeg + ffprobe).
