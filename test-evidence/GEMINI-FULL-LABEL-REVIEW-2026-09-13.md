# Gemini: all 14 handwritten labels, bounded trial

## Scope

Three live Gemini 3.8 Flash requests; no retries, no fallback and no production
scanner changes. Ten original-colour label-block crops from the saved
`scan-guard-contract` run were sent in batches of 4, 4 and 2 images. There were
6, 6 and 2 logical rows respectively. Geometry/counts came from that saved
scan, not from the expected semantic rules. No reference answers were sent.

This tests OCR on existing block crops, NOT end-to-end topology recognition.
Compared with the preceding four-crop probe, the crops and multiline prompt
changed. The difference is not attributable solely to the model.

Evidence directory:
`scan-gemini/blocks-1789332630683-93a0b970-cb99-42ab-9469-68e7ffd7034c/`

## Measured result

- 9/14 complete rules correct.
- 45/56 input/top/action/operand fields correct.
- 12/14 rows returned in complete validated responses; two unavailable because
  their entire batch response was truncated.
- All three PUSH alternatives were correct, including pushing A over S and S
  over the bottom marker.
- Both two-row NONE blocks were correct; no rows were merged or executed in sequence.
- Remaining completed-response errors: a read as c on q0→q1 and the q1 loop;
  explicit POP operand S omitted on q2→q6.
- The two q5 rules were not recoverable from a complete response. Their batch
  was rejected atomically; the beginning of its JSON was not salvaged as truth.

The a/c score uses the confirmed reference. The handwritten input resembles c,
so this cannot be solved honestly by a global c→a substitution. No reference
values have been inserted into the observed data.

## Failure and cost

| Batch | Input tokens | Output tokens | Thought tokens | Result | Estimated paid USD |
|---|---:|---:|---:|---|---:|
| 1 | 4,650 | 453 | 0 | Complete | 0.00518625 |
| 2 | 4,701 | 447 | 0 | Complete | 0.00520200 |
| 3 | 2,494 | 86 | 2,300 | Incomplete JSON | 0.01081800 |
| Total | 11,845 | 986 | 2,300 | Not fully correct | **0.02120625** |

The failed request spent almost its whole 2,400-token generation allowance on
reasoning. `thinking_level: low` did not guarantee space for a complete answer.
The incomplete fragment also contained a wrong operation; increasing the output
limit alone would not demonstrate correct recognition.

Costs use the documented standard paid tariff through 2026-12-31:
https://ai.google.dev/gemini-api/docs/pricing

These are token-based estimates, not verified invoices. All failed usage is
included. Including the earlier four-crop Gemini probe, the two trials total
**$0.02567250** estimated. The local $0.10 estimate budget and $0.03 per-call
reservation are not a Google-enforced billing cap. Exactly three requests were
made for this trial.

## Reproduction and decision

- `node scripts/probe-gemini-blocks.cjs --dry-run`: no network; validates crops,
  reports the selected blocks/counts and planned call count.
- `node scripts/probe-gemini-blocks.cjs --live`: makes a new paid trial. Do not
  rerun merely to obtain a lucky result.
- `node scripts/evaluate-gemini-blocks.cjs <evidence-directory>`: offline
  comparison. Returns failure here because the trial is not exact. It preserves
  missing rows, extra rows, letter case and explicit operands. Expected rules
  are loaded only by this separate evaluator.

Keep production unchanged. The cheaper model shows useful recognition, but
this trial does not establish a reliable automatic scanner. A next technical
experiment should isolate the three difficult POP labels and generation-budget
behavior, without rescanning already-correct labels. Ambiguous a/c handwriting
needs honest user review or clearer independent source evidence, not silent
semantic correction. No further provider calls were made in this trial.
