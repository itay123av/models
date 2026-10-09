# הנוסח המקורי של מדריך מילות הפעולה (2026-09-29, 02:08)

זה הנוסח שנמדד ב-`LABEL-ACTION-WORDS-2026-09-29.md` (פעולה 10,10,10 מתוך 14 בדף המאושר מאוגוסט).
הוא חולץ מהתמליל של הסשן שכתב אותו, מהעריכה הראשונה של `server.js` (‏2026-09-28T23:08:03Z). אחרי העריכה הזו לא נגעו בנוסח עד שינויי Codex.

## ההבדלים מהנוסח הנוכחי (`pda-action-word-guide.cjs`)

1. **שורת POP**:
   - מקורי: `POP = the word "שלוף" (sometimes with an operand: the symbol being popped).`
   - נוכחי: דורש אופרנד נראה בנפרד; אם חסר — POP עם `?`, ולעולם לא להעתיק מ-STACK_TOP.
2. **שורת ההחלטה**:
   - מקורי: `Decision order: (1) Is there a descending final-pe tail at the LEFT end of the word? No tail → NONE form (check for the two looped ל). (2) With a tail, look ONLY at the two rightmost glyphs: two open arches → PUSH; loop + "e"/"C" → POP.`
   - נוכחי: `These shapes are supporting visual cues, not sufficient decision rules. A faint or clipped tail is NOT evidence for NONE. …`

שאר השורות זהות.

## המדידה החוזרת שהוחלטה (2026-10-09)

אחרי ש-Codex יתקן את ה-crops של לולאת q3 ושל ה-label_block-ים: מדידה אחת של הנוסח הנוכחי מול הנוסח הזה.
- 3 ריצות לכל צד, עם `replay-label-stage --live` ו-`REPLAY_SERVER`.
- על ה-crops החדשים, מול הייחוס הסופי של 29.9.

```js
const PDA_ACTION_WORD_GUIDE = [
  'The action vocabulary is CLOSED. There are exactly three meanings:',
  '  PUSH = the word "דחוף" (usually with an operand: the symbol being pushed).',
  '  POP  = the word "שלוף" (sometimes with an operand: the symbol being popped).',
  '  NONE = the two words "ללא שינוי", or their abbreviation "לל״ש" (never an operand).',
  'HOW HEBREW CURSIVE (כתב יד) LOOKS — use letter shapes, not guesses:',
  '  • Hebrew runs RIGHT-TO-LEFT: the FIRST letter of a word is its RIGHTMOST glyph in the image.',
  '  • ש (shin) looks like a Latin "e" or "C" with a small loop. ל (lamed) looks like "δ", "8" or "ʃ" with a loop rising ABOVE the other letters.',
  '  • ח (het) looks like "n". ד (dalet) looks like "ɔ", "3" or a small "Ո". ו (vav) and י (yod) are a short vertical tick "ı" or an apostrophe.',
  '  • א (alef) looks like "k", "lc" or "ic". נ (nun) looks like a narrow "J" or "ɔ". ״ (gershayim) is one or two short strokes above or between letters.',
  '  • ף (final pe) is the LAST letter of both "דחוף" and "שלוף"; it is the LEFTMOST glyph: a small loop whose tail DESCENDS below the baseline, like "ʃ", "ƒ", "ʀ" or "ʀ8".',
  'What the three forms therefore look like when read LEFT-to-RIGHT across the image:',
  '  • "דחוף" and "שלוף" BOTH end in "וף", so their LEFT half looks the same ("ʀ8ı" / "ʃı": the descending final-pe, then a vertical tick). NEVER decide push vs pop from the left half.',
  '  • Decide push vs pop ONLY from the TWO RIGHTMOST glyphs:',
  '      "דחוף" (PUSH) ends with TWO ARCHES open at the bottom — ח then ד — like "ՈՈ", "nn", "Ոɔ" or "n7". No closed loop and no "e"/"C" curve at the right end.',
  '      "שלוף" (POP) ends with a closed LOOP followed by an open curve — ל then ש — like "8C", "δe", "8ɛ" or "8ɾ". The rightmost glyph is an "e"/"C"-shaped ש.',
  '  • "לל״ש" (NONE) → roughly "e״δδ" / "é88": the "e"-shaped ש at the LEFT end with one or two strokes above it, then TWO looped ל at the right. NO descending tail anywhere.',
  '  • "ללא שינוי" (NONE) → two words, roughly "\'ıJ\'e kδδ": a left word whose right end is the "e"-shaped ש, and a right word made of "k" (א) plus two looped ל. NO descending tail.',
  'Decision order: (1) Is there a descending final-pe tail at the LEFT end of the word? No tail → NONE form (check for the two looped ל). (2) With a tail, look ONLY at the two rightmost glyphs: two open arches → PUSH; loop + "e"/"C" → POP.',
  'If the word is cut off, hidden, or does not match any of these shapes, the action is UNKNOWN with low confidence — never pick the closest word to fill the field.',
];
```
