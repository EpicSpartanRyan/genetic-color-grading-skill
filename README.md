# Genetic Color Grading — agent skill

Evolutionary color grading as an agent skill. A genetic algorithm
explores a 12-step grading pipeline and 73 curated 3D LUTs; the **user
picks the winners of each generation**; the run ends with a dithered
final image plus a baked 65³ `.cube` LUT for DaVinci Resolve.

The engine is the same code as the [Genetic Color Grading web app](https://genetic-grading.vercel.app/)
(12-step pipeline, 18 safe-limit indicators, 19-reward compass,
Map/Tree), extracted verbatim into Node.js — no web UI, the agent shows
the grids and the user picks by number.

## Install

```sh
npx skills genetic-color-grading
```

or with the GitHub CLI:

```sh
gh skill install EpicSpartanRyan/genetic-color-grading-skill
```

Then fetch the LUT data (once per machine):

```sh
node skills/genetic-color-grading/scripts/setup-luts.js --url https://github.com/EpicSpartanRyan/genetic-color-grading-skill/releases/download/v0.1.0/luts.zip --md5 bb8bb1709a825e8ff2d1367a46e38fdf
```

The URL is the `luts.zip` asset of [Release v0.1.0](../../releases/tag/v0.1.0) of this
repo. The script verifies the zip md5 (if you pass `--md5`), unpacks the
350 LUT parts into `skills/genetic-color-grading/luts/` and verifies the
joined md5 (`b1cf6e4308dcde4a852576ee935fc31f`). Requires Node.js 18+;
stdlib only, no native dependencies.

## Usage

```sh
# 1. Rank the LUTs for this photo (blind: the sheet shows numbers, not names)
node skills/genetic-color-grading/scripts/rank-genes.js --image photo.png --out ./run1

# 2. Gen 0 from the genes the user picked (rank numbers from genes.png)
node skills/genetic-color-grading/scripts/evolve.js --image photo.png --out ./run1 --gen 0 \
  --genes ./run1/genes.json --pick 1,5,9

# 3. Evolve: one generation per user choice (cell numbers from gen<N>.png)
node skills/genetic-color-grading/scripts/evolve.js --image photo.png --out ./run1 --gen 1 --picks 2,7
node skills/genetic-color-grading/scripts/evolve.js --image photo.png --out ./run1 --gen 2 --picks 3,8 --punish 4

# 4. Bake the winner: dithered image + 65^3 .cube
node skills/genetic-color-grading/scripts/bake.js --image photo.png \
  --genomes ./run1/gen2.json --pick 4 --out ./run1/final
```

The user is the fitness function: **never auto-pick winners** — stop and
ask after every grid. The `.cube` drops into DaVinci Resolve (Project
Settings → Color Management → Lookup Tables, or drag onto a node). Note:
the `.cube` carries only the punctual steps; the 5 spatial steps (Dehaze,
Retinex, Clarity, Laplaciano local, Guided Detail) are in the exported
image but cannot bake into a LUT, and the export warns when any is
active.

Full instructions for the agent are in
[`skills/genetic-color-grading/SKILL.md`](skills/genetic-color-grading/SKILL.md);
details in `skills/genetic-color-grading/references/`.

## Layout

```
README.md
luts.zip            # LUT distribution package (GitHub Release asset; md5 in luts.zip.md5)
skills/genetic-color-grading/
  SKILL.md          # agent instructions + human-in-the-loop rules
  references/       # pipeline.md, safe-limits.md, compass.md, map-tree.md, lut-formats.md
  scripts/
    engine.js       # the engine, extracted verbatim from the web app (generated — see dev/)
    session.js      # shared helpers (image loading, rendering, contact sheets, .cube text)
    png.js          # minimal PNG codec (stdlib only)
    rank-genes.js   # gene phase: trigger powers, filters, contact sheet
    evolve.js       # Gen 0 + one generation per run (elitism, Tree, immigrants)
    bake.js         # final dithered image + baked 65^3 .cube
    setup-luts.js   # download + verify + unpack the LUT data
    dev/
      build-engine.js        # regenerates engine.js from the web export HTML
      engine-node-section.js # Node twins of the browser-only functions
      engine-raw.js          # the extracted inline script from the web app
```

## Regenerating the engine

After a change in the web app, re-extract and rebuild:

```sh
node skills/genetic-color-grading/scripts/dev/build-engine.js \
  --html /path/to/genetic-color-grading.html
```

This extracts the inline script to `dev/engine-raw.js`, computes the
dependency closure over the pure (non-DOM, non-GPU) functions, appends
the Node twins, and writes `scripts/engine.js`. Then re-run the smoke
tests (rank → Gen 0 → Gen 1 → bake) on a test image before publishing.

## License

MIT. See [LICENSE](LICENSE).
