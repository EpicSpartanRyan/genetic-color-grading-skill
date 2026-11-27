# LUT formats — the 73-LUT package, the bake, dithering

## The 73 LUTs

The skill ships 73 curated 3D LUTs (each a 33×33×33 grid = 107,811
float32 values, little-endian, mesh order B outer, G, R fast, channels
R,G,B). They were pruned from a larger set: 200 test images were used to
rank every LUT by mean max safe power, and the weakest were culled. The
7 base LUTs (Vibrante, Blanco y negro, Fría, Vintage, Cine, Cálida,
Pastel) are inside the 73.

Distribution: the 73 grids concatenate to exactly 31,480,812 bytes,
split into 350 parts of 90 KB (`luts-part-000.bin` … `349.bin`),
concatenation md5 `b1cf6e4308dcde4a852576ee935fc31f`. The release asset
`luts.zip` (~18 MB, deflated) contains the 350 parts;
`scripts/setup-luts.js` downloads it, verifies the zip md5 if given,
unpacks the parts, and verifies the joined md5. `loadLutsFromParts`
reads the parts (or a single `luts.bin`) and verifies the md5 again.

## Gene phase — how LUTs become genes

For each LUT, `geneStartIntensity(idx)` binary-searches the lowest
intensity (0.01–1, 12 iterations) that trips any of the 18 safe-limit
indicators — the trigger power. LUTs that never trigger (even at 1.0)
have power `null` and survive all filters. Genes are sorted by trigger
power descending, then filtered in this order:

1. **Monotony filter** (`Filtrar monótonos`, 7 discriminators at 96px:
   hue entropy, distinct colours, a*b* spread, colorfulness, mean
   saturation, dominant-colour growth, local variety). Thresholds are
   adapted per image first (`applyAdaptiveMonoMaxes`: each indicator's
   max becomes the worst real delta across genes, threshold =
   min(default, worst)). A gene that flattens the image on any
   discriminator is hidden — and cannot champion its family.
2. **Family dedup**: each LUT has a 9³ signature (`lutSignature`);
   genes within distance ≤ 15.5 (`SIMILARITY_THRESHOLD`) of an
   already-accepted champion (higher power first) are hidden.
3. **Min-power filter**: the threshold auto-sets to the median of ALL
   finite trigger powers; genes below it are hidden. Null-power genes
   are exempt.
4. **Cap**: only the top 6 survivors by trigger power reach the user
   (fewer if fewer survive — never padded). The rest are hidden with
   reason `top-6-cap`.

Previews render at the trigger power (or at 1.0 with `--previews-100`).

## The 65³ bake

`buildBakedLut(genome)` builds a 65×65×65 LUT by running the punctual
chain over every node (`chainStepsOf` + `evalChainAt`; LUT steps sampled
from the 33³ data; 33³ → 65³ upsampling is 3-pass Catmull-Rom-like
interpolation). Gene-phase renders use the 33³ grids; evolution uses
the 65³ grids (upsampled on demand, in memory only — caching all 73 at
65³ would be ~240 MB).

`.cube` text (same as the web app's export): `TITLE "..."`, `#` comment
lines listing the chain steps in order (LUT name × amount, Exposición
±EV, Balance de blancos K, curvas params, tone mapping name × amount,
saturación model × amount, Hue selectivo °), then `LUT_3D_SIZE 65`,
`DOMAIN_MIN 0.0 0.0 0.0`, `DOMAIN_MAX 1.0 1.0 1.0`, then one `r g b`
line per node (`toFixed(6)`, B outer, G, R fast). 274,625 data lines.

Custom `.cube` files can be added as genes (upload path in the web app);
the CLI v1 uses only the 73 built-ins.

## Dithering

Applied once, at the final float → 8-bit quantization (never between
steps). Options (`--dither`): `none`, `bayer2`, `bayer4`, `bayer8`,
`bn256`, `bn512` (ordered, threshold matrix), `fs` (Floyd-Steinberg,
serpentine, sRGB — **default**), `hybrid` (blue noise 512 ±1/255 on L +
Floyd-Steinberg in Oklab). Measured on a 4K gradient, Floyd-Steinberg
adds ~13.5% distinct colours vs no dithering (Bayer 2×2 ~20%); its
real job is breaking banding in the export, not gaining safe-limit
margin (the judge measures the float pipeline and never sees a
dithered pixel). Theoretical virtual colours with 4×4 local averaging
(N=16): +68,702,699,520 over the 256³ ceiling — theoretical only.
