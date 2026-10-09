# Isolated Gemini handwritten-label trial: improvement, not a solved scanner

Reviewed 2026-09-13. One live request; no automatic retry and no production model change.

## Evidence and scope

- Model requested: `gemini-3.8-flash` using the Gemini Interactions API.
- Saved response: `scan-gemini/probe-1789128843733-53d5523e-1865-44e4-85f1-9df0dbfc10b7.json`.
- Four unchanged original-colour crops: `scan-original-colour/crop-8-line.png`,
  `crop-12-line.png`, `crop-24-line.png`, `crop-26-line.png`.
- Request contains no expected answers. The response stores SHA-256 hashes of the crops.
- Compared offline with `test-fixtures/handwriting/pda-q0-q6-ground-truth.json`.
- Baseline: saved `scan-original-colour/probe.json`, attributed to the earlier Luna
  experiment in the diagnostic history. That artifact does not itself record a model
  ID, so its provenance is weaker than the new artifact. It lists the same four paths.
- No new baseline call, no full-diagram scan, no topology test, and no PUSH sample.

## Results

Action words are mapped only to the user's approved equivalent operations for scoring:
`ללא שינוי` / `לל״ש` / `לל"ש` = NONE, `שלוף` = POP, `דחוף` = PUSH.
Letter case and all operands are compared exactly. Missing operands are not filled in.

| Measure | Saved baseline | Gemini |
|---|---:|---:|
| Fully correct rules | 1/4 | 2/4 |
| Correct input/top/action/operand fields | 12/16 | 14/16 |
| Correct operation types | 3/4 | 4/4 |

| Crop / intended connector | Expected | Gemini result | Assessment |
|---|---|---|---|
| 8 / q0 → q1 | a, ⊥, NONE, empty operand | c, ⊥, NONE, empty operand | Input differs from confirmed specification |
| 12 / q1 → q2 | b, ⊥, NONE, empty operand | b, ⊥, NONE, empty operand | Exact |
| 24 / q2 → q6 | c, S, POP, S | c, S, POP, empty operand | Explicit S operand omitted |
| 26 / q2 → q5 | c, A, POP, A | c, A, POP, A | Exact |

The first handwritten input visually resembles c; the expected a comes from the
confirmed reference. Do not silently replace the scanned c with a based on the
known automaton. In crop 24 the second S is visible after the slash; the omission
is not a justified empty operand. Neither issue may be hidden by copying fields.

Self-reported confidence is 0.95 on the wrong first input and 0.93 on the row with
the missing operand. High confidence therefore does not establish correctness.

## Cost

The provider reported 4,630 input tokens, 265 output tokens, 0 thought tokens,
0 cached tokens: 4,895 total. The single-request standard paid estimate is
**$0.00446625** (about 0.45 US cents), using the documented tariff of $0.75/M
input and $3.75/M output through 2026-12-31.

Source: https://ai.google.dev/gemini-api/docs/pricing

This is a token-based estimate, not a verified invoice. A free-tier account may
incur no charge. It is the cost of FOUR LABEL CROPS, not a complete scan. No
claim about whole-diagram cost or general recognition accuracy follows from it.

## Decision

Keep production unchanged. The result supports a controlled larger evaluation,
not deployment: test all 14 labels including PUSH and multiline labels, then
separately assess topology and additional handwriting samples. Obtain agreement
on the next paid trial's scope and budget before making further requests.

Credentials are local-only and are not included in this report or response artifact.
