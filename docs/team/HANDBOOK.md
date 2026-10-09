# מדריך משותף לכל הצ'אטים — פרויקט "מודלים חישוביים"

המסמך הזה הוא הידע המשותף לכל הצ'אטים שעובדים על הפרויקט. כל צ'אט קורא אותו **לפני** שהוא נוגע במשהו.
מצב נכון ל-2026-10-08. מספרי שורות הם בקירוב — הם זזים, חפשו לפי שם פונקציה.

---

## 1. מה המוצר

כלי לימוד בעברית (RTL) לתוכנית הלימודים הישראלית "מודלים חישוביים" — מעין JFLAP מותאם לתוכנית:

- **עורך גרפי וסימולטור** לחמישה סוגי מודלים: אוטומט סופי דטרמיניסטי (DFA, גם "לא מלא"), אוטומט סופי לא-דטרמיניסטי (NFA עם ε), אוטומט מחסנית דטרמיניסטי (DPDA), אוטומט מחסנית לא-דטרמיניסטי (NPDA), מכונת טיורינג (TM).
- **סריקת שרטוט בכתב יד (AI)**: מצלמים דף מחברת עם אוטומט מחסנית, השרת שולח ל-OpenAI (מודל `gpt-5.6-luna`) בכמה שלבים, והתוצאה מצוירת על הלוח. **עיקרון ברזל: fail-closed** — כל מה שהגיע מסריקה נעול ולא רץ עד שאדם מאשר אותו בלוח "בדיקת סריקה".
- המשתמש: איתי. כותב בעברית, מעדיף תשובות קצרות וברורות בעברית.

## 2. איפה הכל

| מה | איפה |
|---|---|
| תיקיית הפרויקט הראשית | `C:\Users\its\Documents\modeles` |
| GitHub (remote `origin`) | `https://github.com/itay123av/models` (שימו לב: **models**) |
| GitHub ישן (remote `modeles-archive`) | `https://github.com/itay123av/modeles` |
| ענף העבודה הנוכחי | `agent/local-security-hardening` (יש גם `main` ישן). לא נדחף מאז יולי |
| מפתחות API | `.secrets/openai.env`, `.secrets/gemini.env`, `.env` — **ב-gitignore, לעולם לא להדפיס/לקמט** |
| זיכרון Claude של הפרויקט | `C:\Users\its\.claude\projects\C--Users-its-Documents-modeles\memory\` (התחילו מ-`MEMORY.md`) |
| דוחות ניסויים | `test-evidence/*.md` (בגיט) |
| ראיות סריקה פרטיות (תמונות, תגובות) | `test-evidence/scan-*/` (**ב-gitignore**, רק בתיקייה הראשית) |
| קבצי סטטוס של הצוות | `docs/team/status-*.md` — כל צ'אט כותב רק בקובץ שלו |

**worktrees** (תיקיות עבודה נפרדות לכל צ'אט — צ'אט 1 יוצר אותן):

| צ'אט | תיקייה | ענף |
|---|---|---|
| 1 — אינטגרציה ובקרת איכות | `C:\Users\its\Documents\modeles` (הראשית) | `agent/local-security-hardening` |
| 2 — עורך וסימולטור | `C:\Users\its\Documents\modeles-app` | `claude/app` |
| 3 — סריקה: קריאת תוויות ותיקון אחרי סריקה | `C:\Users\its\Documents\modeles-scan` | `claude/scan-labels` |
| 4 (אופציונלי) — סריקה: טופולוגיה וחיתוכים | `C:\Users\its\Documents\modeles-topology` | `claude/scan-topology` |
| Codex — סריקה: טופולוגיה וחיתוכים (כל עוד אין צ'אט 4) | `C:\Users\its\Documents\modeles-codex` | `codex/scan-topology` |

Codex (כלי אחר שהמשתמש מריץ) עבד עד עכשיו על **חיתוכים וטופולוגיה של הסריקה** ישירות בתיקייה הראשית, בלי קומיטים. **מעכשיו** הוא עובד רק בתיקייה `modeles-codex` ומקמט בענף שלו, וצ'אט 1 ממזג אותו כמו כל ענף אחר. ההוראות שלו: `docs/team/prompt-codex.md`.

**התיקייה הראשית שייכת לצ'אט 1 בלבד** — אף סוכן אחר לא עורך בה.

## 3. איך מריצים

- **המשתמש**: לחיצה כפולה על `start-automata.bat` → `node server.js` + פתיחת `http://127.0.0.1:8790/automata.html`.
- **צ'אט**: `preview_start` עם `{name:"modeles"}` (מתוך `.claude/launch.json`, `autoPort` — יקבל פורט פנוי אם 8790 תפוס).
- **נתוני המשתמש** נשמרים ב-localStorage **לפי כתובת** (מפתח `automata_data_v1`). `127.0.0.1:8790` ו-`localhost:8790` הם שני מחסנים נפרדים. **לעולם לא לנקות/לדרוס אחסון של המשתמש.** לבדיקות — עבדו בחלונית הדפדפן של Claude (פרופיל נפרד) ועל כתובת/פורט שאינם של המשתמש.
- השרת מאזין רק ל-loopback, מגיש רק רשימה סגורה של קבצים (`/.env`, `/server.js` מחזירים 404), ומגביל עלות לסריקה (`OPENAI_SCAN_MAX_ESTIMATED_USD=0.10`, 16 קריאות).

## 4. מפת הקוד

| קובץ | תוכן |
|---|---|
| `automata.html` (~4,400 שורות) | כל האפליקציה בצד הלקוח: עורך, סימולטור, ספרייה, סריקה, לוח הבדיקה. **הערות בעברית.** ב-working tree שורות CRLF. **שני בלוקי `<style>`** — CSS שצריך לגבור יושב בסוף האחרון. |
| `pda-core.js` | סמנטיקת אוטומט מחסנית המשותפת ללקוח, לשרת ולבדיקות (⊥ בתחתית, PUSH/POP/NONE, חסימת כללים לא חוקיים). |
| `server.js` (~6,400 שורות) | שרת סטטי + `/api/health` + `/api/parse-diagram` (שלבים: `topology` → `topology-audit` → `labels`). **הערות באנגלית.** |
| `pda-action-word-guide.cjs` | מדריך צורות האותיות בכתב יד עברי לפעולות דחוף/שלוף/ללא שינוי (נטען ע"י `server.js`, ומשותף גם לסקריפטי ה-probe של Gemini). בגיט מאז `9fbaa25`. |
| `scripts/` | `scan-image-diagnostic.cjs` (סריקה מלאה דרך הלקוח האמיתי, offline כברירת מחדל, `--live` = בתשלום), `replay-label-stage.cjs` (שלב התוויות בלבד על ראיות שמורות, `--live`), `probe-action-words.cjs`, `recheck-local-crops.cjs` (Codex), `fuzz-engines.cjs` (השוואת מנועים, חינם), `replay-ui-server.cjs` (הצגת תוצאת סריקה שמורה בתוך האפליקציה, חינם). |

**אזורים ב-`automata.html`** (חפשו לפי שם):

- **עורך**: `addStateCentered`/`freeStateSpot`, `deleteState`, `renameState`, `toggleStart`/`toggleAccept`, `onDown`/`onStateClick` (קליק-קליק = מעבר, לחיצה כפולה = לולאה), `promptTransition` (DFA/NFA), `promptTransitionPDA`, `promptTransitionTM`, `renderInspector`, `setTransitionEndpoint`, `deleteTransition`, `deletePdaRule`/`deleteTmRule`.
- **מנועים**: `simInit`, `simStepObj`, `nfaClosure`/`nfaStep`, `pdaStep`/`pdaAccepts` (דטרמיניסטי, כולל זיהוי לולאות ε: `pdaEpsilonLoopLimit`, `pdaStepEpsilonLoop`), `npdaStep`/`npdaAccepts` (`npdaSeenKeys`), `tmStep`, `runQuick`, `simReady` (חסימות הרצה עם הודעה מדויקת), `computeValidation`.
- **ממשק**: `renderAll`, `renderGraph`, `fitView`/`canvasFreeRect`, `renderStack` (מוסיף `body.has-stack`), `toggleControlPanel`, `renderGuide` (טקסט המדריך נמצא **רק** כאן; העותק הסטטי ב-HTML הוסר ב-`claude/app`), `sanitizeModel`/`jsonErrorText` (ייבוא וטעינה בטוחים), `toast`/`toastAction`/`offerUndo`/`undoLast` (ביטול מחיקה), ספרייה `openLibrary`, `importData`/`exportCurrent`, `load`/`save` (`SAVE_SEQ`, גיבוי נתונים לא קריאים).
- **סריקה (לקוח)**: `openAiScan` (חלון הסריקה), `downscaleImage`, `runTwoStageDiagramScan`, `buildTwoStageCropSpecs`, `mergeTwoStageScan`, `applyAiTransitionsToCanvas`, `applyAiStates`, `aiRuleFromPayload`, `layoutAiTopologyStates`, לוח הבדיקה: `collectAiReviewItems`, `renderAiReviewPanel`, `aiStateConcerns`, `unresolvedLabelReadTarget`, `acknowledgeUnresolvedLabelRead`, `editPdaTransition`. דוגמה מובנית: `AI_SAMPLE`, `AI_TM_SAMPLE`.

## 5. בדיקות

- `npm test` — כ-260 בדיקות offline (חינם, כ-15 שניות). חייב להיות 0 כשלונות לפני כל קומיט.
  - **בדיקות העורך, הסימולטור והמעטפת → `client-app.test.js`** (צ'אט 2). **בדיקות הסריקה → `client-pda.test.js`** (צ'אטים 3/4 ו-Codex). ככה שני ענפים לא מוסיפים בסוף אותו קובץ ולא מתנגשים.
  - `client-pda.test.js` טוען את הסקריפט האמיתי מתוך `automata.html` לתוך VM (`loadClient`). `silenceClientUi(ctx)` מחליף גם את `save` בפונקציה ריקה — כשבודקים משהו שתלוי ב-`save` (כמו `SAVE_SEQ`), החליפו רק את פונקציות הציור. `DB` מוגדר ב-`let`: גישה דרך `vm.runInContext('DB', ctx)`. מערכים שנוצרו בתוך ה-VM לא שווים ב-`deepStrictEqual` למערכים מבחוץ — עטפו ב-`Array.from`.
  - `pda.test.js` — שרת ו-pda-core; `server.test.js` — אבטחה; ועוד.
- **בדיקת רגרסיה אמיתית נכשלת על הקוד הישן.** הוכיחו זאת: `git show HEAD:automata.html > <tmp>/automata.html`, העתיקו לשם את `pda-core.js` ואת קובץ הבדיקות, והריצו את הבדיקה החדשה שם.
- `node scripts/fuzz-engines.cjs 200` — השוואת חמשת המנועים מול מימושי-ייחוס עצמאיים (0 אי-התאמות נדרש). להריץ אחרי כל שינוי במנוע.
- **בדיקה בדפדפן**: `preview_start`, ואז `read_console_messages` (0 שגיאות), טעינת הדוגמאות המובנות (45/45 מילים עוברות), ובדיקה ויזואלית. **מלכודת**: כש-`resize_window` גדול מהחלונית, קליקים לפי קואורדינטות נוחתים במקום אחר — השתמשו ב-`element.click()` או בגודל הטבעי של החלונית. בדיקת טלפון: 390×844, לוודא שאין חפיפות בין `controlPanel`/`stackFloat`/`tapeFloat`/`guideFloat`/`aiReviewPanel`.

## 6. Git — כללי ברזל (כמה סוכנים עובדים במקביל!)

1. כל צ'אט עובד **רק בתיקייה ובענף שלו**. אין לערוך קבצים בתיקייה של צ'אט אחר.
2. **לעולם לא `git add -A` / `git add <קובץ>` בעיוורון.** לפני קומיט: `git diff --cached` ולוודא שכל hunk הוא שלכם. אם קובץ השתנה על הדיסק מאז שקראתם אותו — בדקו מי שינה.
3. אם בקובץ יש גם שינויים של מישהו אחר: בנו patch מסונן מה-hunks שלכם, `git apply --cached --recount <patch>`, ובדקו את ה-index לבד: `git checkout-index -a --prefix=<tmp>/` ואז `npm test` שם.
4. הודעת קומיט מסתיימת ב:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
5. לא לקמט סודות, `.env`, `.secrets/`, `test-evidence/scan-*/`. לא force-push. **push רק באישור מפורש של המשתמש** (וצ'אט 1 בלבד).
6. מיזוג לענף הבסיס — **רק צ'אט 1**. צ'אט שסיים חבילת עבודה כותב זאת בקובץ הסטטוס שלו ומבקש מהמשתמש להעביר לצ'אט 1.

## 7. מלכודות טכניות שכבר עלו לנו בזמן

- **כלי ה-Bash מכווץ `\\` ל-`\`** בתוך heredoc ו-`node -e`. סקריפט עם לוכסנים הפוכים — כתבו לקובץ עם כלי ה-Write והריצו אותו.
- נתיב Windows בתוך template literal ב-JS צריך `\\` (אחרת `\U`, `\D` הופכים לאותיות).
- לא להשאיר תווי בקרה ליטרליים (למשל U+0001) בקוד — כתבו `'\u0001'` כטקסט.
- `automata.html` ב-CRLF: עריכה בסקריפט צריכה לזהות `\r\n`.
- העדפות המשתמש: **בלי חלונות אישור** למחיקות (יש "בטל" בהודעה במקום); פאנלים צפים; אייקוני SVG (לא אימוג'י בממשק); פונט Heebo; סגנון "לוח לבן" בהיר.
- מוסכמות: מחסנית מתחילה ב-`⊥` מוגן; קבלה באוטומט מחסנית = כל הקלט נקרא + מצב מקבל + המחסנית חזרה ל-`[⊥]`. **לא לשנות סמנטיקה בלי החלטה מפורשת של המשתמש.**
- הדפדפן מפריד אחסון לפי כתובת (ראו סעיף 3).
- `sed -i` ב-Git Bash הופך את `automata.html` ל-LF. כלי ה-Edit עלול להפוך תו בידי כמו `⁦` (U+2066) לתו בלתי נראה. עריכה בסקריפט — רק מסקריפט node בקובץ.
- `_buildDialog` (מאז `claude/app`): Enter על כפתור מפעיל את הכפתור, ועל `.chip`/`.pda-mode` הוא בוחר ומאשר. רק החלון העליון מגיב למקלדת, ו-Tab נשאר בתוך החלון. חלון סריקה שצריך התנהגות אחרת — לתאם עם צ'אט 2.
- כדי לא לתפוס את 8790 של המשתמש, אפשר להוסיף ל-`.claude/launch.json` **מקומית** (בלי קומיט) תצורה על פורט אחר. צ'אט 2 משתמש ב-8792.

## 8. מדיניות סריקות בתשלום (OpenAI)

- מחירים בפועל: סריקה מלאה כ-$0.06 (תקרת שרת $0.10); `replay-label-stage --live` כ-$0.035 לריצה — **עוקף את תקרת השרת**; probe כ-$0.005.
- **תקציב לצ'אט: עד $0.30 בלי לשאול.** מעבר לזה — לבקש אישור. לדווח עלות בכל דוח.
- **קודם offline**: ראיות שמורות ב-`test-evidence/scan-oct06-live`, `scan-sept29-live-verify`, `scan-guard-contract` (עם `reference-actions.json` מאושר).
- המודל לא דטרמיניסטי: השוואה = **3 ריצות לכל תצורה** (ישן מול חדש עם `REPLAY_SERVER`).
- **אסור**: להכניס תשובות-ייחוס לפרומפט, להחליף אותיות גורפות (c→a, ε→a), להוריד ספים כדי להסתיר טעויות, או לצייר את הגרף המוכר במקום לזהות. הכל נשאר נעול עד אישור אדם.

## 9. איך מדווחים למשתמש

- בעברית, קצר וענייני: מה השתנה, מה נבדק (ואיך), כמה עלה, ומה ההחלטה שנדרשת ממנו. קבצים — כקישורים.
- לא להבטיח מה שלא נבדק. אם משהו לא עובד — לומר זאת במפורש.
- לפני פעולה בלתי הפיכה או חיצונית (push, מחיקה, הוצאת כסף מעל התקציב) — לשאול.

## 10. לפני שהקונטקסט נגמר

עדכנו את `docs/team/status-<תפקיד>.md`: מה בוצע (קומיטים), מה פתוח, מה הצעד הבא המדויק, ואיזה ראיות/קבצים רלוונטיים. ככה צ'אט ממשיך יכול להתחיל מיד. עובדה עמידה (לא סטטוס) — לזיכרון הפרויקט (סעיף 2).
