# Resumed verification and concurrent-work review

## Completed scan recovered — no duplicate paid run

The interrupted diagnostic process completed successfully and its saved output
was inspected after resuming. Source: `WhatsApp Image 2026-09-29 at 00.37.10.jpeg`.
Session: `scan-mulsrsuufrqea`. Evidence: `scan-sept29-live-verify/result.json`.

- Full source frame retained: 900 × 1600, bounds `{x:0,y:0,w:1,h:1}`.
- Seven named states q0–q6, ten connectors, fifteen extracted label rows.
- q6 and the q0 → q6 connector are present. Their label/flag interpretation is
  not fully resolved; presence alone is not a full recognition success.
- q1 → q2: both INPUT values are `b`, but the original result interpreted the
  action words as POP rather than NONE.
- q2 → q1: both INPUT values are `ε`, contradicting the user's explicit `a`
  correction. This remains a failed requirement.
- q3 → q4: the operand written below the action was treated as an extra row.
- q4 self-loop: its primary line crop (`crop-29-line.png`) contains notebook
  ruling rather than the label. Visually inspected locally. This is a crop
  localization failure, not something a better text prompt alone can solve.
- `crop-16-line.png` contains the q2 → q1 input glyph. Consequently the a/ε
  error cannot be attributed solely to the earlier whole-page crop defect.

Recorded estimate: **$0.06023774**, 15 API calls, all `gpt-5.6-luna`.
This uses the application's stored pricing version `2026-08-26`, not a provider
invoice. No additional live request was made while reviewing these results.

**Verdict: the crop-retention fix is verified; complete scan accuracy is not.**

## Claude work inspected

Commits:

- `ccb419e`: checkpoint of the existing multi-stage pipeline and tests.
- `c427e34`: aspect-preserving layout and separation of actionable review items
  from technical diagnostics. Read the implementation and regression tests.

Uncommitted work was preserved:

- Hebrew action-word guide in `server.js`, its PDA-only prompt test, and scripts
  for action probes and label-stage replay.
- Report: `LABEL-ACTION-WORDS-2026-09-29.md`.

The guide's measured improvement is partial, not end-to-end validation. In two
saved new-prompt replays inspected directly, the action score was 8/12 on the
provisional September reference. Both corrected q1 → q2 to NONE, but both still
read `ε` for both q2 → q1 inputs. Missing action operands and wrong crop geometry
remain. The report explicitly does not score unconfirmed September input letters.
The old August full-reference evaluator must not be applied to this different
September automaton as if they were the same drawing.

Potential follow-up concerns from source review (not changed in this verification):

- The new prompt describes a POP operand as "sometimes" present, whereas this
  app requires independent explicit POP-symbol evidence. The validator still
  blocks missing operands; the prompt should not imply that evidence is optional.
- Replay/probe experiment scripts run paid requests by default. The direct
  action-word probe bypasses the normal scan-budget collector, and direct
  `parseLabelsStage` calls do not create the HTTP handler's usage scope. They
  should not be assumed to inherit the application's full per-scan cost guard.
  Neither experimental script was executed during this resumed review.

## Local verification

`npm test` on the combined current working tree: **235 passed, 0 failed**.
Passing these contract/UI tests does not establish handwriting recognition
accuracy. No production code or Claude edits were overwritten during this review.

Next bounded work: validate/recover label localization before OCR (starting with
the blank q4-loop crop and wrapped operand), then evaluate the input-glyph failure
on saved q2 → q1 crops. Keep reference answers out of scanner inputs; do not repeat
full paid scans merely to seek a better random result.
