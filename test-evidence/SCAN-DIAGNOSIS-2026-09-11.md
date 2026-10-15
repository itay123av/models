# Handwritten PDA scan: measured failure, not completed

## Verified fixes

- The old per-pixel blue-rule filter erased 15,513 of 126,092 source pixels
  darker than luminance 170 (12.30%) in the user's notebook frame. It removed
  much of q0/q1 and their labels. Label OCR now receives unmodified original
  colour pixels encoded as PNG. An executable client regression uses blue-cast
  pencil colours that the old implementation erased.
- The block crops clipped wrapped Hebrew words and operands below baselines.
  Context now extends above/below the target block; narrow primary line crops,
  original coordinates, immutable line IDs and rule count remain unchanged.
- The Vision schema called the middle condition `pop_value`; real responses
  often put epsilon in it for PUSH/NONE. The wire field is now `stack_top`,
  explicitly described as the existing top condition for all actions. A
  compatibility adapter maps it without deriving or replacing the POP operand.
- Removed conflicting OCR instructions that simultaneously allowed recovery
  from a block and prohibited using a block instead of a clipped zoom.
- Added a separate accuracy evaluator. It fails on incorrect fields, missing
  rules, extra rules/connectors, wrong markers and unknown state labels. It
  is not used by production code and never fills values from the reference.

## Real API runs

Original: `WhatsApp Image 2026-08-24 at 16.43.17.jpeg` supplied by the user.

| Measurement | After preserving colour | After guard contract/context fix |
|---|---:|---:|
| Correct state names | 7/7 | 7/7 |
| Correct directed connectors | 10/10 | 10/10 |
| Rule count | 14 | 14 |
| Exact complete rules | 0/14 | 3/14 |
| Correct input/top/action/operand fields | 22/56 | 33/56 |
| Accepting markers correct | No | No |
| Visible start markers correct | No | No |
| API calls | 13 | 7 (labels only) |
| Cost estimate from configured prices | $0.05624495 | $0.02500790 |

The second run reused the first run's topology, with a checked identical
normalization frame. It is NOT a second independent end-to-end topology test.
Costs are application estimates, not a verified invoice. Additional small
diagnostic OCR probes incurred separate token usage saved with their results.
Across the two pipeline runs and seven bounded probes, the configured prices
give approximately **$0.106 total**, not an invoice-verified charge. One initial
probe exhausted its 1,600 output tokens in reasoning and produced no text; this
failed paid attempt is included in that estimate rather than omitted.

The photograph has no separate incoming start arrow. q0 is the intended start
in the user's specification, but a scanner cannot infer a visible marker from
that label. The reference now records this distinction. q6 remains the
user-confirmed intended accepting state; the scan's accepting evidence is not
correct yet.

## Controlled OCR experiments

- Three independently generated, clean printed labels (NONE, POP, PUSH) were
  all read correctly by Luna in a bounded local-crop probe.
- On original-colour handwritten crops, Luna confused Hebrew action words and
  input characters even with a much shorter prompt. A Hebrew-only prompt did
  not solve this. Self-reported confidence was sometimes high for wrong words.
- Small GPT-5.4-mini and GPT-5.4 probes also remained incorrect. Neither model
  was enabled as an automatic production fallback; the production model and
  existing cost limits were not changed.
- A diagnostic vocabulary calibration using three action-word crops from the
  user's earlier photo improved some words but did not make the targets exact.
  This is the same writer/drawing, not a held-out generalization test, and is
  deliberately NOT integrated into production or silently used as ground truth.

## Reproduction

`npm test` runs offline logic/regression tests; **212 passed** at this checkpoint.
This number is not a claim that handwritten recognition works.

`npm run test:scan-image -- "path/to/image.jpeg"` checks actual browser canvas
preprocessing without an API call. Requires Playwright. With the bundled runtime,
set `SCAN_NODE_MODULES` to the node_modules directory and `SCAN_CHROME` to Chrome.
Only explicitly adding `--live` sends a paid scan. `SCAN_EVIDENCE_DIR` selects
an output directory. `SCAN_REPLAY_DIR` can reuse saved topology on the same frame.

`npm run test:scan-accuracy -- result.json reference.json report.json` exits 1
on any mismatch. The two measured handwritten results fail as expected.

Local photographs, crops, request/response JSON and probe results are under
ignored `test-evidence/scan-*` directories; no credentials are included in them.

## Remaining blocker

The source-pixel destruction is fixed, but reliable recognition of these
handwritten labels is **not solved**. Do not present the scanner as ready, lower
validation thresholds to hide errors, substitute this known graph for OCR, or
keep charging for full rescans without a testable new hypothesis. Further work
needs a materially different recognition approach, evaluated on held-out writer
samples; a new external OCR provider requires the user's direction/access.
