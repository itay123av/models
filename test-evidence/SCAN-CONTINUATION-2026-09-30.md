# Continued scanner fixes — not an accuracy sign-off

## Concurrent work preserved

Reviewed commits through `bf67df3`: the action-word guide/checkpoint now also
contains the server-side crop-provenance changes from the interrupted work;
experiment scripts require an explicit live switch; unresolved-read review and
minimizable review-panel/layout changes are present. No commits were reverted.

## Implemented and tested

- Self-loop context retains the owning circle/connector neighbourhood when the
  original label box misses the label. It does not replace the physical row,
  invent a rule, or change endpoints. Oversized contexts are refused.
- Narrow label blocks get a bounded horizontal context margin, preserving the
  Hebrew action word that was visibly cut off in the September return-edge crop.
  Primary baseline zooms remain vertically bounded.
- OCR row identity (`crop_id`) is separate from the actual pixel source
  (`evidence_crop_id`). Only the original zoom or a unique same-transition
  label-block crop may supply pixels. Original-frame coordinates are mapped
  through that crop; foreign/duplicate crops and invalid coordinates are rejected.
- The client shows the selected evidence image, retains primary-row evidence,
  and preserves both identities through rule import. Display bbox clamping does
  not validate malformed OCR coordinates. Context recovery remains review-only.
- Fixed the new unresolved-read review integration: real imported rule IDs are
  `scan-session:line-id`, while the pending read carries `line-id`. Matching now
  uses the exact session namespace; cross-session/duplicate matches cannot settle
  a pending read. Regression runs merge + actual canvas import, not just a
  hand-built rule with a simplified ID.

## Saved paid experiments from the interrupted continuation

No expected input letters or action answers were supplied to either recognizer.
Evidence directories are under `scan-sept29-live-verify/`.

| Experiment directory | Requests | Estimated USD | Outcome |
| --- | ---: | ---: | --- |
| `local-recheck-1790681570434` | 2 Luna | 0.00724550 | First return input became a; second remained wrong; loop action wrong. |
| `local-recheck-1790682003013` | 2 Luna | 0.00620715 | Crop provenance fixed; first return rule correct; second input c/action POP still wrong; q4 loop PUSH still wrong. |
| `local-recheck-1790682142496` | 1 Gemini | unknown | HTTP 503; no usable OCR, no automatic retry. |

Known estimates total **$0.01345265**, plus the Gemini failure whose usage was
not returned. Estimates are not invoices; the failed call is not claimed free.
These requests were completed before the latest resume. No additional provider
requests were made during the September 30 resume.

The final action-guide clarification (a missing tail does not prove NONE) is
code-tested but has not received a new paid accuracy trial. Do not attribute
the earlier OCR results to that later wording.

## Remaining failures

The q2→q1 second input still disagrees with the user's confirmed `a`, and the
q4-loop action still disagrees with the visible POP word. The wrapped operand
being counted as an extra rule is not yet live-verified as resolved. Unit tests
passing is not proof that the complete photograph is recognized correctly.

Do not repeat full scans, enable expensive fallback, normalize c/ε into a, or
substitute the known diagram to manufacture a passing result. The saved crops
and responses are sufficient to reproduce the remaining failures without a
new paid topology run. `scripts/recheck-local-crops.cjs` defaults to offline
crop generation; `--live` and `--gemini` are explicit paid modes.

## Subsequent requested repair pass

The preceding no-new-provider-calls statement describes the resume, not this
later user-requested repair pass. Two additional bounded requests were made:

- `local-recheck-1790730939805`: one Luna labels call, $0.00298410 estimated.
  The target-row horizontal margin now retains the complete Hebrew word
  (verified in generated `2-line.png`), not merely in the block context. First
  row correct; second still read c/POP instead of confirmed a/visible PUSH.
- `local-recheck-1790731077464`: one Gemini 3.6 Flash block call, $0.00168975
  estimated. Both inputs read a, both actions PUSH with explicit A; first
  stack-top read `$` rather than S. Thus only one of the two complete rules
  was correct. Production provider was not changed based on this small sample.

Total for this subsequent pass: **$0.00467385 estimated**, not an invoice.
No complete topology scan, automatic retry, or expensive-model fallback ran.

Also repaired retry selection: competing concrete OCR readings can no longer
be declared resolved just because one reports a higher confidence. The chosen
observation stays unchanged; disagreements and both raw alternatives are kept
through normalization/import and block automatic execution. An unknown-to-readable
improvement is not incorrectly treated as a concrete contradiction.

Combined regression suite: **245 passed, 0 failed**. Full scan accuracy still
does not pass; this is an explicit remaining recognition limitation, not a
successful end-to-end validation.

## Latest offline review and repairs

Evaluated the already completed paired-original/brightest-channel Gemini trial:
`scan-gemini/blocks-1790797496848-a0defa69-0f70-4f63-94a4-20f42aa48847`.
All three responses are structurally complete, but accuracy is only **7/14
exact rules, 48/56 correct fields** on the August evaluation fixture. Errors
include a→r, S→$, and POP→PUSH, often with confidence 0.95. Its previously
incurred estimate is $0.02165775, not an invoice. This review made no new
provider calls. The paired profile remains experimental, not production.

Fixed two deterministic problems with regression tests:

- Retry merge no longer silently overwrites duplicate physical read identities
  through Map construction. Duplicate/foreign responses retain both original
  response bodies as row evidence and require review instead of laundering the
  ambiguity into a unique high-confidence reading. Source objects stay immutable.
- Wrapped-action-fragment grouping now enforces its documented dominant,
  left-anchored complete-row requirement. Two short right-side fragments alone
  no longer become one purported logical rule. The existing valid wrapped
  operand regression still passes.

Verification: **248 tests passed, zero failures**; `git diff --check` clean
apart from Git line-ending warnings. No paid scan was performed in this repair
pass. Full-photo accuracy, state markers, and the September wrapped-operand
row count remain unverified; these repairs must not be advertised as a complete
OCR solution. Claude's existing UI/review-panel changes were preserved.

## Separate-photo writer-reference experiment (subsequent goal continuation)

Inspected August target crop PNGs 7,25,27,29 and September reference crops
directly. The action words in these August block crops are not cut off. This
isolates at least some failures to recognition, not merely missing pixels.

Prepared `writer-reference-trial.json`: three September images with reviewed
literal examples, tested on three distinct August image crops. User-confirmed
inputs and visually reviewed (not user-confirmed) action operands are explicitly
distinguished in the manifest. Target answers never enter the recognizer.
No reference image is also a target, and sources/hashes are retained. This is
diagnostic writer adaptation, NOT a production scanner or a general accuracy test.

- `scan-gemini/writer-1790798020646-2405beca-3f2a-4ff9-995c-1febfaa12995`:
  1 Gemini 3.6 minimal call, estimated **$0.0062925**. Target q0→q1 read c
  instead of a; q5→q5 and q5→q6 both read PUSH instead of POP. **0/3 exact
  rules, 9/12 fields**. Rejected as an improvement; no production activation.
- Found that the Gemini probes did not include the cursive-letter guidance
  already used by Claude's server change. Extracted that exact guidance into
  `pda-action-word-guide.cjs`, preserving production wording and exports.
  Added an isolated `--guide-only` experiment (no reference images or labels).
- `scan-gemini/writer-1790798128942-984edf36-f7f3-4cb6-8a11-d44b3f7b16e0`:
  the guide-only call returned **HTTP 503**, no usable output or usage. Cost
  is unknown, NOT zero. No automatic retry or stronger-model fallback.

Current continuation spending: $0.0062925 known estimate plus the failed call
with unknown usage. Do not count this as free or as a successful guided test.
All production provider settings remain unchanged. Next accuracy action is
the bounded shared-guide trial, not repeating the failed writer-reference
strategy or a full topology scan. Full-photo/geometry requirements remain open.

## Guided and explicit-resolution comparison

The next continuation inspected current files, then made bounded trials:

| Evidence suffix under scan-gemini | Profile | Outcome | Estimated USD |
| --- | --- | --- | ---: |
| writer-1790798198896-34514806-de30-49ec-8573-382fa18d0069 | 3.6 minimal + shared guide, default resolution | 0/3 exact, 9/12 fields; c for a, two PUSH for POP | 0.00420975 |
| writer-1790798269721-6b498a47-cd0b-4ae2-8bfb-18e6971e2370 | 3.8 low + shared guide | HTTP 503, no usable result | unknown |
| writer-1790798344107-a1f12dbe-2698-49ff-9ec9-da6174495d93 | 3.6 minimal + guide + explicit high resolution | 2/3 exact, 11/12 fields; both POPs correct, a still c | 0.00420975 |
| blocks-1790798379652-521c92c6-3880-40f1-8d6b-f2af4ff82805 | Same explicit-high profile, full August label suite | Two batches returned, third HTTP 503; 7/14 exact, 43/56 fields, 2 unavailable rules | 0.01171950 plus unknown failed-call cost |

Known estimate in this continuation: **$0.020139**, plus two calls with unknown
usage. No complete topology scan or production-provider change. The broad trial
stopped on its failed third call and did not automatically retry.

Google's official Interactions media-resolution documentation, inspected this
turn, uses per-image `resolution: "high"`:
https://ai.google.dev/gemini-api/docs/media-resolution . Earlier probes omitted
this field. Now the experiment can select it explicitly, and run evidence records
each image's resolution. This is a controlled hypothesis test, NOT proof that
provider defaults caused the earlier mistakes: the default/high targeted calls
reported identical token totals, and generation remains stochastic.

Among the twelve returned broader-test rules, five still fail: a→c twice and
S→$ three times. All returned action types were correct in that run, but the
two previously difficult final rules were unavailable in that broader batch.
Do not stitch the earlier successful targeted outputs into the failed batch to
claim a clean full pass. The next work should address literal glyph/ruling
ambiguity and evaluate the September photo, not silently map c→a or $→S.

Added reusable guided-block preparation with explicit bounded profiles and
unit coverage for image resolution, absence of reference answers, unchanged
target identities, and offline behavior. Production remains unchanged until
an adequate accuracy test supports switching it.
