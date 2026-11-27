# Compass — session-only reward learning

The compass learns the user's taste from their picks, one generation at
a time, and steers the next generation toward it. **There is no neural
network.** It is a linear reward model: 19 weights, one per reward
indicator, learned by Bradley-Terry over picked vs not-picked variants.

## The 19 rewards

`rms`, `michelson`, `lumaEnt`, `cct`, `sharp`, `abSpread`, `hueEnt`,
`palette`, `meanSat`, `colorfulness`, `dominant`, `localVar`, `tintA`,
`tintB`, `hueHarmony`, `shadowBalance`, `satPeaks`, `vibrance`,
`chromaSmooth`. Each is measured at 96px from the genome's rendered
result (`rewardFeaturesCompute`). Each reward row has its own ignore
checkbox: ignored rewards are excluded from scoring, learning,
punishment and top-driver lists (their weight is kept).

## Learning (`compassLearn`)

Runs once per Evolucionar click, before breeding, on the grid the user
just picked from:

1. Per-generation z-scores of the 19 rewards across the grid.
2. ZCA whitening of the z-rows (shrinkage 0.75/0.25, eigenvalue floor
   0.08) so correlated rewards do not double-count.
3. Bradley-Terry gradient: picked variants should score above
   not-picked ones. The score is tempered — divided by
   `BT_TEMP = sqrt(active reward count)` — so the weights stay small
   and move visibly from the first generation (before tempering, the
   summed score saturated and weights looked dead).
4. Learning rate 0.3, decay 15% per generation (`COMPASS_DECAY = 0.85`),
   weights capped at ±5 (`COMPASS_W_MAX`). Bars rescaled to ±1, weights
   shown to 2 decimals.

`compassScore(genome)` = weighted mean of the whitened z-features ×
`compass.force` (guide-strength slider, default 0.7). The Tree uses it
to rank guided proposals; the grid does not sort by it — the user
still picks by eye.

## Punish ("Castigar look")

Right-clicking a variant (CLI: `--punish <cell>`) moves the weights
AWAY from that look: same z-scoring and whitening, but over the grid's
own features, with punish learning rate 1.2 (4× the learn rate) and a
|z| < 0.03 dead zone. The deltas are recorded, so calling it again on
the same look undoes the punishment exactly. A punished variant cannot
be a parent in that generation.

## Scope and persistence

- Session-only by default: a new image resets the compass to zero.
- `Recordar gustos` (opt-in, off by default) persists weights across
  images; its hover warns it can limit creativity.
- The compass never overrides the safe limits: a high-scoring candidate
  that trips an indicator is still discarded by the judge.
