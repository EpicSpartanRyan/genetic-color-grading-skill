# Map and Tree

## Map — guide over gene combinations

`mapRisk` is a per-gene record `{n, bad}` fed ONLY by real
`evaluateSafeCandidate` verdicts: every time a candidate is judged, each
of its active genes gets `n++`, and `bad++` if the candidate failed.
`mapRiskScore(genome)` = mean over its active genes of `(bad+1)/(n+2)`
(0.3 default for unseen genes).

The map only **pre-filters proposals** so fewer children die in the
judge. It never replaces the 18-indicator judge: every candidate,
including polished ones, still passes the full `evaluateSafeCandidate`,
no exception, and rejections count as kills. The map's discard counter
(`mapRiskDiscards`) counts proposals the map filtered out.

## Tree — directed proposals + polish

Second phase after the manual winner picks. For each child slot:

1. `makeGuidedChild(a, b, rate, safeOn)`: builds a pool of 3×POP_SIZE
   crossover+mutation proposals from the two parents, dedupes them via
   `treeSeen`, sorts by map risk, keeps the K lowest-risk ones.
2. If safe limits are on, each survivor is judged and the best compass
   score wins; then `polishChild` refines the winner by coordinate
   descent (budget 14 steps for large grids / 8 for small, step 0.12
   halving, 2 rounds), still under the judge.
3. New blood (immigrants) stays random: `makeSafeImmigrant` (judged)
   or `randomGenome`, 2 per generation.

If the tree is off, children are plain crossover + mutation
(`makeSafeChild` when safe limits are on, else `crossover` + `mutate` +
pins).

## Elitism and the generation loop (Evolucionar)

1. Survivors (the user's picks, minus punished ones) pass intact,
   cloned as `sobreviviente` / `Elegido`.
2. Mutation rate decays once per Evolucionar click
   (`applyDecayOnce`: 32% → 30% → 28% … by 2%/gen, minimum 0). The
   current generation mutates with the rate captured before the decay.
3. `compassLearn()` runs before breeding; `treeSeen` is forgotten.
4. Children fill up to `POP_SIZE - survivors - immigrants`; immigrants
   (2) are added last; the population is shuffled and the generation
   counter increments. Kill counts for the generation reset; the
   session history is kept.
