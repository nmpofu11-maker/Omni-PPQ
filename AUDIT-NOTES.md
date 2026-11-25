# Omni-PPQ audit & fix notes

## Fixed
- **Calibration direction/consistency**: one shared binary temperature transform (`temperatureScaleBinary`) used by both trainer and serving path; 1X2 via one-vs-rest + renormalisation. Previously train/serve gamma acted in opposite directions for p>0.5.
- **Selection bias (winner's curse)**: the learner now trains only on unconditional, raw (pre-calibration) `model_only` snapshots, not on value alerts chosen because the model disagreed with the market.
- **Statistics**: match-clustered standard errors + z-test, expanding-window walk-forward by match, out-of-sample Brier/log loss, per-sport promotion. False-promotion rate ≤5% over 150 seeded trials; a known 1.5x overconfidence is recovered.
- **Security**: admin-gated model-control endpoints (`ADMIN_TOKEN`; closed in production without it; loopback-only in dev), `TRUST_PROXY` support so rate limits key on real client IPs.
- **Concurrency**: lost-update races in place-bet and settle fixed (re-read store after awaits, mutate synchronously).
- **Performance**: ledger read cache keyed on mtime/size; batched ledger appends.
- Tests: 120 passing (new: modelControl, modelSnapshots, rewritten adaptiveController).

## Also fixed (second pass)
- **Market shrinkage**: value evaluation blends the model with the de-vigged market price in logit space (default weights by evidence tier; `modelWeight` option or `MODEL_MARKET_WEIGHT` env; 1 = off). Alerts carry both the priced probability (`fairProb`) and the raw model probability (`modelProbability`).
- **NFL key numbers**: integer spread/push probabilities use a discrete margin distribution with 3/7/6/10/14 mass (mean-preserving, fading as the game is played).
- **Baseball base-out state**: scraper reads ESPN `situation`; remaining runs use a run-expectancy table for the current half-inning. Falls back to the progress model if state is unavailable.
- **`clamp(NaN)`** now returns the range midpoint; Kelly/EV paths explicitly reject non-finite inputs.
- **Basketball/football box-score double counting**: count differentials are converted to rates and shrunk by an evidence weight, and capped.
- **Ratings priors**: Elo ratings learned from finished matches (persisted in the store as `ratings`), blended into the pre-game prior in proportion to games played.
- **Records**: soccer parsed as W-D-L, hockey W-L-OTL.
- Tests: 132 passing.

## Caveats
- The soccer W-D-L layout and ESPN `situation` field are based on ESPN's documented conventions; I could not call the live feed from this environment, so confirm against one live payload.
- Key-number multipliers, RE24 values, Elo K/home-advantage and default shrink weights are standard published-style constants, not fitted to your data. The ledger snapshots will let you tune them once enough settled results exist.
