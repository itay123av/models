# Targeted continuation: recognition still not solved

Four requests were attempted on three problematic POP label blocks plus the
three-row PUSH control. The same four original-colour crops were used throughout:
23, 27, 29 and 13 from `scan-guard-contract`. Expected semantic answers were
not sent. Existing production scanner settings were not changed.

| Trial | Model / thinking | Outcome | Exact rules | Correct fields | Estimated paid USD |
|---|---|---|---:|---:|---:|
| Literal spatial wording, 4096 output cap | 3.8 Flash / low | HTTP 500 | unavailable | unavailable | unknown |
| One explicitly narrated retry | 3.8 Flash / low | Incomplete JSON | 0/6 | 0/24 | 0.01874100 |
| Same wording, 2400 output cap | 3.6 Flash / minimal | Complete, wrong words | 0/6 | 15/24 | 0.00513225 |
| Add approved vocabulary context | 3.6 Flash / minimal | Complete, wrong S symbols | 3/6 | 21/24 | 0.00519150 |

The last trial's action types and explicit operands are correct, but three
STACK_TOP fields are `$` instead of `S`, including a previously correct PUSH
control. This is not a safe automatic replacement for the previous recognizer.
The earlier a/c ambiguity was outside this targeted batch and is not solved.

The two model profiles must not be combined by choosing whichever field agrees
with the benchmark. That would use known answers, not demonstrate scanning.

## Generation behavior

3.8 Flash used 3,931 thought tokens and 150 output tokens in its second attempt;
the larger output cap did not solve truncation. 3.6 Flash supports minimal
thinking and returned complete JSON with zero reported thought tokens in both
requests, but completeness alone did not establish OCR accuracy.

Official docs checked:
- https://ai.google.dev/gemini-api/docs/thinking
- https://ai.google.dev/gemini-api/docs/pricing

3.8 Flash does not support minimal thinking. The code does not attempt that
unsupported combination. Both tested model tariffs are explicitly allowlisted;
unpriced models and output budgets above 4096 are rejected before network calls.
HTTP failures now record unknown estimated cost rather than suggesting zero.

## Accounting

Known usage in this continuation totals **$0.02906475 estimated**, plus one
HTTP 500 request whose billing is unknown (no usage returned). It is not valid
to claim the failed request was free. Across the Gemini trials recorded so far,
known estimated usage totals **$0.05473725**, plus that unknown request.
These are estimates under the published standard paid tariff, not invoices.

## Evidence

All private raw responses and the offline comparison are under `scan-gemini/`:
- `literal-1789333173047-efa237d5-3894-459c-81bd-1bb5518d4043.json`
- `literal-1789333222328-026c6f63-0a86-413f-94bc-f96d0a39cbfb.json`
- `literal-1789333299464-04657696-28aa-4791-b086-517116fc7a9a.json`
- `literal-1789333366542-60a4a03a-457f-409e-8ced-841ab033a841.json`
- `targeted-review-2026-09-14.json`

No credentials or encoded image payloads are included in this report.

## Next required evidence

Further random full rescans or automatic $→S / c→a substitutions are not
justified. A straight, close, sharply focused photograph of only the paper
would let us distinguish source-resolution/line-interference failures from
model limitations. Preserve the same handwriting; do not rewrite answers just
to make this benchmark pass. Until that source comparison or a separately
validated recognition approach succeeds, the automatic scanner is not complete.
