# Hebrew action words in label OCR: letter-shape guide

## Diagnosis

On both handwritten PDA sheets, the action word was the dominant label error.
The stack-top field was already correct on 26 of 26 rules.

- 2026-09-29 sheet: the writer abbreviates "ללא שינוי" as **לל״ש**. In cursive
  it looks like `é88`. The scan read it as **שלוף** (POP). Two POP words were
  read as **דחוף** (PUSH).
- 2026-08-24 sheet (user-confirmed ground truth): "ללא שינוי" written in full
  was read as POP three times and as PUSH once. POP was read as PUSH three times.

The prompt listed the vocabulary, but it said nothing about how these words
look in Hebrew cursive. The label stage also reads one transition at a time.

## Change

`PDA_ACTION_WORD_GUIDE` in `server.js` is added to PDA label-stage prompts
only. TM and FA prompts are unchanged. It is general Hebrew-cursive knowledge,
not samples from this writer and not exercise answers. It covers:

- right-to-left letter order and the shape of each letter;
- a decision order: first check whether the word has a descending final ף tail;
  then decide PUSH vs POP only from the two rightmost glyphs (two open arches ח ד
  vs a loop and an "e"-shaped ל ש);
- a cut-off or unmatched word stays UNKNOWN.

No extra API calls are made. Run blocking and review rules are unchanged.

## Measurement

Reference answers were read only after each model answer, to score it.

Replays of the production label stage used the saved crops and topology of
each scan (`scripts/replay-label-stage.cjs`). Each configuration ran three
times. "Old" is the prompt at commit `c427e34`; the first old run is the
original scan's saved answer.

| Sheet | Prompt | Action correct (3 runs) | Confident wrong actions (conf ≥ 0.75) |
|---|---|---|---|
| 2026-08-24 (confirmed) | old | 7, 4, 8 of 14 | 3, 7, 3 |
| 2026-08-24 (confirmed) | new | **10, 10, 10** of 14 | 0, 0, 1 |
| 2026-09-29 (provisional) | old | 4, 5, 5 of 12 | 6, 4, 2 |
| 2026-09-29 (provisional) | new | **7, 8, 8** of 12 | 0, 0, 1 |

Other fields with the new prompt on the confirmed sheet:

- input: 8/14 in all three runs, versus 4, 6 and 9 with the old prompt;
- operand: 9/14 in all three runs;
- stack top: 14/14.

Almost every remaining action error is NONE read as PUSH or POP, at low
confidence, so it is flagged for review.

### Rejected hypothesis: whole-sheet word grouping

One request with all line crops of a sheet asked the model to group repeated
word shapes. On the development sheet it helped: 11/12. On the confirmed sheet
it merged every NONE and PUSH word into one "דחוף" group at confidence
0.87–0.89, scoring 7/14. A single wrong group decision flips many rules at
once, so this was not integrated.

Repeated focused classification (`scripts/probe-action-words.cjs isolated`)
was also unstable on the confirmed sheet: 11, 9 and 4 of 14. The 4/14 run read
"ללא שינוי" as POP at confidence 0.80–0.84. The model's own confidence is
therefore not proof. The production replays above are the evidence for the
change.

## Limits

- Two sheets, one writer. This is not a held-out-writer test.
- The 2026-09-29 reference is the assistant's reading of the photo and is not
  yet confirmed by the user. Its input letters (a vs ε) are not scored.
- Not addressed:
  - input-glyph confusion (the writer's `a`/`c` read as ε);
  - crop geometry: a q4 loop label fell outside its crop, an operand written
    under the word became a separate line, and the q6 self-loop was not
    detected by topology.
- Estimated cost of all experiments on 2026-09-29: about $0.43. This is
  $0.39 of logged label-stage calls plus about $0.04 of direct probes. These
  are application price estimates, not an invoice.

Private evidence (crops, raw answers, reference files) is under the ignored
`scan-guard-contract/` and `scan-sept29-live-verify/` directories.
