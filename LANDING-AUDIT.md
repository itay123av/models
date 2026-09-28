# ביקורת עומק — דף הנחיתה `landing-v2.html`

תאריך: 23 ביולי 2026. מצב עבודה: **קריאה בלבד** — לא בוצע שום שינוי בקוד. הפרומפט ל־Claude Code בסוף המסמך הוא החלק היחיד שמבקש יישום.

הדוח מתבסס אך ורק על `landing-v2.html` (650 שורות) ועל `server.js` (1052 שורות) כמקור לניתוב ואבטחה, ועל הסיכום שסיפקת כמקור אמת לגבי יכולות המוצר. מספרי השורות מפנים ל־`landing-v2.html` המקורי.

**החלטות שכבר התקבלו ומוטמעות בהמלצות ובפרומפט:**
- **שפה:** הדף נשאר אנגלית LTR.
- **CTA ראשי:** כפתור שמקשר ל־`automata.html` (האפליקציה האמיתית).

---

## 1. Executive verdict

**מצב הדף:** `landing-v2.html` הוא בסיס טוב ואמין — עיצוב לבן/אקדמי נקי, טון כן, אין מדדים מפוברקים, ומיקוד ב"private alpha". הוא קרוב לרמת הבשלות האמיתית של המוצר. אבל הוא **עדיין לא מוכן לפרסום** בגלל שלוש בעיות אמון וכמה פערים.

**האם מוכן לפרסום?** לא כמו שהוא — צריך סבב תיקוני אמינות ממוקד. אחריו כן.

**החוזקה המרכזית:** אמינות ואופי. הטון ("built between office hours"), ה"honest columns" (מה קורא / מה מקבל), וה־before/after הנקי משדרים כלי אמיתי ולא "AI SaaS template". שווה לשמר את כל הרוח הזאת.

**הבעיה המרכזית:** overclaim נקודתי שסותר את המוצר האמיתי. הדף (א) מבטיח JFLAP `.jff` שלא קיים, (ב) מציג סימולטור **hard-coded** כ"the actual interface", (ג) טוען "editable — every state and edge" בזמן שבפועל אי אפשר לשנות שם מצב או מצב התחלתי דרך ה־UI. בנוסף הוא **מציג פחות מדי**: מזכיר רק DFA/NFA, בזמן שהמוצר תומך ב־5 סוגים (DFA/NFA/DPDA/NPDA/TM).

**שלושת השינויים החשובים ביותר:**
1. **הסר כל טענה לא ממומשת** — JFLAP/`.jff`, "every state editable", ותקן את "the actual interface" (זה DFA hard-coded). החלף את הטפסים המזויפים ב־CTA אמיתי שמקשר ל־`automata.html`.
2. **הצג את הנכס המלא** — הוסף סקשן "Supported models" עם כל 5 הסוגים; זה הבידול הכי חזק שלך והדף מסתיר אותו.
3. **הוסף שכבת אמון** — גילוי פרטיות/local-first (תמונות→OpenAI, מודלים מקומיים) + FAQ שעונה על העלות, מפתח ה־OpenAI והדיוק. ותקן נגישות בסיסית (skip-link, ניגודיות).

---

## 2. Scorecard (מצב נוכחי של `landing-v2.html`)

ציון 0–10 והסבר קצר.

| תחום | ציון | הסבר |
|---|---|---|
| Positioning | 6 | ממקד ב־alpha אקדמי אמיתי, אבל מצטמצם ל־DFA/NFA בלבד ומסתיר את PDA/TM |
| Message clarity | 8 | "Draw it on paper. Run it on screen." — חד ומיידי |
| Information architecture | 8 | קצר וזורם: hero → why → how → demo → signup |
| Copywriting | 8 | טון כן ומדויק; מעט overclaims נקודתיים |
| Visual design | 7 | נקי, אמין, אקדמי; פחות "וואו" אך זה מתאים לכלי |
| Conversion | 5 | הטופס מזייף הצלחה; אין מסלול אמיתי לאפליקציה |
| Product credibility | 5 | JFLAP / "the actual interface" / "every state editable" — טענות שלא מתקיימות |
| Trust | 6 | honest cols עוזרות; אך עדיין overclaims ואין גילוי פרטיות |
| Responsive quality | 8 | breakpoints סבירים (800/640/420); מבנה פשוט = פחות סיכון |
| Accessibility | 5 | אין skip-link; `--faint #9ca3af` נכשל בניגודיות; כפתורי sidebar דקורטיביים |
| SEO | 4 | יש title+description; אין og/twitter/canonical |
| Performance | 7 | קל; 4 גופנים אבל בלי אנימציות infinite |
| Technical quality | 7 | קוד vanilla נקי, single-file |
| Alignment with real product | 5 | לא מקשר לאפליקציה; מציג 2 מתוך 5 סוגים; כמה overclaims |

---

## 3. מיצוב, קהל יעד ומותג

**קהל יעד ראשי מומלץ:** סטודנטים למדעי המחשב + צוותי הוראה (TAs/מרצים) — האנשים שמשרטטים אוטומטים וצריכים לאמת אותם. זה בדיוק מה שהדף כבר מכוון אליו ("free for course staff"). **שמור על המיקוד הזה.**
**קהלים משניים:** מהנדסי מערכות/FSM — אפשר לרמוז, אבל אל תיתן לדף לנסות לדבר לכולם. `landing-v2.html` עושה את זה נכון כבר עכשיו (מזכיר "systems engineers" בעדינות בסוף).

**מיצוב מומלץ:** "סטודיו מקומי לבנייה, סריקה והרצה של אוטומטים" — לא "פלטפורמת grading" ולא "Enterprise". זה תואם למוצר הקיים היום. הסריקה ב־AI היא פיצ'ר חזק, לא כל הסיפור; הבידול האמיתי הוא **גרף אינטראקטיבי + 5 מנועי סימולציה + human-in-the-loop + local-first**.

**מותג:** השם בדף הוא `automata.vision`; באפליקציה `מודלים חישוביים`. יש כאן חוסר עקביות.
- המלצה: מאחר שהוחלט שהדף אנגלי, השאר `automata.vision` כשם הראשי בדף (נקי, תואם דומיין). `[NEEDS OWNER INPUT]`: כדאי להחליט אם לאחד גם את שם האפליקציה, או להשאיר "מודלים חישוביים" כשם העברי המקומי. לכל הפחות — favicon, title ו־wordmark צריכים להיות עקביים.
- Tagline מומלץ: "Draw it on paper. Run it on screen." (כבר קיים — שמור).

---

## 4. Audit מלמעלה למטה (`landing-v2.html`)

| Section (שורות) | מה קיים | הבעיה | השפעה | ההמלצה המדויקת | קופי מוצע | ויזואל מוצע | Priority | Effort |
|---|---|---|---|---|---|---|---|---|
| `<head>` (1–11) | title + description, בלי og/canonical | description אומר "handwritten DFA or NFA" ו"Built by ex-TAs"; אין og/twitter/canonical | SEO + persona לא מאומת | עדכן description ל־5 סוגים בלי "ex-TAs"; הוסף og/twitter/canonical | ראה §9 | — | P1 | קטן |
| Nav (246–262) | wordmark + 3 עוגנים + CTA "get early access →" | `href="#"` על ה־wordmark (248) = קישור מת; ב־`max-width:640px` (53) כל הקישורים חוץ מ־CTA **נעלמים** ואין אליהם גישה במובייל | ניווט חסר במובייל; קישור מת | wordmark → `#top` (הוסף `id="top"`); השאר את 3 העוגנים נגישים במובייל (אל תסתיר), הדק ריווח | — | לוגו + 3 עוגנים + CTA | P2 | בינוני |
| Hero — persona (269) | "private alpha — built by two ex-TAs and a systems engineer" | טענת persona לא מאומתת | אמינות אם לא נכון | אמת, או רכך ל"built by a small team, in and out of office hours" + הערת `[NEEDS OWNER INPUT]` | ראה §9 | — | P1 | קטן |
| Hero — sub (271) | "Stop manually testing automata or fighting with JFLAP..." | ניסוח טוב; אך ממקד ב־DFA/NFA בלבד | תת־מכירה | הרחב לרמוז ל־PDA/TM ("finite automata, pushdown, Turing") | ראה §9 | — | P2 | קטן |
| Hero — CTA/form (272–280) | email form + "You're on the list" | הטופס **מזייף הצלחה** בלי לשלוח כלום (JS 537–547) | conversion + אמינות | החלף ב־CTA אמיתי: כפתור "Open the studio" ל־`automata.html` + כפתור משני "See how it works" (#how); הסר את ה־fake success | ראה §9 | — | P0 | בינוני |
| Hero — microcopy (281) | "free for course staff · works in the browser · imports .jff" | "imports .jff" = JFLAP לא ממומש | טענה שקרית | הסר ".jff"; החלף ב"runs locally · JSON export/import" | "free for course staff · runs locally in your browser · JSON export/import" | — | P0 | קטן |
| Hero — before/after figure (284–369) | photo→clean graph, "accepted 1010" | מצוין; אמיתי בתחושתו | — | **שמור** — נכס חזק | — | שמור | — | — |
| Why (374–402) | narrative + honest cols | שורת "JFLAP (.jff) import and export" (397) שקרית; "an editable machine — every state and edge" (395) overclaim (אי אפשר rename state/start ב־UI) | אמון | הסר שורת JFLAP; שנה ל"every transition and symbol — not a picture" | ראה §9 | שמור honest cols | P0 | קטן |
| How it works (405–427) | 3 שלבים snap/sandbox/verify | "every edge is editable if we got one wrong" (413) — נכון למעברים, לא לשמות מצב | קל | דייק ל"every transition and symbol is editable" | ראה §9 | שמור | P2 | קטן |
| **Supported models (חסר)** | — | הדף מזכיר רק DFA/NFA; המוצר תומך ב־5 | תת־מכירה של הבידול | **הוסף סקשן חדש** אחרי How it works, לפני Demo | ראה §9 | 5 כרטיסים עם דיאגרמה זעירה לכל סוג | P1 | בינוני |
| Demo (430–500) | "This is the actual interface, running... in your browser" + terminal | הסימולטור **hard-coded** (JS 559–567), לא האפליקציה; ה־sidebar וה־upload דקורטיביים; ה־caption (498) מסויג אבל הכותרת סותרת | מטעה (placeholder כמוצר) | שנה את המשפט המטעה ל"An interactive demo of the same idea"; הוסף כפתור "Open the full studio" → `automata.html` מתחת ל־mockup; הפוך את כפתורי ה־sidebar הלא־פעילים ללא־אינטראקטיביים | ראה §9 | שמור את ה־mockup; הוסף CTA | P0 | בינוני |
| Demo — sidebar files (444–459) | 3 `<button class="file">` שלא עושים כלום | נראים לחיצים, no-op | UX/נגישות | הפוך ל־`<div>` (או `aria-hidden` על הדקורטיביים); השאר רק את הפעיל עם `aria-current` | — | — | P2 | קטן |
| Signup / footer CTA (503–519) | email form שני + "fine-tuning the vision model" | טופס מזויף; כפילות עם hero | conversion + אמינות | החלף ב־CTA ראשי "Open the studio" → `automata.html`; אופציונלי `mailto:` לעדכונים | ראה §9 | — | P0 | בינוני |
| **Privacy / local-first (חסר)** | — | תמונות נשלחות ל־OpenAI; אין גילוי | סיכון אמון/פרטיות | **הוסף סקשן** אחרי Demo, לפני CTA סופי | ראה §9 | אייקון מנעול/מחשב | P1 | קטן |
| **FAQ (חסר)** | — | אין מענה להתנגדויות (עלות, מפתח OpenAI, פרטיות, דיוק, סוגים, offline) | conversion | **הוסף FAQ** (accordion `<details>`) | ראה §9 | accordion נגיש | P1 | בינוני |
| Footer (523–533) | copyright + 4 קישורים + mailto | תקין; `#why/#how/#demo` ו־`mailto` עובדים | — | שמור; הוסף קישור Privacy אם תכתוב מדיניות | — | — | P3 | קטן |
| CSS — `--faint` (~21) | `#9ca3af` לטקסט אמיתי | ניגודיות ~2.5:1 על לבן — נכשל WCAG AA (form-note, fig-caption, foot, step-num, sidebar-h) | נגישות | העלה `--faint` ל־`#6b7280` לפחות (או צור `--faint-decor` נפרד לשימוש דקורטיבי בלבד) | — | — | P1 | קטן |
| CSS — fonts (11) | Source Serif 4, Inter, JetBrains Mono, Caveat | Caveat בשימוש (marker/note-sig) אך 4 משפחות = משקל | ביצועים קל | שקול לצמצם משקלים; לא קריטי | — | — | P3 | קטן |

---

## 5. טבלת טענות מול מציאות (`landing-v2.html`)

מקור אמת: הסיכום + `server.js`. סטטוסים: **ממומש** / **חלקי** / **roadmap** / **לא מבוסס**.

| הטענה | איפה (שורה) | סטטוס | הראיה | המלצה |
|---|---|---|---|---|
| "run input strings to verify transitions" | 271, 422 | **ממומש** | מנועי סימולציה בסיכום | שמור, הדגש |
| DFA / NFA מפענוח שרטוט | 271, 387 | **ממומש** | `/api/parse-diagram` + מנועי DFA/NFA | שמור |
| NFA + מעברי ε | (לא מפורש) | **ממומש** | nfaClosure | הדגש כנכס |
| DPDA / NPDA / TM | — | **ממומש (לא מוצג)** | מנועי PDA/TM + prompt TM ב־server (736–811) | **הוסף לדף** — בידול חבוי |
| "reads... double circles, initial arrows, multi-symbol labels" | 388 | **ממומש** | prompt זיהוי בסיכום | שמור |
| "rushed handwriting, marker smudge, off-angle photos" | 389 | **ממומש חלקית** | עובד אך משתנה בין הרצות (10/9/10 מעברים בדו״ח) | שמור, אל תבטיח דיוק מוחלט |
| "an editable machine — every state and edge" | 395 | **חלקי** | מעברים/סמלים כן; rename state / start-state **לא** ב־UI | **רכך** ל"every transition and symbol" |
| "step-by-step string verification with a trace" | 396, 423 | **ממומש** | trace + step קדימה/אחורה | שמור |
| "JFLAP (.jff) import and export" | 281, 397 | **לא ממומש** | JFLAP לא קיים (סיכום) | **הסר מכל מקום** |
| "plus plain JSON" | 397 | **ממומש** | ייצוא/ייבוא JSON | **שמור — זו טענה אמיתית** |
| "This is the actual interface, running... in your browser" | 434 | **לא מבוסס** | סימולטור hard-coded (JS 559–567), לא האפליקציה | **תקן** ל"interactive demo" + קישור לאפליקציה |
| "built by two ex-TAs and a systems engineer" | 269 | **`[NEEDS OWNER INPUT]`** | לא ניתן לאימות | אמת או רכך |
| "free for course staff" | 281, 517 | **`[NEEDS OWNER INPUT]`** | החלטת תמחור | אשר או סמן כברירת מחדל |
| local-first / localStorage | (לא מוזכר) | **ממומש** | localStorage בסיכום | **הוסף — נכס** |
| הסריקה offline | (משתמע מ"works in the browser") | **לא נכון** | סריקה שולחת ל־OpenAI, דורשת מפתח | **הבהר** שהסריקה אינה offline |

**כלל אצבע:** כל טענה בלי ראיה בקוד/בדו״ח — הסר, רכך, או סמן "בפיתוח".

---

## 6. רשימת בעיות מלאה (P0–P3 + effort)

**P0 — חוסם פרסום / מטעה**
- "imports .jff" (281) + שורת JFLAP ב־honest cols (397) — הסר. (קטן)
- "the actual interface... in your browser" (434) על DFA hard-coded — תקן לכותרת "demo" + קישור לאפליקציה. (בינוני)
- "editable — every state and edge" (395) — רכך. (קטן)
- שני הטפסים מזייפים "You're on the list" בלי לשלוח (JS 537–556) — החלף ב־CTA אמיתי ל־`automata.html`. (בינוני)
- אין מסלול מהדף לאפליקציה — הוסף CTA שמקשר ל־`automata.html`. (בינוני)

**P1 — פגיעה משמעותית באמינות/UX/conversion**
- חסר סקשן "Supported models" (5 סוגים). (בינוני)
- חסר גילוי פרטיות/local-first. (קטן)
- חסר FAQ. (בינוני)
- `--faint #9ca3af` נכשל בניגודיות AA (form-note, fig-caption, foot, step-num, sidebar-h). (קטן)
- אין skip-link. (קטן)
- אין og/twitter/canonical; description עם "ex-TAs" ו־DFA/NFA בלבד. (קטן)

**P2 — שיפור חשוב**
- `href="#"` על wordmark (248); ניווט מובייל חסר (קישורים מוסתרים ב־640px). (בינוני)
- כפתורי sidebar דקורטיביים שנראים לחיצים (444–457). (קטן)
- hero-sub ממקד DFA/NFA בלבד. (קטן)

**P3 — polish**
- 4 משפחות גופנים — אפשר לצמצם משקלים. (קטן)
- favicon/מותג לאחד עם האפליקציה. (קטן)
- אם אי־פעם עוברים לעברית — `dir="rtl"`. (קטן)

---

## 7. מה חסר בדף

1. **Supported models** — DFA / NFA / DPDA / NPDA / TM. הנכס הכי חזק ולא מוצג.
2. **מסלול אמיתי לאפליקציה** — כפתור ל־`automata.html`. כרגע אין.
3. **Proof אמיתי** — GIF/צילומי מסך אמיתיים של האפליקציה (מחסנית, סרט, מסלולי NFA). שים לב לרישוי: תמונת ה־FA ב־fixtures היא **CC BY-NC-ND** (לא מסחרי) — אל תשתמש בה בשיווק; תמונות ה־PDA הן CC0. עדיף לצלם שרטוט חדש משלך.
4. **Privacy / local-first** — גילוי: מודלים מקומיים; הסריקה שולחת ל־OpenAI ודורשת מפתח.
5. **FAQ** — עלות, מפתח OpenAI, פרטיות, סוגים נתמכים, offline, דיוק.
6. **skip-link** + תיקוני ניגודיות (נגישות).
7. **מטא־תגיות** — og:image, twitter card, canonical.

---

## 8. מבנה הדף המומלץ (blueprint)

10 סקשנים, מבוסס על המבנה הקיים של v2 + 3 סקשנים חדשים:

1. **Nav** — לוגו (→#top) + 3 עוגנים (why / how / models) + CTA "Open the studio". מובייל: העוגנים נשארים נגישים.
2. **Hero** — H1 "Draw it on paper. Run it on screen." + subhead (רומז ל־5 סוגים) + CTA ראשי "Open the studio" (→automata.html) + משני "See how it works" + microcopy מתוקן. ויזואל: before/after הקיים.
3. **Why** — narrative + honest cols (מתוקנות). מובייל: טור אחד.
4. **How it works** — 3 שלבים (מתוקנים). מובייל: טור אחד.
5. **Supported models** *(חדש)* — 5 כרטיסים. מובייל: 1–2 בשורה.
6. **Demo** — mockup קיים, כותרת "interactive demo" + כפתור "Open the full studio". מובייל: טרמינל מתחת לגרף.
7. **Privacy / local-first** *(חדש)*. מובייל: טור אחד.
8. **FAQ** *(חדש)* — accordion. מובייל: טור אחד.
9. **Final CTA** — "Open the studio" (חזרה). אופציונלי `mailto:` לעדכונים.
10. **Footer** — קיים.

---

## 9. קופי מומלץ (אנגלית — בהתאם להחלטה)

**Head**
- description: `A local-first studio to build, AI-scan, and run computational machines — DFA, NFA, DPDA, NPDA and Turing machines. Photograph a hand-drawn automaton, get an editable graph, and run input strings step by step.`

**Navigation**
- wordmark → `#top`
- links: `why` · `how it works` · `models`
- CTA: `Open the studio →`  (→ `automata.html`)

**Hero**
- tag: `private alpha — built by a small team, in and out of office hours`  *(אם persona לא מאומת)*
- H1: `Draw it on paper. Run it on screen.`
- sub: `Stop manually tracing automata or fighting with clunky tools. Build a machine by hand or photograph a hand-drawn one — finite automata, pushdown automata, or a Turing machine — get a clean, editable graph, and run input strings to verify transitions step by step, on the actual machine you drew.`
- CTA ראשי: `Open the studio` → `automata.html`
- CTA משני: `See how it works` → `#how`
- microcopy: `free for course staff · runs locally in your browser · JSON export/import`

**Why**
- כותרת: `Why we built this` (שמור)
- honest col "what it reads": `DFAs, NFAs, PDAs and Turing machines from paper, whiteboards, and screens` · `double circles, initial arrows, multi-symbol labels ("0,1"), ε-moves` · `rushed handwriting, marker smudge, off-angle phone photos`
- honest col "what you get back": `an editable machine — every transition and symbol, not a picture` · `step-by-step string verification with a trace you can read` · `JSON export and import`  *(הסר JFLAP)*

**How it works**
- `step 1 · Snap & parse` — `The vision model extracts states, double-circles, and transition arrows. You get a structured machine, not a picture — every transition and symbol is editable if we got one wrong.`
- `step 2 · Live graph sandbox` — (שמור)
- `step 3 · Input verification` — (שמור)

**Supported models (חדש)**
- כותרת: `Five machines. One studio.`
- `DFA — Deterministic finite automaton: one active state, one move per symbol.`
- `NFA — Nondeterministic + ε-moves: every path lights up in parallel.`
- `DPDA — Deterministic pushdown automaton: a live stack starting at Z₀.`
- `NPDA — Nondeterministic pushdown: a separate stack per active path.`
- `TM — Turing machine: read/write and head movement on a tape.`

**Demo**
- כותרת: `The sandbox, working`
- intro (מתוקן): `An interactive demo of the same idea, running in your browser. The full studio — build, scan, drag-to-edit, and all five machine types — opens separately.`
- כפתור מתחת ל־mockup: `Open the full studio →` → `automata.html`
- caption: `The machine accepts binary strings ending in "10". Drag-to-rearrange and editing live in the full studio.`

**Privacy / local-first (חדש)**
- כותרת: `Runs on your machine. Stays on your machine.`
- פסקה: `Your machines and test cases are saved locally in your browser (localStorage) — not on our servers. The only thing that leaves your machine is an AI scan: the photo is sent to OpenAI to be parsed, and it needs your own OpenAI key. Without scanning, everything works fully offline.`

**FAQ (חדש)**
- `Which machine types are supported?` → `DFA, NFA (with ε), DPDA, NPDA, and Turing machines.`
- `Do I need an OpenAI key?` → `Only for scanning hand-drawn sketches. Building and running machines manually needs no key.`
- `Where do my images go?` → `Only to OpenAI, only for scanning. The machines themselves stay local and are never uploaded.`
- `Is the scan accurate?` → `It helps, it isn't perfect. Anything the model is unsure about is flagged for you to fix before running.`
- `Does it work offline?` → `Everything except scanning — building, editing, and running all work offline.`
- `Is there JFLAP or Python export?` → `Not yet. JSON export/import is available today.`
- `How much does it cost?` → `[NEEDS OWNER INPUT] Free for course staff; scanning uses your own OpenAI key.`

**Final CTA**
- כותרת: `Build, scan, run — now.`
- פסקה: `Open the studio and start from one of eight ready-made machines, or scan your first sketch.`
- CTA: `Open the studio →` → `automata.html`

**Footer** — שמור; הוסף קישור Privacy אם תכתוב מדיניות.

---

## 10. Design direction

שמור על השפה הקיימת של v2 — היא נכונה. מפרט תמציתי:
- **פלטה:** רקע `#ffffff`/`#f9fafb`; דיו `#16181d`; גוף `#3d434d`; muted `#6b7280`; גבול `#e5e7eb`; ירוק `#15803d`; אדום `#b91c1c`. **תקן:** אל תשתמש ב־`#9ca3af` לטקסט (העלה ל־`#6b7280`).
- **טיפוגרפיה:** Source Serif 4 לכותרות, Inter לגוף, JetBrains Mono לקוד/סרט, Caveat לכתב־יד בלבד. הגבל משקלים.
- **max-width:** 1040px; prose 640px.
- **spacing:** section ~88px desktop / ~56px mobile.
- **radius:** 7–11px. **shadows:** עדינים בלבד. בלי glow.
- **buttons:** ראשי מלא כהה (`#16181d`), משני outline. CTA אחד דומיננטי לכל fold.
- **section backgrounds:** לבן + `border-top` דק; לסירוגין `#f9fafb`.
- **screenshot treatment:** מסגרת חלון (titlebar + dots) — שמור, עם screenshots אמיתיים.
- **motion:** מינימלי; `prefers-reduced-motion` מכובד (כבר קיים).
- **responsive:** 800/640/420 + בדוק 1440/1280/1024/390/360.

---

## 11. Roadmap

**Quick wins (עד שעה)**
- הסר "imports .jff" + שורת JFLAP.
- רכך "every state editable" → "every transition and symbol".
- תקן `--faint` לניגודיות; הוסף skip-link.
- תקן `href="#"` על wordmark.
- הוסף og/twitter/canonical + עדכן description.

**יום עבודה אחד**
- הוסף Supported models (5 סוגים).
- הוסף Privacy/local-first + FAQ.
- תקן את הסנדבוקס: כותרת "demo" + כפתור "Open the full studio" → `automata.html`.
- החלף את הטפסים המזויפים ב־CTA אמיתי לאפליקציה.
- תקן ניווט מובייל + כפתורי sidebar דקורטיביים.

**שינויים גדולים יותר**
- הפקת proof אמיתי (GIF/screenshots של האפליקציה על שרטוט חדש משלך).
- החלטת מותג/תמחור/persona.
- (אם תרצה בעתיד) ניתוב בשרת: דף נחיתה ב־`/`, אפליקציה ב־`/app` — לא נדרש כרגע לפי בקשתך.

**מה לא לעשות כרגע**
- אל תבנה גרסה חדשה מאפס — v2 הוא בסיס טוב.
- אל תוסיף framework — vanilla מספיק.
- אל תוסיף testimonials/logos/LMS/API/מדדים בלי נתונים אמיתיים.

---

## 12. Acceptance checklist

- [ ] אין אזכור JFLAP/`.jff` בשום מקום.
- [ ] "editable" מנוסח כ"transitions and symbols", לא "every state".
- [ ] הסנדבוקס מסומן כ"demo", עם כפתור עובד → `automata.html`.
- [ ] כל 5 סוגי המכונות מוצגים.
- [ ] אף טופס לא מציג "הצלחה" שקרית; הוחלף ב־CTA לאפליקציה (או `mailto:` אמיתי).
- [ ] יש גילוי פרטיות: תמונות→OpenAI, מודלים מקומיים, נדרש מפתח.
- [ ] נגישות: skip-link, ניגודיות AA, H1 יחיד, focus-visible, reduced-motion, ניווט מובייל עובד, בלי `href="#"` מת, בלי רכיבים לחיצים־מדומים.
- [ ] אין horizontal overflow ב־360/390/768/1024/1280/1440.
- [ ] אין console errors; אין בקשות רשת שנכשלות.
- [ ] title/description/canonical/og מוגדרים.
- [ ] `automata.html` והשרת לא נשברו.

---

# פרומפט מוכן ל־Claude Code

העתק־הדבק את כל הבלוק הבא ל־Claude Code כפי שהוא.

```
CONTEXT — PRODUCT (source of truth; do not contradict):
"automata.vision" (app title in Hebrew: "מודלים חישוביים") is a LOCAL-FIRST studio to build, AI-scan, and RUN computational-model machines. It supports five machine types that are actually implemented and simulatable: DFA, NFA (incl. ε-transitions), DPDA, NPDA, and Turing Machine. Users build a machine manually or photograph a hand-drawn sketch; an AI scan (server.js -> OpenAI Vision) reconstructs an editable graph with low-confidence items flagged; then the user runs input words and watches states/transitions/stack/tape/NFA-paths light up step by step, with accept/reject/halt explanations. Models and test cases persist LOCALLY in localStorage. The AI scan is the ONLY thing that leaves the machine (image -> OpenAI, requires the user's own OpenAI key); everything else works offline. The real app is the file automata.html in the same directory.

THINGS THAT ARE NOT IMPLEMENTED — you must NOT claim, imply, or keep any copy about them:
JFLAP / .jff import or export; Python or C++ export; renaming a state or changing the start state from the UI; mass/batch grading; language equivalence; partial credit; LMS/LTI; a general REST API; accuracy percentages; speed metrics. JSON export/import IS real and may be mentioned. Editing TRANSITIONS and SYMBOLS is real; editing arbitrary state names is not.

TASK: Edit ONLY the file landing-v2.html, in place. Do NOT touch server.js, automata.html, landing.html, or any other file. Keep it vanilla single-file HTML/CSS/JS — no framework. Keep the language ENGLISH and the existing light/academic visual design. Implement every change below in code (not as suggestions).

KEEP (do not remove): the light/academic design; nav structure; the hero before/after figure; the "honest columns"; the 3-step "how it works"; the windowed app mockup + terminal; footer; prefers-reduced-motion handling.

P0 — CLAIMS & CONVERSION:
1. Hero microcopy line (currently "free for course staff · works in the browser · imports .jff"): change to "free for course staff · runs locally in your browser · JSON export/import".
2. "what you get back" honest column: DELETE the list item about "JFLAP (.jff) import and export". Change "an editable machine — every state and edge, not a picture" to "an editable machine — every transition and symbol, not a picture".
3. How-it-works step 1: change "every edge is editable if we got one wrong" to "every transition and symbol is editable if we got one wrong".
4. Demo section intro: replace "This is the actual interface, running the machine from fig. 1 in your browser." with "An interactive demo of the same idea, running in your browser. The full studio — build, scan, drag-to-edit, and all five machine types — opens separately." Keep the hard-coded terminal demo. ADD a primary button directly under the app mockup: text "Open the full studio →", linking to automata.html.
5. Demo caption: change to "The machine accepts binary strings ending in \"10\". Drag-to-rearrange and editing live in the full studio."
6. Hero form: it currently fakes a "You're on the list" success without sending anything. REPLACE the hero email form with two buttons: a primary "Open the studio →" linking to automata.html, and a secondary "See how it works" linking to #how. Remove the fake success element and its JS for the hero.
7. Footer signup form (the second email form): REPLACE it with a primary CTA "Open the studio →" linking to automata.html. Optionally keep a real mailto: link "get updates" to [NEEDS OWNER INPUT: contact email] — do NOT fake a success message. Remove the fake success element and its JS for the footer form.
8. Hero persona line "built by two ex-TAs and a systems engineer": change to "built by a small team, in and out of office hours" and add an HTML comment <!-- [NEEDS OWNER INPUT] confirm team description -->.

P1 — NEW SECTIONS (final top-to-bottom order: Nav, Hero, Why, How it works, [NEW] Supported models, Demo, [NEW] Privacy/local-first, [NEW] FAQ, Final CTA, Footer):
9. INSERT "Supported models" AFTER "How it works" and BEFORE the demo section. Title: "Five machines. One studio." Five cards, each a one-liner plus a tiny inline SVG state-diagram glyph:
   DFA — "Deterministic finite automaton: one active state, one move per symbol."
   NFA — "Nondeterministic + ε-moves: every path lights up in parallel."
   DPDA — "Deterministic pushdown automaton: a live stack starting at Z₀."
   NPDA — "Nondeterministic pushdown: a separate stack per active path."
   TM — "Turing machine: read/write and head movement on a tape."
   Mobile: cards stack 1–2 per row, no horizontal overflow.
10. INSERT "Privacy / local-first" AFTER the demo, BEFORE the final CTA. Title: "Runs on your machine. Stays on your machine." Copy: "Your machines and test cases are saved locally in your browser (localStorage) — not on our servers. The only thing that leaves your machine is an AI scan: the photo is sent to OpenAI to be parsed, and it needs your own OpenAI key. Without scanning, everything works fully offline."
11. INSERT "FAQ" AFTER privacy, BEFORE the final CTA. Use accessible <details>/<summary> accordion. Q/A:
   "Which machine types are supported?" -> "DFA, NFA (with ε), DPDA, NPDA, and Turing machines."
   "Do I need an OpenAI key?" -> "Only for scanning hand-drawn sketches. Building and running machines manually needs no key."
   "Where do my images go?" -> "Only to OpenAI, only for scanning. The machines themselves stay local and are never uploaded."
   "Is the scan accurate?" -> "It helps, it isn't perfect. Anything the model is unsure about is flagged for you to fix before running."
   "Does it work offline?" -> "Everything except scanning — building, editing, and running all work offline."
   "Is there JFLAP or Python export?" -> "Not yet. JSON export/import is available today."
   "How much does it cost?" -> "<!-- [NEEDS OWNER INPUT] --> Free for course staff; scanning uses your own OpenAI key."
12. Change the final CTA section heading to "Build, scan, run — now." with copy "Open the studio and start from one of eight ready-made machines, or scan your first sketch." and the CTA button "Open the studio →" -> automata.html.

P1 — ACCESSIBILITY & SEO:
13. Add a skip link: <a class="skip-link" href="#main">Skip to content</a> as the first element in <body>, add id="main" to <main>, and add CSS (.skip-link off-screen, visible on :focus).
14. Contrast: raise --faint from #9ca3af to #6b7280 for text. If you want to keep a lighter shade for purely decorative, non-text uses, add a separate --faint-decor and use it only there.
15. <head>: update meta description to "A local-first studio to build, AI-scan, and run computational machines — DFA, NFA, DPDA, NPDA and Turing machines. Photograph a hand-drawn automaton, get an editable graph, and run input strings step by step." Add <link rel="canonical">, og:type/title/description/url, and twitter:card/title/description. Do NOT invent og:image — leave a commented placeholder [NEEDS OWNER INPUT: share image].

P2:
16. Nav wordmark href="#": change to "#top" and add id="top" to the top of the page (e.g., on <main> or the hero). Keep the three anchor links reachable on mobile (do not hide them under 640px); tighten spacing instead, or add a simple hamburger. No inaccessible nav.
17. The two inactive "file" buttons in the demo sidebar do nothing: convert them to non-interactive elements (e.g. <div>), keep the active one marked with aria-current. Do not leave elements that look clickable but are no-ops.
18. Hero subheadline: broaden it to hint at all model types (finite automata, pushdown automata, Turing machines), per the copy above.

DO NOT:
- Do NOT claim JFLAP/.jff, Python/C++ export, mass grading, language equivalence, LMS, REST API, accuracy %, or speed metrics.
- Do NOT show a fake form-success message.
- Do NOT add invented metrics, logos, testimonials, or institutions.
- Do NOT edit any file other than landing-v2.html. Do NOT break automata.html or the server.

ACCEPTANCE CRITERIA:
- No mention of JFLAP/.jff anywhere; "editable" refers to transitions/symbols, not "every state".
- The demo is labeled as a demo and has a working "Open the full studio" button to automata.html.
- All five machine types are presented.
- No form shows a false success; hero and footer CTAs link to automata.html (footer may also offer a real mailto).
- Privacy/local-first section and FAQ are present.
- skip-link present; no text uses #9ca3af; single <h1>; focus-visible works; reduced-motion honored; nav links reachable on mobile; no href="#" dead links; no fake-clickable elements.
- No horizontal overflow at 360/390/768/1024/1280/1440; no console errors; no failed network requests.
- title/description/canonical/og/twitter set.

TESTS TO RUN AT THE END:
- Load landing-v2.html in a browser; confirm no console errors and no failed network requests.
- Check desktop (1440/1280/1024) and mobile (390/360): no horizontal overflow, all CTAs reachable, mobile nav works.
- Keyboard-only pass: skip link, tab order, FAQ accordion, nav, buttons.
- prefers-reduced-motion disables animation.
- Every link resolves: no href="#" dead ends; "Open the studio" / "Open the full studio" load automata.html.

WHEN DONE, REPORT:
- Every change made (landing-v2.html only).
- Result of the browser/console/responsive/keyboard/reduced-motion/link checks.
- A bulleted list of items left as [NEEDS OWNER INPUT]: team description, contact email / real signup endpoint, pricing, brand-name unification, and a share image.
- Confirm no other files were modified.
```

---

### הערה אחרונה
הדוח מבוסס על קריאה מלאה של `landing-v2.html` ועל `server.js`, ועל הסיכום שלך כמקור אמת. הקובץ `landing-v2.html` **לא שונה** — הוא במצבו המקורי. הפרומפט למעלה מוכן להרצה כשתרצה, והוא נוגע רק ב־`landing-v2.html`.
