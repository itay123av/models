/* ═══════════════════════════════════════════════════════════════════════════
   pda-core.js — ליבת הסמנטיקה של אוטומט מחסנית (PDA)
   ───────────────────────────────────────────────────────────────────────────
   מודול משותף: נטען גם בדפדפן (automata.html) וגם ב-Node (בדיקות).
   כאן יושבת *כל* המשמעות של מעבר PDA, כדי שהסימולטור, הסורק והבדיקות
   יעבדו לפי אותה הגדרה בדיוק.

   מבנה תווית מעבר (כלל מרחבי מחייב — נקרא לפי המיקום בתמונה):

       [INPUT] , [STACK_TOP] / [ACTION]
         שמאל       אמצע          ימין

   INPUT      — תנאי: איזה סימן קלט נדרש.
   STACK_TOP  — תנאי: איזה סימן חייב להיות בראש המחסנית *לפני* הפעולה.
   ACTION     — הפעולה: דחוף X / שלוף X / ללא שינוי (לל"ש).

   סמנטיקה:
   • PUSH X  — מוסיף פריט חדש X *מעל* הראש הקיים. הראש הישן אינו נמחק
               ואינו מוחלף; הוא יורד שכבה אחת. X רשאי להיות שונה מ-STACK_TOP.
   • POP X   — מסיר רק את הפריט העליון. חובה ש-X === STACK_TOP.
   • NONE    — הקלט נצרך, המחסנית אינה משתנה כלל.

   תחתית המחסנית: הסימן הקנוני הוא ⊥ (ולא Z₀). ⊥ מוגן ומופיע פעם אחת —
   אין לשלוף אותו, אין לדחוף מופע נוסף שלו והמחסנית לעולם אינה מתרוקנת.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* סימן תחתית המחסנית הקנוני. הוא קיים פעם אחת בלבד בתחתית:
     אסור לשלוף אותו ואסור לדחוף מופע נוסף שלו. */
  const PDA_BOTTOM = '⊥';

  /* צורות כתיבה שמתקבלות בקלט ומתנרמלות אל הסימן הקנוני.
     הערה מתועדת: תאימות לנתוני Z0 ישנים היא נושא שעדיין פתוח. כאן נשמרת
     *בדיוק* סובלנות-הקלט שהייתה קיימת בקוד קודם לכן, רק שהיא מצביעה עכשיו
     על ⊥ במקום על Z₀. לא נוספה שום לוגיקת הגירה חדשה. */
  const BOTTOM_ALIASES = ['⊥', '⟂', 'Z₀', 'Z_0', 'Z0'];

  const EPSILON = 'ε';

  function isBottomAlias(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return false;
    if (t === '⊥' || t === '⟂' || t === 'Z₀') return true;
    const up = t.toUpperCase();
    return up === 'Z0' || up === 'Z_0';
  }

  /* נרמול סימן בודד: ε (בכל כתיב) → מחרוזת ריקה = "אין תנאי / אין ערך". */
  function pdaNormSym(sym) {
    const s = String(sym == null ? '' : sym).trim();
    if (!s || s === EPSILON || s.toLowerCase() === 'epsilon') return '';
    if (isBottomAlias(s)) return PDA_BOTTOM;
    return s;
  }

  /* פירוק מחרוזת לרשימת סימני מחסנית. כל תו הוא פריט נפרד בערימה.
     כינוי legacy של סימן התחתית מתקבל רק כאשר *כל השדה* הוא הכינוי.
     אסור לחפש Z0/⟂ בתוך מחרוזת ארוכה ולשכתב רק חלק מהראיה (למשל
     AZ0B -> A⊥B), משום שזו כבר אינה מיגרציה של שדה ישן אלא תיקון שקט. */
  function pdaTokenize(str) {
    str = String(str == null ? '' : str);
    const whole = str.trim();
    if (isBottomAlias(whole)) return [PDA_BOTTOM];
    const out = [];
    for (let i = 0; i < str.length;) {
      const ch = str[i];
      if (ch === ' ' || ch === ',' || ch === EPSILON) { i++; continue; }
      /* בתוך שדה רב-סימני שומרים כל גליף כפי שנכתב. רק ⊥ הקנוני נשאר
         כמובן ⊥; lookalikes כגון ⟂ אינם מומרים באמצע מחרוזת. */
      const tok = ch === PDA_BOTTOM ? PDA_BOTTOM : ch;
      if (tok) out.push(tok);
      i++;
    }
    return out;
  }

  function pdaTokens(v) { return Array.isArray(v) ? v.flatMap(x => pdaTokenize(x)) : pdaTokenize(v); }
  function pdaTok1(str) { return pdaTokens(str)[0] || ''; }
  function pdaSingle(str) { const toks=pdaTokens(str); return toks.length>1?'?':(toks[0]||''); }

  /* ── מודל הכלל ──────────────────────────────────────────────────────────
     {
       read   : סימן הקלט (INPUT)        — '' פירושו ε
       top    : ראש המחסנית הנדרש (STACK_TOP)
       op     : 'push' | 'pop' | 'none'
       push   : סימני הדחיפה (ACTION.symbol עבור PUSH)
       popSym : סימן השליפה שנקרא באזור הימני (ACTION.symbol עבור POP)
     }
     popSym נשמר *בנפרד* מ-top בכוונה: כך אפשר להחזיק בו-זמנית גם את מה
     שנקרא באזור האמצעי וגם את מה שנקרא באזור הימני, ולדווח על סתירה
     ביניהם בלי לתקן אותה בשקט ובלי לפרש מחדש את הטקסט הגולמי. */
  function pdaMakeRule(readRaw, topRaw, op, pushRaw, popSymRaw) {
    const action = String(op == null ? '' : op).toLowerCase();
    const rule = {
      read: pdaSingle(readRaw),
      top: pdaSingle(topRaw),
      op: action,
      push: action === 'push' ? pdaTokens(pushRaw) : [],
    };
    /* ACTION.symbol is an independent visual field.  Missing POP evidence stays
       missing; it is never reconstructed from STACK_TOP. */
    if (action === 'pop') rule.popSym = pdaSingle(popSymRaw);
    return rule;
  }

  /* פירוק כלל לחלקיו הסמנטיים. תומך גם בפורמט הישן ({pop:'A'}). */
  function pdaRuleParts(r) {
    r = r || {};
    if (r.op !== undefined) {
      const op = String(r.op || '').toLowerCase();
      const validAction = op === 'push' || op === 'pop' || op === 'none';
      const read = pdaSingle(r.read), guard = pdaSingle(r.top);
      const removeTop = op === 'pop';
      const rawPush = pdaTokens(r.push);
      const popSym = removeTop && r.popSym != null ? pdaSingle(r.popSym) : '';
      return {
        read, guard, removeTop, op,
        push: op === 'push' ? rawPush : [],
        popSym,
        invalidAction: !validAction,
        missingPush: op === 'push' && rawPush.length === 0,
        multiPushUndefined: op === 'push' && rawPush.length > 1,
        unreadableField: [read, guard, popSym, ...rawPush].includes('?'),
        invalidCombined: removeTop && rawPush.length > 0,
      };
    }
    const lp = r.pop || '';                    /* פורמט ישן: pop = הסימן שנבדק ונשלף */
    const read = pdaSingle(r.read), guard = pdaSingle(lp);
    const push = pdaTokens(r.push);
    return {
      read, guard, removeTop: guard !== '',
      op: guard !== '' ? 'pop' : (push.length ? 'push' : 'none'), push,
      popSym: guard, invalidAction: false, missingPush: false,
      multiPushUndefined: guard === '' && push.length > 1,
      unreadableField: [read,guard,...push].includes('?'),
      invalidCombined: guard !== '' && push.length > 0,
    };
  }

  function pdaRuleKey(rule) {
    const P = pdaRuleParts(rule);
    return [
      P.read || '',
      P.guard || '',
      P.op || (P.removeTop ? 'pop' : (P.push.length ? 'push' : 'none')),
      P.push.join(''),
      P.popSym || '',
    ].join('');
  }

  /* ── אימות סמנטי ────────────────────────────────────────────────────────
     מחזיר רשימת בעיות. האימות *רק בודק ומדווח* — הוא לעולם אינו משכתב
     את הקריאה החזותית. בעיה סמנטית שונה במהותה מ-confidence חזותי נמוך:
     confidence אומר "אולי קראתי לא נכון", בעיה סמנטית אומרת "מה שנקרא
     אינו כלל חוקי". */
  const PDA_ISSUE = {
    POP_SYMBOL_MISMATCH: 'POP_SYMBOL_MISMATCH',
    POP_BOTTOM: 'POP_BOTTOM',
    PUSH_BOTTOM: 'PUSH_BOTTOM',
    POP_SYMBOL_MISSING: 'POP_SYMBOL_MISSING',
    PUSH_SYMBOL_MISSING: 'PUSH_SYMBOL_MISSING',
    MULTI_PUSH_UNDEFINED: 'MULTI_PUSH_UNDEFINED',
    UNREADABLE_FIELD: 'UNREADABLE_FIELD',
    UNKNOWN_ACTION: 'UNKNOWN_ACTION',
    UNSUPPORTED_COMBINED_ACTION: 'UNSUPPORTED_COMBINED_ACTION',
  };

  function pdaRuleSemanticIssues(rule) {
    const P = pdaRuleParts(rule);
    const issues = [];
    if (P.invalidAction) {
      issues.push({
        code: PDA_ISSUE.UNKNOWN_ACTION,
        text: 'פעולת המחסנית חסרה או אינה מזוהה; אי־אפשר לבצע אותה כ״ללא שינוי״',
        en: 'Stack action is missing or unknown and cannot execute as NONE',
      });
    }
    if (P.missingPush) {
      issues.push({
        code: PDA_ISSUE.PUSH_SYMBOL_MISSING,
        text: 'חסר סימן מפורש לדחיפה באזור הפעולה הימני',
        en: 'PUSH action symbol is missing',
      });
    }
    if (P.multiPushUndefined) {
      issues.push({
        code: PDA_ISSUE.MULTI_PUSH_UNDEFINED,
        text: 'דחיפה של יותר מסימן אחד בפעולה אחת טרם הוגדרה; הערכים נשמרו אך הכלל אינו מבוצע',
        en: 'Multi-symbol PUSH semantics are not defined',
      });
    }
    if (P.unreadableField) {
      issues.push({
        code: PDA_ISSUE.UNREADABLE_FIELD,
        text: 'אחד משדות הכלל חסר, רב־סימני במקום שבו נדרש פריט יחיד, או לא־קריא (?)',
        en: 'A required single-symbol field is missing, multi-symbol, or unreadable',
      });
    }
    if (P.invalidCombined) {
      issues.push({
        code: PDA_ISSUE.UNSUPPORTED_COMBINED_ACTION,
        text: 'הכלל מכיל גם שליפה וגם דחיפה; המשמעות של פעולה משולבת טרם הוגדרה ולכן הוא אינו מבוצע',
        en: 'Combined POP+PUSH is not defined and cannot be executed',
      });
    }
    /* ⊥ אינו סימן מחסנית רגיל: הוא מופיע פעם אחת בלבד בתחתית. גם אם
       STACK_TOP שונה, אסור ליצור מופע נוסף שלו באמצעות PUSH. */
    if (P.op === 'push' && P.push.includes(PDA_BOTTOM)) {
      issues.push({
        code: PDA_ISSUE.PUSH_BOTTOM,
        text: `אסור לדחוף את סימן התחתית «${PDA_BOTTOM}» — הוא קיים פעם אחת בלבד בתחתית המחסנית`,
        en: `PUSH of the bottom marker ${PDA_BOTTOM} is never allowed`,
      });
    }
    if (!P.removeTop) return issues;
    if (!P.popSym) {
      issues.push({
        code: PDA_ISSUE.POP_SYMBOL_MISSING,
        text: 'חסר סימן שליפה מפורש באזור הפעולה הימני',
        en: 'POP action symbol is missing',
      });
    }
    /* כלל מחייב: ACTION.symbol חייב להיות זהה ל-STACK_TOP.
       כאשר אחד מהם ריק (ε) איננו מכריעים — נושאי ε עדיין פתוחים. */
    if (P.popSym && P.guard && P.popSym !== P.guard) {
      issues.push({
        code: PDA_ISSUE.POP_SYMBOL_MISMATCH,
        text: `סימן השליפה «${P.popSym}» אינו זהה לראש המחסנית «${P.guard}»`,
        en: `POP symbol ${P.popSym} does not match STACK_TOP ${P.guard}`,
      });
    }
    /* איסור מוחלט: אין לשלוף את ⊥ בשום מצב. */
    if (P.popSym === PDA_BOTTOM || P.guard === PDA_BOTTOM) {
      issues.push({
        code: PDA_ISSUE.POP_BOTTOM,
        text: `אסור לשלוף את סימן התחתית «${PDA_BOTTOM}» — המחסנית לעולם אינה מתרוקנת`,
        en: `POP of the bottom marker ${PDA_BOTTOM} is never allowed`,
      });
    }
    return issues;
  }

  /* כלל עם בעיה סמנטית אינו ניתן לביצוע. הוא נשמר, מוצג ומסומן — אך
     הסימולטור מסרב להפעיל אותו, גם אם הגיע מסריקה או מייבוא. */
  function pdaRuleBlocked(rule) { return pdaRuleSemanticIssues(rule).length > 0; }

  /* ── מצב המחסנית ────────────────────────────────────────────────────────
     מחסנית ריקה אינה מצב תחתית תקין. מצב התחתית התקין הוא בדיוק [⊥]. */
  function pdaInitialStack() { return [PDA_BOTTOM]; }
  function pdaStackAtBottom(stack) {
    const s = pdaTokens(stack);
    return s.length === 1 && s[0] === PDA_BOTTOM;
  }

  /* האם הכלל ישים על הקונפיגורציה הנוכחית — לפי INPUT ולפי STACK_TOP יחד. */
  function pdaPartsApplicable(P, pos, stack, input) {
    if (P.invalidAction || P.missingPush || P.multiPushUndefined || P.unreadableField || P.invalidCombined) return false;
    if (P.op === 'push' && P.push.includes(PDA_BOTTOM)) return false;             /* לעולם לא דוחפים ⊥ */
    if (P.read && (pos >= input.length || input[pos] !== P.read)) return false;   /* הקלט אינו תואם */
    if (P.guard && stack[0] !== P.guard) return false;                            /* אין את הסימן הנדרש בראש */
    if (P.removeTop) {
      if (!stack.length) return false;
      if (!P.popSym || stack[0] !== P.popSym) return false; /* שולפים רק את הסימן שנמצא בפועל בראש */
      if (stack[0] === PDA_BOTTOM) return false;      /* מחסום ריצה: לעולם לא שולפים ⊥ */
      if (stack.length <= 1) return false;            /* המחסנית לא תרוקן */
    }
    return true;
  }

  /* הפעלת הכלל על המחסנית. מחזיר מחסנית חדשה, או null אם אסור.
     PUSH מוסיף מעל הראש הקיים ואינו מסיר אותו; POP מסיר רק את העליון. */
  function pdaApplyToStack(P, stack) {
    if (P.invalidAction || P.missingPush || P.multiPushUndefined || P.unreadableField || P.invalidCombined) return null;
    if (P.op === 'push' && P.push.includes(PDA_BOTTOM)) return null;
    if (P.removeTop) {
      if (!P.popSym) return null;
      if (P.guard && P.popSym !== P.guard) return null;
      if (P.popSym === PDA_BOTTOM || P.guard === PDA_BOTTOM) return null;
      if (!stack.length || stack[0] === PDA_BOTTOM || stack.length <= 1) return null;
      if (stack[0] !== P.popSym) return null;
      if (P.guard && stack[0] !== P.guard) return null;
      return stack.slice(1);
    }
    return P.push.concat(stack.slice());
  }

  /* כל הכללים הישימים מהמצב הנתון. חץ פיזי אחד יכול לשאת כמה כללים
     עצמאיים; כאן הם נבדקים אחד-אחד, ולא מבוצעים ברצף. ייתכן שאף כלל
     אינו מתאים — ואז החץ פשוט אינו שמיש בקונפיגורציה הזאת. */
  function pdaApplicableRules(transitions, stateId, pos, stack, input) {
    const out = [];
    for (const t of transitions || []) {
      if (t.from !== stateId) continue;
      for (const r of (t.rules || [])) {
        if (r && r.scanIncomplete) continue;             /* ראיה חזותית חסרה — נדרש אישור אדם */
        if (pdaRuleBlocked(r)) continue;              /* כלל לא-תקין אינו מבוצע */
        const P = pdaRuleParts(r);
        if (!pdaPartsApplicable(P, pos, stack, input)) continue;
        out.push({ t, r, P });
      }
    }
    return out;
  }

  /* תיאור מילולי של הפעולה, בפורמט המאושר. */
  function pdaActionText(rule) {
    const P = pdaRuleParts(rule);
    if (P.invalidAction) return 'פעולה לא מזוהה';
    if (P.removeTop) return 'שלוף ' + (P.popSym || 'ε');
    if (P.op === 'push' && P.missingPush) return 'דחוף ?';
    if (P.push.length) return 'דחוף ' + P.push.join('');
    return 'ללא שינוי';
  }

  return {
    PDA_BOTTOM,
    PDA_ISSUE,
    pdaNormSym,
    pdaTokenize,
    pdaTokens,
    pdaTok1,
    pdaMakeRule,
    pdaRuleParts,
    pdaRuleKey,
    pdaRuleSemanticIssues,
    pdaRuleBlocked,
    pdaInitialStack,
    pdaStackAtBottom,
    pdaPartsApplicable,
    pdaApplyToStack,
    pdaApplicableRules,
    pdaActionText,
  };
});
