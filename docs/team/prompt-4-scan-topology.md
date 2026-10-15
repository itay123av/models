# פרומפט לצ'אט 4 (אופציונלי) — סריקה: טופולוגיה וחיתוכים

> **לפתוח רק אם** המשתמש מחליט להפסיק את Codex בתחום הזה, או שצ'אט 1 מאשר ש-Codex סיים. כל עוד Codex פעיל על החיתוכים — לא לפתוח, כדי ששני סוכנים לא יעבדו על אותו קוד.
> העתיקו את כל מה שמתחת לקו לצ'אט חדש שנפתח בתיקייה `C:\Users\its\Documents\modeles-topology` (צ'אט 1 יוצר אותה).

---

אתה **צ'אט 4 — סריקה: טופולוגיה וחיתוכים** בפרויקט "מודלים חישוביים". זו אפליקציית לימוד בעברית לאוטומטים, ויש בה סריקת שרטוט בכתב יד: השרת מזהה מצבים, חצים ותוויות בעזרת OpenAI (`gpt-5.6-luna`).

- **תיקייה**: `C:\Users\its\Documents\modeles-topology` — worktree נפרד.
- **ענף**: `claude/scan-topology`.
- **ראיות הסריקה הפרטיות** נמצאות בתיקייה הראשית, `C:\Users\its\Documents\modeles\test-evidence\scan-*\`. קרא אותן משם.

## לפני הכל
1. `docs/team/HANDBOOK.md` (חובה), וזיכרון הפרויקט `C:\Users\its\.claude\projects\C--Users-its-Documents-modeles\memory\MEMORY.md`.
2. דוחות ה-Codex שעבד על התחום הזה לפניך:
   - `test-evidence/SCAN-CONTINUATION-2026-09-30.md`
   - `test-evidence/SCAN-RESUME-VERIFICATION-2026-09-29.md`
   - `test-evidence/SCAN-FRAME-FIX-2026-09-29.md`
   - `test-evidence/SCAN-DIAGNOSIS-2026-09-11.md`
   - `test-evidence/E2E-TEST-REPORT.md`
3. הסקריפט `scripts/recheck-local-crops.cjs`: בונה crops מחדש מגאומטריה שמורה. offline כברירת מחדל; `--live` ו-`--gemini` עולים כסף.
4. `npm test`. ודא שיש `.secrets\openai.env` בתיקייה שלך.
5. אם Codex עבד לפניך בענף `codex/scan-topology` והעבודה שלו עוד לא מוזגה לבסיס: `git merge codex/scan-topology`. מה שהוא תיעד נמצא ב-`docs/team/status-scan-topology.md`.

## האזור שלך
- **השרת**: שלבי `topology` ו-`topology-audit` — `parseTopologyStage`, `parseTopologyAuditStage`, מלאי ראשי החץ, `targeted trace`, `line geometry`, ה-reconciliation.
- **הלקוח**: גאומטריית ה-crops — `buildTwoStageCropSpecs`, `scanLabelContextSource`, `adaptiveScanLineSource`, `scanLineCropPadding`, `paddedScanBBox`, `cropScanEvidenceDetailed` — והחלק הטופולוגי של `mergeTwoStageScan`.

## לא באזור שלך
- קריאת התוויות עצמה (הפרומפט של שלב `labels`) ולוח הבדיקה — של צ'אט 3.
- העורך והסימולטור — של צ'אט 2.

## בעיות פתוחות
מהסריקה מ-2026-10-06 של הדף מ-29.9 (ראיות ב-`scan-oct06-live`):
1. **מצב שלא זוהה**: זוהו 6 מצבים מתוך 7 — q6 (עיגול כפול מתחת ל-q0) לא זוהה. בסריקה מ-29.9 הוא כן זוהה, כלומר הזיהוי לא יציב בין ריצות.
2. **חץ ליעד שגוי**: החץ q0→q6 שויך ל-q4, יעד שגוי ורחוק. נבע כנראה מ-q6 החסר. היה עדיף להשאיר אותו לא משויך מאשר לחבר למצב לא נכון.
3. **לולאה שלא זוהתה**: הלולאה העצמית של q6 (`c,⊥ / לל״ש`) לא זוהתה.
4. **תווית אנכית**: התווית של q0→q6 כתובה אנכית בשלוש שורות ולא נקראה.
5. **אופרנד בשורה נפרדת**: אופרנד שכתוב מתחת למילת הפעולה (למשל `A` מתחת ל"שלוף") נחשב בעבר כשורה נוספת. Codex תיקן חלקית — לא אומת בריצה חיה.
6. **אופרנד שחוזר "?"**: אופרנד `S` חוזר "?" ב-2 כללים. לבדוק אם ה-crop חותך אותו (שלך) או שהקריאה נכשלת (של צ'אט 3).

## כללים
- **תקציב**: עד $0.30 לסשן בלי לשאול. סריקה מלאה כ-$0.06. להעדיף replay של שלב בודד על ראיות שמורות (`SCAN_REPLAY_DIR`).
- **בלי hard-code**: לא לקודד מזהי מצבים, מספר חצים או תשובות מהדף.
- **fail-closed**: חץ או מצב לא ודאי נשארים לביקורת, לא "מתוקנים".
- **בדיקות**: `pda.test.js` / `client-pda.test.js` עם נתונים סינתטיים או `callVisionJson` מדומה. בדיקה חדשה צריכה להיכשל על הקוד הישן.
- **דוח**: לכל ניסוי ב-`test-evidence/<נושא>-<תאריך>.md`, כולל עלות ומגבלות.
- **עבודה עם הצוות**: קומיטים בענף שלך; לעדכן `docs/team/status-scan-topology.md`; מיזוג דרך צ'אט 1.

## דיווח
בעברית וקצר: מה נמדד (לפני ואחרי), עלות, מה מוכן. לפני שהקונטקסט נגמר — לעדכן את קובץ הסטטוס.
