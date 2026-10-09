# September 29 scan fixes — local verification, no provider calls

## Reproduced failure

Source: `C:/Users/its/Downloads/WhatsApp Image 2026-09-29 at 00.37.10.jpeg` (900 × 1600).

The default brightness-based document detector returned:

```json
{"x":0.2310177705977383,"y":0.13727272727272727,"w":0.7689822294022617,"h":0.5327272727272727}
```

Its 693 × 853 output removes the shaded left side of the notebook, including
q0, q6 and their connector. This was reproduced locally using the real client
image pipeline and visually inspected. It is a concrete preprocessing defect;
it does not establish which preprocessing settings produced an earlier screenshot.

## Changes

- Default upload preserves the full source frame, for topology and label OCR.
- The brightness heuristic remains an **explicitly requested proposal**, never
  an automatic upload crop. The preview requires approval before a cropped scan
  can start. Returning to the full frame restores the original source. A new
  proposal resets approval.
- Spatial single-symbol fields no longer select the first Latin character from
  ambiguous text. Client OCR parsing no longer strips epsilon/separators from
  mixed fields such as `bε`. Literal `a`, `b`, `c`, and `ε` remain distinct.
- Raw evidence remains unchanged; ambiguous/contradictory rules stay blocked.
- Canvas warning markers now also cover visually incomplete rules, not just
  semantic violations.
- Hidden scan-dialog buttons respect their hidden state despite button CSS.

## Verification

- `npm test`: **232 passed, 0 failed**.
- Real-photo offline pipeline: output **900 × 1600**, full-frame bounds
  `{x:0,y:0,w:1,h:1}`; q0/q6 and their connector visible. Measured erased dark
  pixels: **0** (this pixel comparison alone would not detect a cropped margin,
  so frame-bounds checks are now also part of the diagnostic).
- Real browser dialog test (`scripts/check-scan-preview.cjs`): upload uses full
  frame, a proposed crop requires approval, full-frame restoration works, and
  approval resets. The only attempted scan was intercepted locally. No provider
  requests were forwarded.
- New synthetic shaded-page regression reproduces the unsafe heuristic and
  verifies that default preprocessing does not use it.

Private image evidence directories: `scan-sept29-offline` (before) and
`scan-sept29-full-frame` (after). Reproduce the old proposal with the diagnostic
script's `--propose-crop` flag. Do not use `--live` for an offline check.

## Not yet established

No new paid OCR run was performed. These changes do **not** prove full recognition
accuracy or fix a model that confidently misreads `a`/`b` as `ε` in both its
structured fields and visual transcription. They restore lost source evidence
and prevent specific silent conversions. No state names, transitions, or expected
answers from this drawing were added to scanner logic. The production model and
cost settings were not changed.
