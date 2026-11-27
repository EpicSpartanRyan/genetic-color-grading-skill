# Genetic Color Grading — agent skill

Evolutionary color grading as an agent skill. A genetic algorithm
explores a 7-step punctual grading pipeline and 73 curated 3D LUTs; the
**user picks the winners of each generation**; the run ends with a
dithered final image plus a baked 65³ `.cube` LUT for DaVinci Resolve.
Everything in the pipeline bakes into the `.cube` — the skill has no
spatial steps. The input can be a photo or a video (4 preview frames;
the user picks one to grade).

The engine is the same code as the [Genetic Color Grading web app](https://genetic-grading.vercel.app/)
(18 safe-limit indicators, 19-reward compass, Map/Tree), extracted
verbatim into Node.js — no web UI, the agent shows the grids and the
user picks by number. The web app has 5 extra spatial steps (Dehaze,
Retinex, Clarity, Laplaciano local, Guided Detail) that cannot bake
into a `.cube`; the skill's engine was built without them.

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
stdlib only, no native dependencies. Video input needs ffmpeg + ffprobe
in PATH (see below).

## Usage

```sh
# 0. Video input (only if the input is a video): 4 preview frames at
#    12.5/37.5/62.5/87.5% of the duration, frames.png is the 2x2 sheet.
#    Show it, let the user pick frame 1-4; that frame is the --image.
node skills/genetic-color-grading/scripts/extract-frames.js --video clip.mp4 --out ./run1

# 0b. Ask the user how many generations (iterations) to run BEFORE
#     ranking genes. Iterations = total generations including Gen 0
#     (3 -> Gen 0, Gen 1, Gen 2, then bake). Stop after that many.

# 1. Rank the LUTs for this photo (blind: the sheet shows numbers, not
#    names). Only the TOP 6 survivors reach the user.
node skills/genetic-color-grading/scripts/rank-genes.js --image photo.png --out ./run1

# 2. Gen 0 from the genes the user picked (rank numbers from genes.png, 1-6)
node skills/genetic-color-grading/scripts/evolve.js --image photo.png --out ./run1 --gen 0 \
  --genes ./run1/genes.json --pick 1,3,5

# 3. Evolve: one generation per user choice (cell numbers 1-6 from gen<N>.png)
node skills/genetic-color-grading/scripts/evolve.js --image photo.png --out ./run1 --gen 1 --picks 2,5
node skills/genetic-color-grading/scripts/evolve.js --image photo.png --out ./run1 --gen 2 --picks 3,6 --punish 4

# 4. Bake the winner: dithered image + 65^3 .cube
node skills/genetic-color-grading/scripts/bake.js --image photo.png \
  --genomes ./run1/gen2.json --pick 4 --out ./run1/final
```

The user is the fitness function: **never auto-pick winners** — stop and
ask after every grid. Every generation grid is 6 variant cells (3×2, no
original cell). The `.cube` drops into DaVinci Resolve (Project
Settings → Color Management → Lookup Tables, or drag onto a node) and
carries the **full recipe** — the skill pipeline is punctual-only, so
nothing is left out of the bake. (There is no video output: grading is
done on the chosen frame; apply the `.cube` to the video in Resolve.)

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
    engine.js       # the engine, extracted verbatim from the web app (generated — see dev/),
                    # minus the 5 spatial steps (stripped at build time)
    session.js      # shared helpers (image loading, rendering, contact sheets, .cube text)
    png.js          # minimal PNG codec (stdlib only)
    extract-frames.js # video input: 4 preview frames + contact sheet (needs ffmpeg/ffprobe)
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
