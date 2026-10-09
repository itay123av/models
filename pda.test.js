/* בדיקות לסמנטיקה של אוטומט מחסנית — לפי המפרט שאושר בשיחה.
   כל הבדיקות דטרמיניסטיות ואינן פונות לרשת או למודל ראייה. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./pda-core.js');
const {
  PDA_BOTTOM, PDA_ISSUE,
  pdaMakeRule, pdaRuleParts, pdaRuleKey,
  pdaRuleSemanticIssues, pdaRuleBlocked,
  pdaInitialStack, pdaStackAtBottom,
  pdaApplyToStack, pdaApplicableRules,
} = core;

/* מריץ את המכונה כמו הסימולטור הדטרמיניסטי: בכל צעד בוחר את הכלל הישים
   הראשון, מפעיל אותו, ושומר את כל היסטוריית המחסנית לבדיקה. */
function run(transitions, startId, input, maxSteps = 200) {
  let state = startId, pos = 0, stack = pdaInitialStack();
  const trace = [{ state, pos, stack: [...stack] }];
  for (let g = 0; g < maxSteps; g++) {
    const apps = pdaApplicableRules(transitions, state, pos, stack, input);
    if (!apps.length) return { state, pos, stack, trace, outcome: 'stuck', steps: g };
    const { t, P } = apps[0];
    const next = pdaApplyToStack(P, stack);
    if (next === null) return { state, pos, stack, trace, outcome: 'blocked', steps: g };
    stack = next;
    if (P.read) pos++;
    state = t.to;
    trace.push({ state, pos, stack: [...stack] });
    if (pos === input.length && pdaApplicableRules(transitions, state, pos, stack, input).length === 0) {
      return { state, pos, stack, trace, outcome: 'halted', steps: g + 1 };
    }
  }
  return { state, pos, stack, trace, outcome: 'maxsteps', steps: maxSteps };
}

const arrow = (id, from, to, rules) => ({ id, from, to, rules });

/* ═════════ 1. המחסנית מתחילה עם ⊥ ═════════ */
test('1. the stack starts with exactly one ⊥', () => {
  assert.equal(PDA_BOTTOM, '⊥');
  assert.deepEqual(pdaInitialStack(), ['⊥']);
  assert.equal(pdaStackAtBottom(['⊥']), true);
  // מחסנית ריקה אינה מצב תחתית תקין
  assert.equal(pdaStackAtBottom([]), false);
  assert.equal(pdaStackAtBottom(['A', '⊥']), false);
});

/* ═════════ 2. PUSH מוסיף מעל הראש הקיים ═════════ */
test('2. PUSH B over A leaves A directly under B', () => {
  const rule = pdaMakeRule('a', 'A', 'push', 'B');
  const P = pdaRuleParts(rule);
  const after = pdaApplyToStack(P, ['A', '⊥']);
  assert.deepEqual(after, ['B', 'A', '⊥'], 'הראש הישן A נשאר, ירד שכבה אחת');
  assert.equal(after.length, 3, 'שני פריטים נפרדים — לא סימן אחד מאוחד');
});

test('2b. PUSH A over A creates two separate A items, never the symbol "AA"', () => {
  const P = pdaRuleParts(pdaMakeRule('a', 'A', 'push', 'A'));
  const after = pdaApplyToStack(P, ['A', '⊥']);
  assert.deepEqual(after, ['A', 'A', '⊥']);
  assert.equal(after.includes('AA'), false);
});

test('2c. PUSH never removes or replaces the stack top', () => {
  const P = pdaRuleParts(pdaMakeRule('b', '⊥', 'push', 'S'));
  assert.deepEqual(pdaApplyToStack(P, ['⊥']), ['S', '⊥'], '⊥ נשאר בתחתית');
});

/* ═════════ 3-5. סמנטיקת POP ═════════ */
test('3. POP A when the top is A succeeds and removes only the top item', () => {
  const rule = pdaMakeRule('a', 'A', 'pop', '', 'A');
  assert.deepEqual(pdaRuleSemanticIssues(rule), []);
  assert.equal(pdaRuleBlocked(rule), false);
  assert.deepEqual(pdaApplyToStack(pdaRuleParts(rule), ['A', 'X', '⊥']), ['X', '⊥']);
});

test('4. POP B when the top is A is reported as invalid and never executed', () => {
  const rule = pdaMakeRule('a', 'A', 'pop', '', 'B');
  const issues = pdaRuleSemanticIssues(rule);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, PDA_ISSUE.POP_SYMBOL_MISMATCH);
  assert.match(issues[0].en, /POP symbol B does not match STACK_TOP A/);
  assert.equal(pdaRuleBlocked(rule), true);

  // שני הערכים נשמרים כפי שנקראו — שום צד לא נבחר אוטומטית
  const P = pdaRuleParts(rule);
  assert.equal(P.guard, 'A', 'STACK_TOP נשמר');
  assert.equal(P.popSym, 'B', 'סימן השליפה נשמר');

  // והסימולטור מסרב להפעיל אותו
  const transitions = [arrow('t1', 'q0', 'q1', [rule])];
  assert.deepEqual(pdaApplicableRules(transitions, 'q0', 0, ['A', '⊥'], 'a'), []);
});

test('5. POP ⊥ always fails — as a rule and at runtime', () => {
  const rule = pdaMakeRule('a', '⊥', 'pop', '', '⊥');
  const issues = pdaRuleSemanticIssues(rule);
  assert.equal(issues.some(x => x.code === PDA_ISSUE.POP_BOTTOM), true);
  assert.equal(pdaRuleBlocked(rule), true);
  assert.deepEqual(pdaApplicableRules([arrow('t', 'q0', 'q1', [rule])], 'q0', 0, ['⊥'], 'a'), []);
  // גם כלל שנראה תקין לא יוכל לשלוף ⊥ בזמן ריצה
  const loose = pdaMakeRule('a', '', 'pop', '', 'A');
  assert.deepEqual(pdaRuleSemanticIssues(loose), [], 'כלל ε אינו מסומן — נושאי ε עדיין פתוחים');
  assert.equal(pdaApplyToStack(pdaRuleParts(loose), ['⊥']), null, 'ובכל זאת השליפה נחסמת');
});

test('5a. PUSH ⊥ always fails — aliases, imports and direct runtime calls cannot bypass it', () => {
  for (const written of ['⊥', 'Z0', 'Z₀', 'Z_0', '⟂']) {
    const rule = pdaMakeRule('a', 'A', 'push', written);
    const issues = pdaRuleSemanticIssues(rule);
    assert.equal(issues.some(x => x.code === PDA_ISSUE.PUSH_BOTTOM), true, `${written} מזוהה כסמן תחתית מוגן`);
    assert.equal(pdaRuleBlocked(rule), true);
    assert.deepEqual(pdaApplicableRules([arrow('t', 'q0', 'q1', [rule])], 'q0', 0, ['A', '⊥'], 'a'), []);
    assert.equal(pdaApplyToStack(pdaRuleParts(rule), ['A', '⊥']), null);
  }
});

test('5b. an explicitly missing POP symbol is not inferred from STACK_TOP', () => {
  const rule = pdaMakeRule('a', 'A', 'pop', '', '');
  const P = pdaRuleParts(rule);
  assert.equal(P.guard, 'A');
  assert.equal(P.popSym, '', 'השדה הימני נשאר חסר');
  assert.equal(pdaRuleSemanticIssues(rule).some(x => x.code === PDA_ISSUE.POP_SYMBOL_MISSING), true);
  assert.equal(pdaRuleBlocked(rule), true);
  assert.equal(pdaApplyToStack(P, ['A', '⊥']), null);
});

test('5c. direct stack application also rejects a mismatched POP', () => {
  const P = pdaRuleParts(pdaMakeRule('a', 'A', 'pop', '', 'B'));
  assert.equal(pdaApplyToStack(P, ['A', '⊥']), null);
});

test('5d. inconsistent imported actions cannot silently change meaning', () => {
  const staleNone = pdaRuleParts({ read: 'a', top: 'A', op: 'none', push: ['B'] });
  assert.deepEqual(staleNone.push, [], 'NONE מתעלם משדה push ישן ולא דוחף');
  assert.deepEqual(pdaApplyToStack(staleNone, ['A', '⊥']), ['A', '⊥']);

  const combined = { read: 'a', pop: 'A', push: 'B' };
  const issues = pdaRuleSemanticIssues(combined);
  assert.equal(issues.some(x => x.code === PDA_ISSUE.UNSUPPORTED_COMBINED_ACTION), true);
  assert.equal(pdaRuleBlocked(combined), true, 'POP+PUSH הישן נשמר אך לא מקבל פירוש חדש בשקט');
  assert.equal(pdaApplyToStack(pdaRuleParts(combined), ['A', '⊥']), null);
});

test('5e. POP verifies the actual runtime top even when called directly', () => {
  const exact = pdaMakeRule('a', 'A', 'pop', '', 'A');
  const transitions = [arrow('t', 'q0', 'q1', [exact])];
  assert.deepEqual(pdaApplicableRules(transitions, 'q0', 0, ['B', '⊥'], 'a'), []);
  assert.equal(pdaApplyToStack(pdaRuleParts(exact), ['B', '⊥']), null,
    'אסור להסיר B כאשר ACTION.symbol הוא A');

  const noGuard = pdaMakeRule('a', '', 'pop', '', 'A');
  assert.equal(pdaApplyToStack(pdaRuleParts(noGuard), ['B', '⊥']), null,
    'גם בלי guard מפורש אי אפשר לשלוף סימן שאינו נמצא בפועל בראש');
});

test('5f. UNKNOWN actions and PUSH without a symbol never execute as NONE', () => {
  const unknown = pdaMakeRule('a', 'A', 'unknown', '', '');
  assert.equal(pdaRuleSemanticIssues(unknown).some(x => x.code === PDA_ISSUE.UNKNOWN_ACTION), true);
  assert.equal(pdaRuleBlocked(unknown), true);
  assert.equal(pdaApplyToStack(pdaRuleParts(unknown), ['A', '⊥']), null);

  const missingPush = pdaMakeRule('a', 'A', 'push', '', '');
  assert.equal(pdaRuleSemanticIssues(missingPush).some(x => x.code === PDA_ISSUE.PUSH_SYMBOL_MISSING), true);
  assert.equal(pdaRuleBlocked(missingPush), true);
  assert.equal(pdaApplyToStack(pdaRuleParts(missingPush), ['A', '⊥']), null);
  assert.deepEqual(pdaApplicableRules([arrow('t', 'q0', 'q1', [missingPush])], 'q0', 0, ['A', '⊥'], 'a'), []);
});

test('5g. multi-symbol PUSH is preserved but blocked until its open semantics are defined', () => {
  const rule = pdaMakeRule('a', 'A', 'push', 'BC', '');
  const P = pdaRuleParts(rule);
  assert.deepEqual(P.push, ['B', 'C'], 'הראיה נשמרת בלי לבחור סדר פעולה');
  assert.equal(pdaRuleSemanticIssues(rule).some(x => x.code === PDA_ISSUE.MULTI_PUSH_UNDEFINED), true);
  assert.equal(pdaApplyToStack(P, ['A', '⊥']), null);
});

test('6. the stack never becomes empty', () => {
  // מכונה שמנסה לשלוף שוב ושוב על אותה אות
  const rules = [pdaMakeRule('a', 'A', 'pop', '', 'A')];
  const transitions = [arrow('loop', 'q0', 'q0', rules)];
  const res = run(transitions, 'q0', 'aaaa');
  for (const step of res.trace) {
    assert.equal(step.stack.length >= 1, true, 'המחסנית מעולם אינה ריקה');
    assert.equal(step.stack[step.stack.length - 1], '⊥', '⊥ תמיד נשאר בתחתית');
  }
  assert.equal(res.stack.includes('⊥'), true);
});

/* ═════════ 7. ללא שינוי ═════════ */
test('7. NONE consumes the input and leaves the stack untouched', () => {
  const rule = pdaMakeRule('a', 'A', 'none', '');
  const P = pdaRuleParts(rule);
  assert.equal(P.removeTop, false);
  assert.deepEqual(P.push, []);
  const before = ['A', 'X', '⊥'];
  assert.deepEqual(pdaApplyToStack(P, before), before, 'המחסנית זהה לפני ואחרי');

  // אך התנאים עדיין נדרשים
  const transitions = [arrow('t', 'q0', 'q1', [rule])];
  assert.equal(pdaApplicableRules(transitions, 'q0', 0, ['A', '⊥'], 'a').length, 1);
  assert.equal(pdaApplicableRules(transitions, 'q0', 0, ['X', '⊥'], 'a').length, 0, 'ראש שגוי — לא ישים');
  assert.equal(pdaApplicableRules(transitions, 'q0', 0, ['A', '⊥'], 'b').length, 0, 'קלט שגוי — לא ישים');

  // ריצה אמיתית: קודם דוחפים A מעל ⊥, ואז מפעילים את כלל «ללא שינוי»
  const machine = [
    arrow('t0', 'q0', 'q1', [pdaMakeRule('', '⊥', 'push', 'A')]),
    arrow('t1', 'q1', 'q2', [rule]),
  ];
  const res = run(machine, 'q0', 'a');
  assert.equal(res.pos, 1, 'הקלט נצרך');
  assert.deepEqual(res.stack, ['A', '⊥'], 'המחסנית זהה למה שהייתה לפני כלל ה-«ללא שינוי»');
  assert.equal(res.state, 'q2');
});

/* ═════════ 8-11. כמה כללים על חץ פיזי אחד (הדוגמה q2→q3) ═════════ */
const q2q3 = [
  pdaMakeRule('b', '⊥', 'push', 'S'),
  pdaMakeRule('b', 'S', 'push', 'A'),
  pdaMakeRule('b', 'A', 'push', 'A'),
];
const q2q3Transitions = [arrow('t23', 'q2', 'q3', q2q3)];

test('8. one arrow carrying three rules stays a single arrow', () => {
  assert.equal(q2q3Transitions.length, 1, 'חץ אחד');
  assert.equal(q2q3Transitions[0].rules.length, 3, 'שלושה כללים');
  assert.equal(q2q3Transitions[0].from, 'q2');
  assert.equal(q2q3Transitions[0].to, 'q3');
  // אין מיזוג ואין השמטה: שלושת המפתחות שונים זה מזה
  const keys = new Set(q2q3.map(pdaRuleKey));
  assert.equal(keys.size, 3);
});

test('8b. rules sharing the same INPUT but a different STACK_TOP are not duplicates', () => {
  const a = pdaMakeRule('b', 'S', 'push', 'A');
  const b = pdaMakeRule('b', 'A', 'push', 'A');
  assert.notEqual(pdaRuleKey(a), pdaRuleKey(b));
  // וגם סימן שליפה שונה מייצר כלל נפרד
  assert.notEqual(
    pdaRuleKey(pdaMakeRule('a', 'A', 'pop', '', 'A')),
    pdaRuleKey(pdaMakeRule('a', 'A', 'pop', '', 'B')),
  );
});

test('9. in this example at most one rule matches a configuration, never a sequence', () => {
  const cases = [
    { stack: ['⊥'], expectPush: 'S' },
    { stack: ['S', '⊥'], expectPush: 'A' },
    { stack: ['A', 'S', '⊥'], expectPush: 'A' },
  ];
  for (const c of cases) {
    const apps = pdaApplicableRules(q2q3Transitions, 'q2', 0, c.stack, 'b');
    assert.equal(apps.length, 1, `בראש ${c.stack[0]} — לכל היותר כלל אחד מתאים`);
    assert.deepEqual(apps[0].P.push, [c.expectPush]);
    // הפעלה מוסיפה פריט אחד בלבד — לא שלוש פעולות ברצף
    const after = pdaApplyToStack(apps[0].P, c.stack);
    assert.equal(after.length, c.stack.length + 1, 'פריט אחד נוסף בלבד');
    assert.deepEqual(after.slice(1), c.stack, 'שאר המחסנית לא נגעה');
  }
});

test('10. when nothing matches INPUT+STACK_TOP the arrow is simply not usable', () => {
  // קלט שאינו b
  assert.deepEqual(pdaApplicableRules(q2q3Transitions, 'q2', 0, ['⊥'], 'a'), []);
  // b, אבל בראש סימן שאף כלל לא מכסה
  assert.deepEqual(pdaApplicableRules(q2q3Transitions, 'q2', 0, ['Q', '⊥'], 'b'), []);
  // אין כאן שגיאה ואין השלמה אוטומטית של אלפבית המחסנית
  const res = run(q2q3Transitions, 'q2', 'a');
  assert.equal(res.outcome, 'stuck');
  assert.deepEqual(res.stack, ['⊥'], 'המחסנית לא השתנתה');
});

test('11. a PUSH whose symbol differs from STACK_TOP is never flagged', () => {
  const rule = pdaMakeRule('a', 'A', 'push', 'B');
  assert.deepEqual(pdaRuleSemanticIssues(rule), []);
  assert.equal(pdaRuleBlocked(rule), false);
  assert.equal(pdaApplicableRules([arrow('t', 'q0', 'q1', [rule])], 'q0', 0, ['A', '⊥'], 'a').length, 1);
  // וגם הכלל מהדוגמה: b,⊥ / דחוף S
  assert.deepEqual(pdaRuleSemanticIssues(pdaMakeRule('b', '⊥', 'push', 'S')), []);
});

/* ═════════ נרמול תוצאת סריקה (צד השרת) ═════════ */
const server = require('./server.js');

function scanRule(over = {}) {
  return Object.assign({
    raw_label_text: 'a,A / A שלוף',
    read_input: { value: 'a', confidence: 0.9 },
    stack_action: { type: 'POP', confidence: 0.9 },
    push_value: { value: 'ε', confidence: 0.9 },
    pop_value: { value: 'A', confidence: 0.9 },
    pop_symbol: { value: 'A', confidence: 0.9 },
    zones: { left_text: 'a', middle_text: 'A', right_text: 'A שלוף' },
    line_bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.08 },
  }, over);
}
function scanPayload(rules) {
  return {
    states: [{ id: 'q0', is_start: true, is_accepting: false }, { id: 'q1', is_start: false, is_accepting: true }],
    transitions: [{
      transition_id: 't1',
      visible_rule_line_count: rules.length,
      source_state: { id: 'q0', confidence: 0.95 },
      target_state: { id: 'q1', confidence: 0.95 },
      rules,
    }],
  };
}

test('12. a contradictory scan result is kept as read and flagged, never silently fixed', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({ raw_label_text: 'a,A / B שלוף', pop_value: { value: 'A', confidence: 0.9 }, pop_symbol: { value: 'B', confidence: 0.9 } }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.pop_value.value, 'A', 'STACK_TOP נשמר כפי שנקרא');
  assert.equal(rule.pop_symbol.value, 'B', 'סימן השליפה נשמר כפי שנקרא');
  assert.equal(rule.semantic_issues.length, 1);
  assert.match(rule.semantic_issues[0], /POP symbol B does not match STACK_TOP A/);
  assert.equal(rule.raw_label_text, 'a,A / B שלוף', 'הטקסט הגולמי לא שוכתב');
});

test('12a. an ambiguous spatial field cannot confirm its first letter or epsilon', () => {
  for (const literal of ['a / ε', 'bε', 'a,b', 'epsilon']) {
    const payload=scanPayload([scanRule({
      zones:{left_text:literal,middle_text:'A',right_text:'A שלוף'},
    })]);
    const rule=server.normalizePayload(payload,'',true,false).transitions[0].rules[0];
    assert.equal(rule.scan_incomplete,true,literal);
    assert.equal(rule.zones.left_text,literal,'raw spatial evidence is unchanged');
    assert.match(rule.field_notes.join(' | '),/left-zone symbol is missing or unreadable/);
  }
});

test('12b. POP of ⊥ from a scan is reported, not repaired', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({ raw_label_text: 'a,⊥ / ⊥ שלוף', pop_value: { value: '⊥', confidence: 0.9 }, pop_symbol: { value: '⊥', confidence: 0.9 } }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.pop_value.value, '⊥');
  assert.equal(rule.pop_symbol.value, '⊥');
  assert.match(rule.semantic_issues.join(' '), /bottom marker ⊥ is never allowed/);
});

test('12b2. PUSH of ⊥ from a scan is preserved for review but marked incomplete and never repaired', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'a,A / ⊥ דחוף',
      stack_action: { type: 'PUSH', confidence: 0.9 },
      push_value: { value: '⊥', confidence: 0.9 },
      pop_value: { value: 'A', confidence: 0.9 },
      pop_symbol: { value: 'ε', confidence: 0.9 },
      zones: { left_text: 'a', middle_text: 'A', right_text: '⊥ דחוף' },
    }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.push_value.value, '⊥', 'הראיה החזותית נשמרת ולא משוכתבת');
  assert.match(rule.semantic_issues.join(' '), /PUSH of the bottom marker ⊥ is never allowed/);
  assert.equal(rule.scan_incomplete, true, 'הכלל מחייב בדיקה ואינו הופך לכלל מאושר');
});

test('12c. the spatial read wins over the flat raw text — a disagreement is only reported', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'c,S / S שלוף',            // טקסט גולמי שאומר משהו אחר
      read_input: { value: 'a', confidence: 0.9 },
      pop_value: { value: 'A', confidence: 0.9 },
      pop_symbol: { value: 'A', confidence: 0.9 },
    }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.read_input.value, 'a', 'הפענוח המרחבי לא נדרס');
  assert.equal(rule.pop_value.value, 'A', 'הפענוח המרחבי לא נדרס');
  assert.equal(rule.pop_symbol.value, 'A', 'הפענוח המרחבי לא נדרס');
  // שלושת האזורים נחלקים — קלט, ראש מחסנית וסימן הפעולה
  const notes = rule.field_notes.join(' | ');
  assert.match(notes, /input "c"/);
  assert.match(notes, /stack-top "S"/);
  assert.match(notes, /pop symbol "S"/);
  assert.ok(rule.read_input.confidence < 0.9, 'הביטחון ירד');
  assert.deepEqual(rule.semantic_issues, [], 'פער מול הטקסט הגולמי אינו בעיה סמנטית');
  assert.equal(rule.raw_label_text, 'c,S / S שלוף', 'הטקסט הגולמי נשמר לביקורת');
});

test('12d. structured spatial ACTION wins over contradictory flat OCR', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'a,A / A שלוף',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'B דחוף' },
      stack_action: { type: 'PUSH', confidence: 0.94 },
      push_value: { value: 'B', confidence: 0.93 },
      pop_symbol: { value: 'ε', confidence: 0.91 },
    }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.stack_action.type, 'PUSH', 'הטקסט השטוח לא הפך PUSH ל-POP');
  assert.equal(rule.push_value.value, 'B');
  assert.equal(rule.pop_symbol.value, 'ε');
  assert.match(rule.field_notes.join(' | '), /raw label suggests action POP/);
  assert.ok(rule.stack_action.confidence < 0.94, 'הסתירה מסומנת בביטחון, בלי שינוי ערך');
});

test('12e. missing POP action symbol remains missing and is reported', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({ pop_symbol: { value: '', confidence: 0.9 }, zones: { left_text: 'a', middle_text: 'A', right_text: 'שלוף ?' } }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.pop_symbol.value, '?', 'אסור להשלים את הסימן מ-STACK_TOP');
  assert.match(rule.semantic_issues.join(' | '), /missing or unreadable/);
  assert.equal(rule.scan_incomplete, true);
});

test('12f. unreadable glyph is unknown, never epsilon', () => {
  assert.equal(server.normalizeSymbolValue('□'), '?');
  const out = server.normalizePayload(scanPayload([
    scanRule({ read_input: { value: '□', confidence: 0.9 }, zones: { left_text: '□', middle_text: 'A', right_text: 'A שלוף' } }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.read_input.value, '?');
  assert.equal(rule.scan_incomplete, true);
  assert.ok(rule.read_input.confidence <= 0.55);
});

test('12g. no start arrow means no state is invented as start', () => {
  const payload = scanPayload([scanRule()]);
  payload.states.forEach(s => { s.is_start = false; });
  const out = server.normalizePayload(payload, '', true, false);
  assert.equal(out.states.some(s => s.is_start), false);
  assert.match(out.scan_issues.join(' | '), /No start arrow/);
});

test('12h. invalid line coordinates are discarded and audited', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({ line_bbox: { x: 0.9, y: 0.2, w: 0.5, h: 0.1 } }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.deepEqual(rule.line_bbox, { x: -1, y: -1, w: -1, h: -1 });
  assert.match(rule.field_notes.join(' | '), /line_bbox was invalid/);
});

test('12i. an unfamiliar right-zone action remains UNKNOWN instead of being guessed', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'a,A / □', zones: { left_text: 'a', middle_text: 'A', right_text: '□' },
      stack_action: { type: 'UNKNOWN', confidence: 0.4 }, push_value: { value: 'ε', confidence: 0.4 },
      pop_symbol: { value: 'ε', confidence: 0.4 },
    }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.stack_action.type, 'UNKNOWN');
  assert.equal(rule.scan_incomplete, true);
  assert.match(rule.field_notes.join(' | '), /unapproved notation/);
});

test('12j. Latin E/e stay literal symbols and are never normalized to epsilon', () => {
  assert.equal(server.normalizeSymbolValue('E'), 'E');
  assert.equal(server.normalizeSymbolValue('e'), 'e');
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'E,A / A שלוף',
      zones: { left_text: 'E', middle_text: 'A', right_text: 'A שלוף' },
      read_input: { value: 'E', confidence: 0.9 },
    }),
  ]), '', true, false);
  assert.equal(out.transitions[0].rules[0].read_input.value, 'E');
});

test('12k. missing structured ACTION remains review-only even when the right zone looks familiar', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'a,A / B דחוף',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'B דחוף' },
      stack_action: undefined,
      push_value: { value: 'B', confidence: 0.9 },
      pop_symbol: { value: 'ε', confidence: 0.9 },
    }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.stack_action.type, 'PUSH', 'האזור הימני נשמר כהצעת פענוח מרחבית');
  assert.equal(rule.scan_incomplete, true, 'אך אין להריץ ללא שדה ACTION מובנה מפורש');
  assert.match(rule.field_notes.join(' | '), /structured ACTION is missing/);
});

test('12l. no start property, missing endpoints, and an empty rules array are never fabricated', () => {
  const payload = scanPayload([scanRule()]);
  payload.states.forEach(s => { delete s.is_start; });
  const noStart = server.normalizePayload(payload, '', true, false);
  assert.equal(noStart.states.some(s => s.is_start), false);

  const unresolved = server.normalizePayload({
    states: [],
    transitions: [{
      transition_id: 'unresolved',
      visible_rule_line_count: 0,
      source_state: { id: '', confidence: 0.4 },
      target_state: { id: 'q9', confidence: 0.95 },
      rules: [],
    }],
  }, '', true, false);
  assert.equal(unresolved.transitions[0].source_state.id, '');
  assert.equal(unresolved.transitions[0].target_state.id, 'q9');
  assert.deepEqual(unresolved.transitions[0].rules, []);
  assert.deepEqual(unresolved.states.map(s => s.id), ['q9'], 'לא הומצאו q0/q1');
  assert.match(unresolved.scan_issues.join(' | '), /unresolved source or target/);
});

test('12m. unresolved NONE symbols and mixed action words are preserved and blocked for review', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'a,A / ללא שינוי B',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'ללא שינוי B' },
      stack_action: { type: 'NONE', confidence: 0.95 },
      push_value: { value: 'ε', confidence: 0.95 },
      pop_symbol: { value: 'ε', confidence: 0.95 },
    }),
    scanRule({
      raw_label_text: 'a,A / A שלוף B דחוף',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'A שלוף B דחוף' },
      stack_action: { type: 'POP', confidence: 0.95 },
      pop_symbol: { value: 'A', confidence: 0.95 },
    }),
    scanRule({
      raw_label_text: 'a,A / ללא שינוי',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'ללא שינוי' },
      stack_action: { type: 'NONE', confidence: 0.95 },
      push_value: { value: 'B', confidence: 0.95 },
      pop_symbol: { value: 'C', confidence: 0.95 },
    }),
  ]), '', true, false);
  const [noneWithZoneSymbol, mixed, noneWithStructuredSymbols] = out.transitions[0].rules;
  assert.equal(noneWithZoneSymbol.scan_incomplete, true);
  assert.match(noneWithZoneSymbol.field_notes.join(' | '), /meaning is not defined/);
  assert.equal(mixed.stack_action.type, 'POP', 'השדה המובנה נשמר ולא נדרס');
  assert.equal(mixed.scan_incomplete, true);
  assert.match(mixed.field_notes.join(' | '), /right-zone operation is missing/);
  assert.equal(noneWithStructuredSymbols.scan_incomplete, true);
  assert.equal(noneWithStructuredSymbols.observed_fields.push_symbol, 'B');
  assert.equal(noneWithStructuredSymbols.observed_fields.pop_symbol, 'C');
  assert.equal(noneWithStructuredSymbols.push_value.value, 'ε', 'הערך אינו הופך לפעולה פעילה');
});

test('12n. an unlocalized bbox is incomplete and legacy text is never rewritten inside a larger token', () => {
  assert.equal(server.normalizeSymbolValue('AZ0B'), 'AZ0B');
  const out = server.normalizePayload(scanPayload([
    scanRule({ line_bbox: { x: -1, y: -1, w: -1, h: -1 } }),
  ]), '', true, false);
  assert.equal(out.transitions[0].rules[0].scan_incomplete, true);
  assert.match(out.transitions[0].rules[0].field_notes.join(' | '), /could not be localized/);
});

test('12o. unreadable zone evidence and a missing visible action symbol stay review-only', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: '?,A / A שלוף',
      zones: { left_text: '?', middle_text: 'A', right_text: 'A שלוף' },
    }),
    scanRule({
      raw_label_text: 'a,? / A שלוף',
      zones: { left_text: 'a', middle_text: '?', right_text: 'A שלוף' },
    }),
    scanRule({
      raw_label_text: 'a,A / דחוף',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'דחוף' },
      stack_action: { type: 'PUSH', confidence: 0.95 },
      push_value: { value: 'B', confidence: 0.95 },
      pop_symbol: { value: 'ε', confidence: 0.95 },
    }),
    scanRule({
      raw_label_text: 'a,A / שלוף',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'שלוף' },
      stack_action: { type: 'POP', confidence: 0.95 },
      push_value: { value: 'ε', confidence: 0.95 },
      pop_symbol: { value: 'A', confidence: 0.95 },
    }),
  ]), '', true, false);
  const [left, middle, push, pop] = out.transitions[0].rules;
  assert.equal(left.scan_incomplete, true);
  assert.match(left.field_notes.join(' | '), /left-zone symbol is missing or unreadable/);
  assert.equal(middle.scan_incomplete, true);
  assert.match(middle.field_notes.join(' | '), /middle-zone STACK_TOP symbol is missing or unreadable/);
  assert.equal(push.scan_incomplete, true);
  assert.match(push.field_notes.join(' | '), /PUSH symbol is missing or unreadable in the right-zone/);
  assert.equal(pop.scan_incomplete, true);
  assert.match(pop.field_notes.join(' | '), /POP symbol is missing or unreadable in the right-zone/);
});

test('12p. inactive action fields are preserved but block execution until reviewed', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'a,A / B דחוף',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'B דחוף' },
      stack_action: { type: 'PUSH', confidence: 0.95 },
      push_value: { value: 'B', confidence: 0.95 },
      pop_symbol: { value: 'C', confidence: 0.95 },
    }),
    scanRule({
      raw_label_text: 'a,A / A שלוף',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'A שלוף' },
      stack_action: { type: 'POP', confidence: 0.95 },
      push_value: { value: 'B', confidence: 0.95 },
      pop_symbol: { value: 'A', confidence: 0.95 },
    }),
  ]), '', true, false);
  const [push, pop] = out.transitions[0].rules;
  assert.equal(push.push_value.value, 'B');
  assert.equal(push.pop_symbol.value, 'ε', 'inactive POP value never becomes an active operation');
  assert.equal(push.observed_fields.pop_symbol, 'C');
  assert.equal(push.scan_incomplete, true);
  assert.match(push.field_notes.join(' | '), /inactive POP symbol/);
  assert.equal(pop.push_value.value, 'ε', 'inactive PUSH value never becomes an active operation');
  assert.equal(pop.pop_symbol.value, 'A');
  assert.equal(pop.observed_fields.push_symbol, 'B');
  assert.equal(pop.scan_incomplete, true);
  assert.match(pop.field_notes.join(' | '), /inactive PUSH symbol/);
});

test('12q. Vision keeps legacy-looking glyphs literal while explicit migration remains available', () => {
  const aliases = ['Z0', 'Z₀', 'Z_0', '⟂'];
  const out = server.normalizePayload(scanPayload(aliases.map(alias => scanRule({
    raw_label_text: `a,${alias} / B דחוף`,
    zones: { left_text: 'a', middle_text: alias, right_text: 'B דחוף' },
    stack_action: { type: 'PUSH', confidence: 0.95 },
    push_value: { value: 'B', confidence: 0.95 },
    pop_value: { value: alias, confidence: 0.95 },
    pop_symbol: { value: 'ε', confidence: 0.95 },
  }))), '', true, false);
  assert.deepEqual(out.transitions[0].rules.map(rule => rule.pop_value.value), aliases,
    'Vision transcription must not migrate a photographed legacy-looking glyph');
  assert.deepEqual(aliases.map(server.normalizeSymbolValue), ['⊥', '⊥', '⊥', '⊥'],
    'the explicit legacy normalizer remains available for versioned old data');
});

test('12r. state observations are never assigned invented q-labels or merged by visible id', () => {
  const out = server.normalizePayload({
    states: [
      { observation_id: 'circle_a', id: '', is_start: true, is_accepting: false, confidence: 0.9 },
      { observation_id: 'circle_b', id: 'q0', is_start: false, is_accepting: false, confidence: 0.9 },
      { observation_id: 'circle_c', id: 'q0', is_start: false, is_accepting: true, confidence: 0.9 },
    ],
    transitions: [],
  }, '', true, false);
  assert.equal(out.states.length, 3, 'one normalized observation survives for every physical circle row');
  assert.deepEqual(out.states.map(s => s.id), ['', 'q0', 'q0']);
  assert.equal(new Set(out.states.map(s => s.observation_id)).size, 3, 'internal observation ids are unique');
  assert.equal(out.states[0].scan_incomplete, true);
  assert.match(out.states[0].field_notes.join(' | '), /no semantic label was invented/);
  assert.equal(out.states[1].scan_incomplete, true);
  assert.equal(out.states[2].scan_incomplete, true);
  assert.match(out.scan_issues.join(' | '), /more than one physical circle/);
});

test('12s. endpoint observation ids disambiguate equal visible state labels', () => {
  const payload = scanPayload([scanRule()]);
  payload.states = [
    { observation_id: 'left_circle', id: 'q0', is_start: true, is_accepting: false, confidence: 0.95 },
    { observation_id: 'right_circle', id: 'q0', is_start: false, is_accepting: false, confidence: 0.95 },
    { observation_id: 'target_circle', id: 'q1', is_start: false, is_accepting: true, confidence: 0.95 },
  ];
  payload.transitions[0].source_state.observation_id = 'right_circle';
  payload.transitions[0].target_state.observation_id = 'target_circle';
  const out = server.normalizePayload(payload, '', true, false);
  assert.equal(out.states.filter(s => s.id === 'q0').length, 2, 'the two q0 circles were not merged');
  assert.equal(out.transitions[0].source_state.observation_id, out.states[1].observation_id);
  assert.equal(out.transitions[0].target_state.observation_id, out.states[2].observation_id);
});

test('12t. observed action preserves the raw structured token, not the right-zone fallback', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({
      stack_action: { type: 'BOGUS', confidence: 0.9 },
      zones: { left_text: 'a', middle_text: 'A', right_text: 'B דחוף' },
      push_value: { value: 'B', confidence: 0.9 },
      pop_symbol: { value: 'ε', confidence: 0.9 },
    }),
    scanRule({
      stack_action: undefined,
      zones: { left_text: 'a', middle_text: 'A', right_text: 'B דחוף' },
      push_value: { value: 'B', confidence: 0.9 },
      pop_symbol: { value: 'ε', confidence: 0.9 },
    }),
  ]), '', true, false);
  const [bogus, missing] = out.transitions[0].rules;
  assert.equal(bogus.stack_action.type, 'PUSH', 'the spatial right-zone fallback remains separately available');
  assert.equal(bogus.observed_fields.action, 'BOGUS');
  assert.equal(bogus.scan_incomplete, true);
  assert.equal(missing.stack_action.type, 'PUSH');
  assert.equal(missing.observed_fields.action, '');
  assert.equal(missing.scan_incomplete, true);
});

test('12u. visible rule-line count gates completeness without inventing missing rows', () => {
  const payload = scanPayload([scanRule()]);
  payload.transitions[0].visible_rule_line_count = 3;
  const quality = server.parseQualityProblems(payload, true, false);
  assert.match(quality.join(' | '), /visible_rule_line_count 3 does not match rules\.length 1/);
  const out = server.normalizePayload(payload, '', true, false);
  assert.equal(out.transitions[0].visible_rule_line_count, 3);
  assert.equal(out.transitions[0].rules.length, 1, 'the two absent transcriptions were not fabricated');
  assert.equal(out.transitions[0].rules[0].scan_incomplete, true);
  assert.match(out.transitions[0].rules[0].field_notes.join(' | '), /visible rule-line count 3/);
  assert.match(out.scan_issues.join(' | '), /3 visible rule lines but 1 transcribed rules/);

  payload.transitions[0].rules = [];
  const empty = server.normalizePayload(payload, '', true, false);
  assert.deepEqual(empty.transitions[0].rules, [], 'zero transcribed rows stays zero');
  assert.match(empty.scan_issues.join(' | '), /3 visible rule lines but 0 transcribed rules/);
});

test('12v. missing or malformed FA/TM reads remain unknown and review-only', () => {
  const base = {
    states: [{ id: 'q0', is_start: true, is_accepting: false, confidence: 0.95 }],
    transitions: [{
      transition_id: 't1', visible_rule_line_count: 1,
      source_state: { id: 'q0', confidence: 0.95 }, target_state: { id: 'q1', confidence: 0.95 },
      rules: [{ raw_label_text: '', read_input: { value: '', confidence: 0.95 } }],
    }],
  };
  const fa = server.normalizePayload(base, '', false, false).transitions[0].rules[0];
  assert.equal(fa.read_input.value, '?');
  assert.equal(fa.scan_incomplete, true);
  assert.match(fa.field_notes.join(' | '), /raw label evidence is missing|read field is missing/);

  base.transitions[0].rules[0].raw_label_text = 'not a TM label';
  const tm = server.normalizePayload(base, '', false, true).transitions[0].rules[0];
  assert.equal(tm.read_input.value, '?');
  assert.equal(tm.scan_incomplete, true);
  assert.match(tm.field_notes.join(' | '), /TM raw label is malformed|TM read symbol is missing/);
});

const unitBox = (x = 0.1, y = 0.1, w = 0.2, h = 0.1) => ({ x, y, w, h });
function mockedTopologyRaw(lineCount = 2) {
  return {
    visible_state_count: 2,
    visible_connector_count: 1,
    states: [
      { observation_id: 'state_left', bbox: unitBox(0.05, 0.4, 0.15, 0.2), is_start: { value: true, confidence: 0.95 }, is_accepting: { value: false, confidence: 0.96 }, confidence: 0.96, issues: [] },
      { observation_id: 'state_right', bbox: unitBox(0.75, 0.4, 0.15, 0.2), is_start: { value: false, confidence: 0.96 }, is_accepting: { value: true, confidence: 0.95 }, confidence: 0.96, issues: [] },
    ],
    start_marker_observations: [{
      marker_id: 'start_marker_1', target_observation_id: 'state_left',
      marker_bbox: unitBox(0.01, 0.47, 0.05, 0.04), arrowhead_bbox: unitBox(0.05, 0.47, 0.02, 0.02),
      confidence: 0.94, issues: [],
    }],
    connector_observations: [{
      connector_observation_id: 'connector_1',
      connector_bbox: unitBox(0.2, 0.45, 0.55, 0.1),
      arrowhead_bbox: unitBox(0.70, 0.45, 0.04, 0.04),
      label_block_bbox: unitBox(0.35, 0.25, 0.3, 0.18),
      visible_line_count: lineCount,
      line_hints: Array.from({ length: lineCount }, (_, index) => ({
        line_id: `line_${index + 1}`,
        bbox: unitBox(0.36, 0.26 + index * 0.07, 0.28, 0.05),
        confidence: 0.94,
        issues: [],
      })),
      confidence: 0.95,
      issues: [],
    }],
    transitions: [{
      transition_id: 'transition_1', connector_observation_id: 'connector_1',
      source_observation_id: 'state_left', target_observation_id: 'state_right',
      confidence: 0.95, issues: [],
    }],
    issues: [],
  };
}

test('12w. topology stage keeps physical identities and emits no semantic labels', () => {
  const out = server.normalizeTopologyStageResult(mockedTopologyRaw(), 'scan-contract-1');
  assert.equal(out.stage, 'topology');
  assert.equal(out.scan_session_id, 'scan-contract-1');
  assert.equal(out.review_only, false);
  assert.equal(out.topology.states.length, 2);
  assert.deepEqual(out.topology.states.map(s => s.observation_id), ['state_left', 'state_right']);
  assert.deepEqual(out.topology.states.map(s => s.visible_label), ['', ''], 'Stage A did not OCR state labels');
  assert.equal(out.topology.connector_observations.length, 1);
  assert.equal(out.topology.transitions.length, 1);
  assert.equal(out.topology.connectors.length, 1);
  assert.deepEqual(out.topology.transitions[0].line_hints.map(line => line.line_id), ['line_1', 'line_2']);
  assert.equal(out.topology.transitions[0].source_observation_id, 'state_left');
  assert.equal(out.topology.transitions[0].target_observation_id, 'state_right');
});

test('12x. topology count 8 versus 7 connectors remains unresolved and invents no eighth connector', () => {
  const raw = mockedTopologyRaw(0);
  raw.visible_connector_count = 8;
  raw.connector_observations = Array.from({ length: 8 }, (_, index) => ({
    connector_observation_id: `connector_${index + 1}`,
    connector_bbox: unitBox(0.1, 0.05 + index * 0.1, 0.7, 0.04),
    arrowhead_bbox: unitBox(0.75, 0.05 + index * 0.1, 0.03, 0.03),
    label_block_bbox: unitBox(0.35, 0.05 + index * 0.1, 0.2, 0.04),
    visible_line_count: 0, line_hints: [], confidence: 0.95, issues: [],
  }));
  raw.transitions = raw.connector_observations.slice(0, 7).map((observation, index) => ({
    transition_id: `transition_${index + 1}`,
    connector_observation_id: observation.connector_observation_id,
    source_observation_id: 'state_left', target_observation_id: 'state_right',
    confidence: 0.95, issues: [],
  }));
  const out = server.normalizeTopologyStageResult(raw, 'scan-8-vs-7');
  assert.equal(out.topology.connector_observations.length, 8);
  assert.equal(out.topology.transitions.length, 7, 'no connector object was fabricated');
  assert.equal(out.review_only, true);
  assert.match(out.topology.issues.join(' | '), /visible_connector_count 8 does not match topology connectors length 7/);
  assert.match(out.topology.issues.join(' | '), /connector_8.*no topology connector/);
});

test('12y. duplicate and foreign topology ids plus partial boxes are review-only evidence', () => {
  const raw = mockedTopologyRaw(1);
  raw.states[1].observation_id = 'state_left';
  raw.connector_observations[0].line_hints[0].bbox = { x: 0.2, y: 0.2, w: -1, h: 0.1 };
  raw.transitions[0].target_observation_id = 'foreign_state';
  const out = server.normalizeTopologyStageResult(raw, 'scan-bad-topology');
  assert.equal(out.topology.states.length, 2, 'duplicate observations were preserved separately');
  assert.equal(out.review_only, true);
  assert.match(out.topology.issues.join(' | '), /duplicate physical state observation_id/);
  assert.match(out.topology.transitions[0].issues.join(' | '), /foreign target_observation_id/);
  assert.equal(out.topology.connector_observations[0].line_hints[0].scan_incomplete, true);
});

function mockedCrop(cropId, lineId, kind = 'line', observationId = '') {
  const isStateLabel = kind === 'state_label';
  return {
    crop_id: cropId,
    transition_id: isStateLabel ? '' : 'transition_1',
    observation_id: isStateLabel ? observationId : '',
    line_id: kind === 'line' ? lineId : '',
    kind,
    image_url: `data:image/png;base64,${cropId}`,
    image_role: 'original_same_frame_crop',
    source_bbox: isStateLabel ? unitBox(0.08, 0.43, 0.09, 0.12) : unitBox(0.3, 0.2, 0.4, 0.3),
    state_bbox: isStateLabel ? unitBox(0.05, 0.4, 0.15, 0.2) : { x: -1, y: -1, w: -1, h: -1 },
    label_bbox: isStateLabel ? unitBox(0.08, 0.43, 0.09, 0.12) : { x: -1, y: -1, w: -1, h: -1 },
    inner_label_bbox: isStateLabel ? unitBox(0.08, 0.43, 0.09, 0.12) : { x: -1, y: -1, w: -1, h: -1 },
    derived_from_state_bbox: isStateLabel,
    label_block_bbox: isStateLabel ? { x: -1, y: -1, w: -1, h: -1 } : unitBox(0.35, 0.25, 0.3, 0.18),
    state_label_bbox: isStateLabel ? unitBox(0.08, 0.43, 0.09, 0.12) : { x: -1, y: -1, w: -1, h: -1 },
    line_bbox: kind === 'line' ? unitBox(0.36, lineId === 'line_1' ? 0.26 : 0.33, 0.28, 0.05) : { x: -1, y: -1, w: -1, h: -1 },
    crop_bbox: isStateLabel ? unitBox(0.075, 0.425, 0.1, 0.13) : unitBox(0.28, 0.18, 0.44, 0.34),
    padding: 8,
    original_size: { width: 1200, height: 800 },
    crop_notes: isStateLabel ? ['state-label crop derived from state interior'] : [],
  };
}
function mockedLabelRead(cropId, lineId, top, push) {
  return {
    crop_id: cropId, transition_id: 'transition_1', line_id: lineId,
    raw_label_text: `b,${top} / ${push} דחוף`,
    zones: { left_text: 'b', middle_text: top, right_text: `${push} דחוף` },
    bbox: unitBox(0.05, 0.1, 0.9, 0.8),
    read_input: { value: 'b', confidence: 0.95 },
    stack_action: { type: 'PUSH', confidence: 0.95 },
    push_value: { value: push, confidence: 0.95 },
    pop_value: { value: top, confidence: 0.95 },
    pop_symbol: { value: 'ε', confidence: 0.95 },
    confidence: 0.95,
    issues: [],
  };
}
function mockedStateLabelRead(cropId, observationId, visibleLabel) {
  return {
    crop_id: cropId,
    observation_id: observationId,
    visible_label: visibleLabel,
    confidence: 0.95,
    issues: [],
  };
}

test('12z. labels stage reads line and state-label crops while topology stays byte-for-byte unchanged', () => {
  const topologyEnvelope = server.normalizeTopologyStageResult(mockedTopologyRaw(), 'scan-labels-ok');
  const immutableBefore = JSON.parse(JSON.stringify(topologyEnvelope.topology));
  const crops = [
    mockedCrop('block_1', '', 'label_block'),
    mockedCrop('crop_1', 'line_1'),
    mockedCrop('crop_2', 'line_2'),
    mockedCrop('state_crop_left', '', 'state_label', 'state_left'),
    mockedCrop('state_crop_right', '', 'state_label', 'state_right'),
  ];
  crops[0].target_line_bboxes_in_context = [
    { line_id: 'line_1', line_index: 0, bbox: unitBox(0.05, 0.08, 0.9, 0.32) },
    { line_id: 'line_2', line_index: 1, bbox: unitBox(0.05, 0.56, 0.9, 0.32) },
  ];
  const rawReads = {
    label_reads: [
      mockedLabelRead('crop_1', 'line_1', '⊥', 'S'),
      mockedLabelRead('crop_2', 'line_2', 'S', 'A'),
    ],
    state_label_reads: [
      mockedStateLabelRead('state_crop_left', 'state_left', 'q0'),
      mockedStateLabelRead('state_crop_right', 'state_right', 'q1'),
    ],
    issues: [],
  };
  const out = server.normalizeLabelsStageResult(rawReads, topologyEnvelope, crops, 'pda', 'scan-labels-ok');
  assert.equal(out.stage, 'labels');
  assert.equal(out.scan_session_id, 'scan-labels-ok');
  assert.deepEqual(out.topology, immutableBefore, 'Stage B did not rewrite any topology field');
  assert.equal(out.label_reads.length, 2, 'the label_block context crop emitted no synthetic read');
  assert.deepEqual(out.label_reads.map(r => [r.crop_id, r.transition_id, r.line_id]), [
    ['crop_1', 'transition_1', 'line_1'], ['crop_2', 'transition_1', 'line_2'],
  ]);
  assert.deepEqual(out.state_label_reads.map(r => [r.crop_id, r.observation_id, r.visible_label]), [
    ['state_crop_left', 'state_left', 'q0'], ['state_crop_right', 'state_right', 'q1'],
  ]);
  const echoedBlockCrop = out.crop_manifest.find(crop => crop.crop_id === 'block_1');
  assert.deepEqual(echoedBlockCrop.target_line_bboxes_in_context,
    crops[0].target_line_bboxes_in_context.map(target => ({ ...target, issues: [] })),
    'adaptive context-to-target mapping survives as audit evidence');
  const echoedStateCrop = out.crop_manifest.find(crop => crop.crop_id === 'state_crop_left');
  assert.equal(echoedStateCrop.kind, 'state_label');
  assert.equal(echoedStateCrop.observation_id, 'state_left');
  assert.deepEqual(echoedStateCrop.inner_label_bbox, crops[3].inner_label_bbox);
  assert.deepEqual(echoedStateCrop.state_bbox, crops[3].state_bbox);
  assert.deepEqual(echoedStateCrop.crop_bbox, crops[3].crop_bbox);
  assert.equal(echoedStateCrop.derived_from_state_bbox, true);
  assert.equal(echoedStateCrop.image_role, 'original_same_frame_crop');
  assert.deepEqual(echoedStateCrop.crop_notes, crops[3].crop_notes);
  assert.equal(Object.prototype.hasOwnProperty.call(echoedStateCrop, 'image_url'), false,
    'base64 pixels are not echoed into the audit JSON');
  assert.deepEqual(out.topology.states.map(state => state.visible_label), ['', ''],
    'server returns label evidence separately instead of granting Stage B geometry authority');
  assert.equal(out.review_only, false);
});

test('12z0. label OCR batches keep each transition atomic and isolate state labels', () => {
  const rows = [
    mockedCrop('state_0', '', 'state_label', 'state_left'),
    mockedCrop('state_1', '', 'state_label', 'state_right'),
    mockedCrop('block_a', '', 'label_block'),
    mockedCrop('line_a1', 'line_1'),
    mockedCrop('line_a2', 'line_2'),
    { ...mockedCrop('block_b', '', 'label_block'), transition_id: 'transition_2' },
    { ...mockedCrop('line_b1', 'line_1'), transition_id: 'transition_2' },
    { ...mockedCrop('block_c', '', 'label_block'), transition_id: 'transition_3' },
    { ...mockedCrop('line_c1', 'line_1'), transition_id: 'transition_3' },
  ];
  const batches = server.buildLabelCropBatches(rows, { max_images: 6, max_transitions: 2 });
  assert.equal(batches[0].kind, 'states');
  assert.deepEqual(batches[0].rows.map(row => row.crop_id), ['state_0', 'state_1']);
  assert.ok(batches.slice(1).every(batch => batch.rows.every(row => row.kind !== 'state_label')),
    'state-label crops never share an OCR batch with transition rows');
  for (const transitionId of ['transition_1', 'transition_2', 'transition_3']) {
    const owners = batches.filter(batch => batch.rows.some(row => row.transition_id === transitionId));
    assert.equal(owners.length, 1, `${transitionId} was not split across model calls`);
    assert.ok(owners[0].rows.filter(row => row.transition_id === transitionId).some(row => row.kind === 'label_block'));
    assert.ok(owners[0].rows.filter(row => row.transition_id === transitionId).some(row => row.kind === 'line'));
  }
  assert.ok(batches.slice(1).every(batch => batch.transition_ids.length <= 2),
    'at most two connector-local groups are shown to one OCR call');
  const denseOwner = batches.find(batch => batch.transition_ids.includes('transition_1'));
  assert.deepEqual(denseOwner.transition_ids, ['transition_1'],
    'a multi-line transition is isolated so neighbouring ink cannot contaminate its rows');
  const productionLocal = server.buildLabelCropBatches(rows);
  assert.ok(productionLocal.filter(batch => batch.kind === 'transitions')
    .every(batch => batch.transition_ids.length <= 3),
  'production batches reserve retry budget but never exceed three immutable transition-local groups');
  for (const transitionId of ['transition_1', 'transition_2', 'transition_3']) {
    assert.equal(productionLocal.filter(batch => batch.transition_ids.includes(transitionId)).length, 1,
      `${transitionId} stays atomic in the production batch plan`);
  }

  const benchmarkRows = [mockedCrop('benchmark_state', '', 'state_label', 'state_left')];
  for (let index = 1; index <= 10; index += 1) {
    const transitionId = `benchmark_transition_${index}`;
    const block = mockedCrop(`benchmark_block_${index}`, '', 'label_block');
    block.transition_id = transitionId;
    benchmarkRows.push(block);
    const lineCount = index <= 3 ? (index === 1 ? 3 : 2) : 1;
    for (let lineIndex = 1; lineIndex <= lineCount; lineIndex += 1) {
      const line = mockedCrop(`benchmark_crop_${index}_${lineIndex}`, `benchmark_line_${index}_${lineIndex}`);
      line.transition_id = transitionId;
      benchmarkRows.push(line);
    }
  }
  const benchmarkBatches = server.buildLabelCropBatches(benchmarkRows);
  assert.equal(benchmarkBatches.length, 7,
    'three dense and seven single-line connectors need six OCR batches plus states, reserving retry budget');
});

test('12z0a. one targeted Luna retry re-reads the worst incomplete batch without touching clean rows', async () => {
  const session = 'scan-targeted-label-retry';
  const topologyEnvelope = server.normalizeTopologyStageResult(mockedTopologyRaw(), session);
  const crops = [
    mockedCrop('block_1', '', 'label_block'),
    mockedCrop('crop_1', 'line_1'), mockedCrop('crop_2', 'line_2'),
    mockedCrop('state_crop_left', '', 'state_label', 'state_left'),
    mockedCrop('state_crop_right', '', 'state_label', 'state_right'),
  ];
  const calls = [];
  const out = await server.parseLabelsStage(topologyEnvelope, crops, 'pda', session, {
    labelEscalationEnabled: false,
    labelTargetedRetryEnabled: true,
    labelTargetedRetryMaxBatches: 1,
    callVisionJson: async request => {
      calls.push({ prompt: request.prompt, attempt: request.telemetry.attempt });
      if (request.prompt.includes('LOCAL BATCH ID: states-1') ||
          request.captions.some(caption => caption.includes('batch=states-1'))) {
        const retry = request.telemetry.attempt === 'targeted-retry';
        return { issues: [], label_reads: [], state_label_reads: [
          { ...mockedStateLabelRead('state_crop_left', 'state_left', retry ? 'q0' : '?'),
            confidence: retry ? 0.96 : 0.3, issues: retry ? [] : ['unreadable state label'] },
          ...(retry ? [] : [mockedStateLabelRead('state_crop_right', 'state_right', 'q1')]),
        ] };
      }
      return { issues: [], label_reads: [
        mockedLabelRead('crop_1', 'line_1', '⊥', 'S'),
        mockedLabelRead('crop_2', 'line_2', 'S', 'A'),
      ], state_label_reads: [] };
    },
  });
  assert.equal(calls.length, 3, 'two clean primary batches plus one bounded targeted retry');
  assert.equal(calls.filter(call => call.attempt === 'targeted-retry').length, 1);
  assert.equal(out.targeted_retry_count, 1);
  assert.deepEqual(out.state_label_reads.map(row => row.visible_label), ['q0', 'q1']);
  assert.deepEqual(out.label_reads.map(row => row.line_id), ['line_1', 'line_2']);
});

test('12za. labels stage preserves foreign/duplicate/partial reads but blocks the scan', () => {
  const topologyEnvelope = server.normalizeTopologyStageResult(mockedTopologyRaw(), 'scan-labels-bad');
  const topologyBefore = JSON.parse(JSON.stringify(topologyEnvelope.topology));
  const crops = [
    mockedCrop('crop_1', 'line_1'), mockedCrop('crop_1', 'line_1'),
    mockedCrop('state_crop_left', '', 'state_label', 'state_left'),
    mockedCrop('state_crop_right', '', 'state_label', 'state_right'),
  ];
  const bad = mockedLabelRead('foreign_crop', 'line_2', 'S', 'A');
  bad.zones.left_text = '';
  bad.bbox = { x: -1, y: -1, w: -1, h: -1 };
  const out = server.normalizeLabelsStageResult({
    label_reads: [bad, bad],
    state_label_reads: [
      mockedStateLabelRead('state_crop_left', 'state_left', 'q0'),
      mockedStateLabelRead('state_crop_right', 'state_right', 'q1'),
    ],
    issues: [],
  },
    topologyEnvelope, crops, 'pda', 'scan-labels-bad');
  assert.equal(out.label_reads.length, 2, 'duplicate/foreign evidence was not deleted or merged');
  assert.equal(out.review_only, true);
  assert.ok(out.label_reads.every(read => read.scan_incomplete));
  assert.match(out.issues.join(' | '), /duplicate crop_id|expected label lines|missing or duplicate/);
  assert.deepEqual(out.topology, topologyBefore, 'invalid label evidence still cannot mutate topology');
});

test('label context provenance maps its own pixels, preserves row identity and rejects foreign evidence', () => {
  const envelope=server.normalizeTopologyStageResult(mockedTopologyRaw(1),'context-provenance');
  const line=mockedCrop('zoom','line_1'),block=mockedCrop('context','','label_block');
  block.crop_bbox=unitBox(.2,.3,.4,.2);
  const row={...mockedLabelRead('zoom','line_1','A','B'),evidence_crop_id:'context',bbox:unitBox(.1,.2,.5,.3)};
  const normalize=(r,crops=[line,block])=>server.normalizeLabelsStageResult({label_reads:[r]},envelope,crops,'pda','context-provenance').label_reads[0];
  const result=normalize(row);
  assert.equal(result.crop_id,'zoom');assert.equal(result.line_id,'line_1');
  assert.equal(result.evidence_crop_id,'context');
  for(const [key,value] of Object.entries({x:.24,y:.34,w:.2,h:.06})) assert.ok(Math.abs(result.original_evidence_bbox[key]-value)<1e-9);
  assert.ok(result.issues.some(x=>x.includes('primary row localization requires review')));
  assert.ok(!result.issues.some(x=>x.includes('crop-local label bbox')));
  for(const bad of [
    {...block,transition_id:'foreign'},
    {...block,kind:'line',line_id:'line_2'},
    {...block,kind:'state_label',observation_id:'state_left'},
  ]) {
    const failed=normalize(row,[line,bad]);
    assert.equal(failed.original_evidence_bbox,null);
    assert.ok(failed.issues.some(x=>x.includes('evidence_crop_id must')));
  }
  assert.equal(normalize(row,[line,block,block]).original_evidence_bbox,null,'duplicate crop identity cannot supply evidence');
  assert.equal(normalize({...row,bbox:unitBox(-.1,.1,.5,.4)}).original_evidence_bbox,null,'no clipping malformed coordinates into validity');
  assert.equal(normalize({...row,evidence_crop_id:'missing'}).original_evidence_bbox,null);
  const legacy=normalize(mockedLabelRead('zoom','line_1','A','B'));
  assert.equal(legacy.evidence_crop_id,'zoom','older responses retain the original line-local coordinate contract');
});

test('12zb. two-stage JSON schemas require structured counts and immutable identity keys', () => {
  const topologySchema = server.topologyStageSchema();
  const labelsSchema = server.labelsStageSchema();
  assert.ok(topologySchema.required.includes('visible_connector_count'));
  assert.ok(topologySchema.required.includes('connector_observations'));
  assert.ok(topologySchema.required.includes('start_marker_observations'));
  assert.ok(topologySchema.required.includes('transitions'));
  assert.equal(Object.prototype.hasOwnProperty.call(topologySchema.properties.states.items.properties, 'id'), false,
    'Stage A schema has no semantic label field');
  const readRequired = labelsSchema.properties.label_reads.items.required;
  assert.ok(readRequired.includes('stack_top'), 'Vision receives an explicitly named condition, not a pop instruction');
  assert.equal(readRequired.includes('pop_value'), false);
  for (const key of ['crop_id', 'evidence_crop_id', 'transition_id', 'line_id', 'zones', 'bbox']) assert.ok(readRequired.includes(key));
  assert.ok(labelsSchema.required.includes('state_label_reads'));
  const stateReadRequired = labelsSchema.properties.state_label_reads.items.required;
  for (const key of ['crop_id', 'observation_id', 'visible_label', 'confidence']) {
    assert.ok(stateReadRequired.includes(key));
  }
  for (const evidenceKey of ['is_start', 'is_accepting']) {
    const evidence = topologySchema.properties.states.items.properties[evidenceKey];
    assert.deepEqual(evidence.required, ['value', 'confidence']);
  }
});

test('Vision stack_top is a condition for every action and never fills the POP operand', async () => {
  const session='scan-explicit-stack-top';
  const topology=server.normalizeTopologyStageResult(mockedTopologyRaw(),session);
  for(const action of ['PUSH','NONE','POP']) {
    const row=mockedLabelRead('crop_1','line_1','A','B');
    row.stack_top=row.pop_value;delete row.pop_value;
    row.stack_action={type:action,confidence:.95};
    row.zones.right_text=action==='PUSH'?'דחוף B':action==='POP'?'שלוף B':'ללא שינוי';
    row.push_value={value:action==='PUSH'?'B':'ε',confidence:.95};
    row.pop_symbol={value:action==='POP'?'B':'ε',confidence:.95};
    const raw={label_reads:[row],state_label_reads:[],issues:[]};
    const before=JSON.stringify(raw);
    const result=await server.parseLabelsStage(topology,[mockedCrop('crop_1','line_1')],'pda',session,{
      labelEscalationEnabled:false,labelTargetedRetryEnabled:false,
      callVisionJson:async request=>{
        assert.ok(request.schema.properties.label_reads.items.properties.stack_top);
        assert.equal(request.schema.properties.label_reads.items.properties.pop_value,undefined);
        return raw;
      }
    });
    assert.equal(result.label_reads[0].pop_value.value,'A');
    assert.deepEqual(result.label_reads[0].observed_fields.stack_top,{value:'A',confidence:.95});
    assert.equal(result.label_reads[0].pop_symbol.value,action==='POP'?'B':'ε');
    if(action==='POP')assert.equal(result.label_reads[0].scan_incomplete,true,'mismatching POP evidence is not repaired');
    assert.equal(JSON.stringify(raw),before,'wire evidence was not mutated');
  }
});

test('12zb2. PDA label prompts carry the Hebrew cursive action-word guide; TM and FA prompts do not', async () => {
  const guide = server.PDA_ACTION_WORD_GUIDE;
  assert.ok(Array.isArray(guide) && guide.length > 5);
  assert.ok(guide.some(line => line.includes('לל״ש')) && guide.some(line => line.includes('ללא שינוי')));
  assert.ok(guide.some(line => /TWO RIGHTMOST glyphs/.test(line)), 'push vs pop is decided from the right end of the word');
  assert.ok(guide.some(line => /UNKNOWN/.test(line)), 'an unreadable word stays UNKNOWN instead of the closest word');
  for (const [modelType, expected] of [['pda', true], ['tm', false], ['dfa', false], ['nfa', false]]) {
    const session = `scan-guide-${modelType}`;
    const topology = server.normalizeTopologyStageResult(mockedTopologyRaw(), session);
    const prompts = [];
    await server.parseLabelsStage(topology, [mockedCrop('crop_1', 'line_1')], modelType, session, {
      labelEscalationEnabled: false, labelTargetedRetryEnabled: false,
      callVisionJson: async request => { prompts.push(request.prompt); return { label_reads: [], state_label_reads: [], issues: [] }; },
    });
    assert.ok(prompts.length > 0);
    assert.equal(prompts.every(p => p.includes(guide[guide.length - 2])), expected, `${modelType} prompt guide presence`);
  }
});

test('12zc. state-label reads preserve unknown, duplicate, foreign, and forbidden-overwrite evidence as review-only', () => {
  const topologyEnvelope = server.normalizeTopologyStageResult(mockedTopologyRaw(), 'scan-state-label-bad');
  const topologyBefore = JSON.parse(JSON.stringify(topologyEnvelope.topology));
  const crops = [
    mockedCrop('crop_1', 'line_1'), mockedCrop('crop_2', 'line_2'),
    mockedCrop('state_crop_left', '', 'state_label', 'state_left'),
    mockedCrop('state_crop_right', '', 'state_label', 'state_right'),
  ];
  const first = mockedStateLabelRead('state_crop_left', 'state_left', 'q0');
  first.is_start = { value: false, confidence: 1 };
  const duplicate = mockedStateLabelRead('state_crop_left', 'state_left', 'q9');
  const unknown = mockedStateLabelRead('state_crop_right', 'state_right', '?');
  const foreign = mockedStateLabelRead('foreign_state_crop', 'foreign_state', 'q7');
  const out = server.normalizeLabelsStageResult({
    label_reads: [
      mockedLabelRead('crop_1', 'line_1', '⊥', 'S'),
      mockedLabelRead('crop_2', 'line_2', 'S', 'A'),
    ],
    state_label_reads: [first, duplicate, unknown, foreign],
    issues: [],
  }, topologyEnvelope, crops, 'pda', 'scan-state-label-bad');

  assert.equal(out.state_label_reads.length, 4, 'audit evidence is preserved instead of merged or deleted');
  assert.equal(out.review_only, true);
  assert.equal(out.state_label_reads[2].visible_label, '?', 'unreadable ink stays unknown; no qN was invented');
  assert.match(out.state_label_reads[0].issues.join(' | '), /forbidden topology fields: is_start/);
  assert.match(out.state_label_reads[1].issues.join(' | '), /duplicate state-label read identity/);
  assert.match(out.state_label_reads[2].issues.join(' | '), /missing or unreadable; no q-label was invented/);
  assert.match(out.state_label_reads[3].issues.join(' | '), /foreign state-label crop_id|foreign or duplicate state observation_id/);
  assert.deepEqual(out.topology, topologyBefore, 'state-label reads cannot alter geometry/start/accept/endpoints');
});

test('12zd. one incoming start marker plus two computational arrows counts exactly two connectors', () => {
  const raw = mockedTopologyRaw(0);
  raw.visible_connector_count = 2;
  raw.connector_observations.push({
    connector_observation_id: 'connector_2',
    connector_bbox: unitBox(0.2, 0.60, 0.55, 0.1),
    arrowhead_bbox: unitBox(0.21, 0.60, 0.04, 0.04),
    label_block_bbox: unitBox(0.35, 0.68, 0.3, 0.08),
    visible_line_count: 0,
    line_hints: [], confidence: 0.95, issues: [],
  });
  raw.transitions.push({
    transition_id: 'transition_2', connector_observation_id: 'connector_2',
    source_observation_id: 'state_right', target_observation_id: 'state_left',
    confidence: 0.95, issues: [],
  });
  const out = server.normalizeTopologyStageResult(raw, 'scan-start-marker-count');
  assert.equal(out.review_only, false);
  assert.equal(out.topology.start_marker_observations.length, 1);
  assert.equal(out.topology.visible_connector_count, 2);
  assert.equal(out.topology.connector_observations.length, 2);
  assert.equal(out.topology.transitions.length, 2);
  assert.equal(out.topology.transitions.some(t => !t.source_observation_id), false,
    'the source-less start marker did not become a computational transition');
  assert.equal(out.topology.start_marker_observations[0].target_observation_id, 'state_left');
});

test('12ze. start/accept evidence keeps independent confidence and legacy booleans require explicit confidence', () => {
  const legacy = mockedTopologyRaw(0);
  legacy.states[0].is_start = true;
  legacy.states[0].is_start_confidence = 0.93;
  legacy.states[0].is_accepting = false;
  legacy.states[0].is_accepting_confidence = 0.94;
  const accepted = server.normalizeTopologyStageResult(legacy, 'scan-legacy-boolean-evidence');
  assert.deepEqual(accepted.topology.states[0].is_start, { value: true, confidence: 0.93 });
  assert.deepEqual(accepted.topology.states[0].is_accepting, { value: false, confidence: 0.94 });
  assert.equal(accepted.review_only, false, 'legacy bool plus its own confidence is accepted');

  const uncertain = mockedTopologyRaw(0);
  uncertain.states[0].is_start = true;
  delete uncertain.states[0].is_start_confidence;
  uncertain.states[0].is_accepting = { value: false, confidence: 0.4 };
  const blocked = server.normalizeTopologyStageResult(uncertain, 'scan-low-boolean-evidence');
  assert.equal(blocked.review_only, true);
  assert.match(blocked.topology.states[0].issues.join(' | '), /is_start\.confidence is missing or malformed/);
  assert.match(blocked.topology.states[0].issues.join(' | '), /is_accepting\.confidence is below review threshold/);
});

function mockedTopologyTile(cropId = 'topology_tile_1', bbox = unitBox(0, 0, 0.34, 0.34)) {
  return {
    crop_id: cropId,
    kind: 'topology_tile',
    tile_index: 0,
    source_bbox: bbox,
    original_bbox: bbox,
    crop_bbox: bbox,
    original_size: { width: 2048, height: 1641 },
    image_role: 'original_same_frame_crop',
    image_url: `data:image/png;base64,${cropId}`,
    crop_notes: ['topology audit tile mapped from original_same_frame'],
    issues: [],
  };
}

function mockedTopologyInventoryRaw(stateCount = 2, arrowheadCount = 1) {
  const stateBoxes = [
    unitBox(0.05, 0.4, 0.15, 0.2),
    unitBox(0.75, 0.4, 0.15, 0.2),
    unitBox(0.42, 0.72, 0.14, 0.18),
  ];
  const arrowheadBoxes = [
    unitBox(0.70, 0.45, 0.04, 0.04),
    unitBox(0.42, 0.72, 0.035, 0.035),
  ];
  return {
    visible_state_circle_count: stateCount,
    visible_computational_arrowhead_count: arrowheadCount,
    state_circle_candidates: Array.from({ length: stateCount }, (_, index) => ({
      candidate_id: `circle_candidate_${index + 1}`,
      bbox: stateBoxes[index] || unitBox(0.1 + (index % 4) * 0.2,
        0.7 + Math.floor(index / 4) * 0.08, 0.12, 0.14),
      confidence: 0.94,
      issues: [],
    })),
    computational_arrowhead_candidates: Array.from({ length: arrowheadCount }, (_, index) => ({
      candidate_id: `arrowhead_candidate_${index + 1}`,
      bbox: arrowheadBoxes[index] || unitBox(0.1 + (index % 4) * 0.2,
        0.82 + Math.floor(index / 4) * 0.04, 0.03, 0.03),
      orientation: { value: index % 2 ? 'NW' : 'E', confidence: 0.93 },
      self_loop_hint: { value: 'NO', confidence: 0.91 },
      confidence: 0.93,
      issues: [],
    })),
    issues: [],
  };
}

function mockedLineGeometryAuditRaw(lineCount = 1, transitionId = 'transition_1') {
  return {
    connector_lines: [{
      transition_id: transitionId,
      label_block_bbox: unitBox(0.31, 0.24, 0.32, Math.max(0.06, lineCount * 0.065)),
      visible_line_count: lineCount,
      line_hints: Array.from({ length: lineCount }, (_, index) => ({
        line_id: `audited_line_${index + 1}`,
        bbox: unitBox(0.32, 0.25 + index * 0.065, 0.3, 0.045),
        confidence: 0.94,
        issues: [],
      })),
      confidence: 0.95,
      issues: [],
    }],
    issues: [],
  };
}

function targetedTraceFixture(session = 'scan-targeted-trace', options = {}) {
  const topologyRaw = mockedTopologyRaw(1);
  const stateIds = Array.isArray(options.stateIds) && options.stateIds.length === 3
    ? options.stateIds.map(String) : ['state_left', 'state_right', 'state_bottom'];
  topologyRaw.states[0].observation_id = stateIds[0];
  topologyRaw.states[1].observation_id = stateIds[1];
  topologyRaw.start_marker_observations[0].target_observation_id = stateIds[0];
  topologyRaw.transitions[0].source_observation_id = stateIds[0];
  topologyRaw.transitions[0].target_observation_id = stateIds[1];
  if (options.transitionId) topologyRaw.transitions[0].transition_id = String(options.transitionId);
  topologyRaw.visible_state_count = 3;
  topologyRaw.states.push({
    observation_id: stateIds[2], bbox: unitBox(0.42, 0.72, 0.14, 0.18),
    is_start: { value: false, confidence: 0.96 },
    is_accepting: { value: false, confidence: 0.96 },
    confidence: 0.96,
    issues: [],
  });
  const initial = server.normalizeTopologyStageResult(topologyRaw, session);
  const inventoryRaw = mockedTopologyInventoryRaw(3, 2);
  inventoryRaw.computational_arrowhead_candidates[1] = {
    candidate_id: 'loop_arrow_candidate',
    bbox: options.candidateBbox || unitBox(0.83, 0.37, 0.025, 0.025),
    orientation: { value: options.candidateOrientation || 'SE', confidence: 0.95 },
    self_loop_hint: { value: options.candidateSelfLoop || 'YES', confidence: 0.95 },
    confidence: 0.95,
    issues: [],
  };
  const inventory = server.normalizeTopologyInventoryResult(inventoryRaw, session);
  const tile = mockedTopologyTile('trace_tile', options.tileBbox || unitBox(0, 0, 1, 1));
  const replacement = server.normalizeTopologyAuditStageResult(
    topologyRaw, initial, [tile], session, { inventory, inventory_model: 'audit-model' },
  );
  const manifestIssues = [];
  const tileManifest = server.normalizeTopologyAuditManifest([tile], manifestIssues);
  const plan = server.planTopologyTargetedTrace(
    replacement,
    ['data:image/png;base64,full-original'],
    ['original_same_frame'],
    [tile],
    tileManifest,
  );
  return { session, topologyRaw, initial, inventoryRaw, inventory, tile, replacement, plan };
}

function verifiedOmittedTraceRow(overrides = {}) {
  return {
    candidate_id: 'loop_arrow_candidate',
    verdict: 'VERIFIED_OMITTED',
    evidence_crop_id: 'trace_tile',
    arrowhead_bbox_in_crop: unitBox(0.83, 0.37, 0.025, 0.025),
    connector_bbox_in_crop: unitBox(0.76, 0.34, 0.13, 0.09),
    tail_contact_bbox_in_crop: unitBox(0.77, 0.37, 0.025, 0.025),
    trace_status: 'COMPLETE',
    source_observation_id: 'state_ref_002',
    target_observation_id: 'state_ref_002',
    existing_transition_id: '',
    orientation: { value: 'SE', confidence: 0.96 },
    self_loop: { value: 'YES', confidence: 0.96 },
    candidate_confidence: 0.96,
    endpoint_confidence: 0.95,
    connector_confidence: 0.95,
    issues: [],
    ...overrides,
  };
}

function traceResponse(row = verifiedOmittedTraceRow()) {
  return { candidate_traces: [row], issues: [] };
}

function targetedExistingMatchFixture(session = 'scan-targeted-existing-match') {
  const fixture = targetedTraceFixture(session);
  const connectorBbox = unitBox(0.76, 0.34, 0.13, 0.09);
  const arrowheadBbox = unitBox(0.83, 0.37, 0.025, 0.025);
  fixture.replacement.topology.transitions[0] = {
    ...fixture.replacement.topology.transitions[0],
    source_observation_id: 'state_right', target_observation_id: 'state_right',
    connector_bbox: connectorBbox, arrowhead_bbox: arrowheadBbox,
  };
  fixture.replacement.topology.connectors[0] = JSON.parse(JSON.stringify(
    fixture.replacement.topology.transitions[0]));
  fixture.replacement.topology.connector_observations[0] = {
    ...fixture.replacement.topology.connector_observations[0],
    connector_bbox: connectorBbox, arrowhead_bbox: arrowheadBbox,
  };
  fixture.plan = server.planTopologyTargetedTrace(
    fixture.replacement,
    ['data:image/png;base64,full-original'], ['original_same_frame'], [fixture.tile],
    server.normalizeTopologyAuditManifest([fixture.tile], []),
  );
  return fixture;
}

function matchesExistingTraceRow(overrides = {}) {
  return verifiedOmittedTraceRow({
    verdict: 'MATCHES_EXISTING', existing_transition_id: 'transition_ref_001',
    ...overrides,
  });
}

function physicalLineFragment(lineId, x, y, w, h, confidence = 0.94) {
  return { line_id: lineId, bbox: unitBox(x, y, w, h), confidence, issues: [] };
}

// Exact normalized block/fragment bboxes persisted by the independent
// line-geometry pass in live exports (5) and (6).  Keeping these as local test
// fixtures makes the grouping regression deterministic and independent of the
// user's Downloads directory.
function liveExport5LineGeometryFixture() {
  return [
    [unitBox(0.117, 0.286, 0.115, 0.034), [physicalLineFragment('line_1', 0.117, 0.286, 0.115, 0.034)]],
    [unitBox(0.289, 0.145, 0.097, 0.07), [
      physicalLineFragment('line_2', 0.289, 0.145, 0.056, 0.033),
      physicalLineFragment('line_3', 0.338, 0.147, 0.048, 0.068),
    ]],
    [unitBox(0.364, 0.284, 0.099, 0.034), [physicalLineFragment('line_4', 0.364, 0.284, 0.099, 0.034)]],
    [unitBox(0.599, 0.167, 0.141, 0.113), [
      physicalLineFragment('line_5', 0.599, 0.167, 0.137, 0.029),
      physicalLineFragment('line_6', 0.599, 0.192, 0.133, 0.032),
      physicalLineFragment('line_7', 0.598, 0.221, 0.142, 0.036),
    ]],
    [unitBox(0.836, 0.351, 0.122, 0.097), [
      physicalLineFragment('line_8', 0.836, 0.351, 0.113, 0.041),
      physicalLineFragment('line_9', 0.836, 0.39, 0.122, 0.041),
    ]],
    [unitBox(0.597, 0.333, 0.132, 0.116), [
      physicalLineFragment('line_10', 0.606, 0.333, 0.071, 0.035),
      physicalLineFragment('line_11', 0.595, 0.362, 0.114, 0.041),
      physicalLineFragment('line_12', 0.606, 0.39, 0.123, 0.059),
    ]],
    [unitBox(0.355, 0.369, 0.104, 0.074), [physicalLineFragment('line_13', 0.355, 0.369, 0.104, 0.074)]],
    [unitBox(0.528, 0.463, 0.114, 0.086), [
      physicalLineFragment('line_14', 0.528, 0.463, 0.093, 0.043),
      physicalLineFragment('line_15', 0.587, 0.486, 0.055, 0.063),
    ]],
    [unitBox(0.412, 0.646, 0.091, 0.064), [
      physicalLineFragment('line_16', 0.412, 0.646, 0.082, 0.035),
      physicalLineFragment('line_17', 0.45, 0.672, 0.053, 0.038),
    ]],
    [unitBox(0.648, 0.6, 0.126, 0.049), [physicalLineFragment('line_18', 0.648, 0.6, 0.126, 0.049)]],
  ];
}

function liveExport6LineGeometryFixture() {
  return [
    [unitBox(0.118, 0.264, 0.107, 0.046), [physicalLineFragment('line_1', 0.118, 0.264, 0.107, 0.046)]],
    [unitBox(0.288, 0.146, 0.086, 0.066), [
      physicalLineFragment('line_2', 0.288, 0.146, 0.053, 0.028),
      physicalLineFragment('line_3', 0.335, 0.147, 0.039, 0.065),
    ]],
    [unitBox(0.356, 0.273, 0.096, 0.04), [physicalLineFragment('line_4', 0.356, 0.273, 0.096, 0.04)]],
    [unitBox(0.344, 0.369, 0.094, 0.061), [physicalLineFragment('line_5', 0.344, 0.369, 0.094, 0.061)]],
    [unitBox(0.599, 0.148, 0.142, 0.132), [
      physicalLineFragment('line_6', 0.599, 0.148, 0.125, 0.032),
      physicalLineFragment('line_7', 0.599, 0.179, 0.124, 0.034),
      physicalLineFragment('line_8', 0.599, 0.21, 0.142, 0.036),
    ]],
    [unitBox(0.619, 0.331, 0.12, 0.098), [
      physicalLineFragment('line_9', 0.619, 0.331, 0.107, 0.041),
      physicalLineFragment('line_10', 0.619, 0.364, 0.12, 0.065),
    ]],
    [unitBox(0.836, 0.332, 0.112, 0.09), [
      physicalLineFragment('line_11', 0.836, 0.332, 0.111, 0.043),
      physicalLineFragment('line_12', 0.836, 0.375, 0.112, 0.047),
    ]],
    [unitBox(0.528, 0.435, 0.124, 0.068), [
      physicalLineFragment('line_13', 0.528, 0.435, 0.124, 0.035),
      physicalLineFragment('line_14', 0.589, 0.462, 0.063, 0.041),
    ]],
    [unitBox(0.406, 0.641, 0.119, 0.08), [
      physicalLineFragment('line_15', 0.406, 0.641, 0.119, 0.042),
      physicalLineFragment('line_16', 0.45, 0.675, 0.033, 0.046),
    ]],
    [unitBox(0.639, 0.617, 0.104, 0.042), [physicalLineFragment('line_17', 0.639, 0.617, 0.104, 0.042)]],
  ];
}

function liveExport7LineGeometryFixture() {
  return [
    [unitBox(0.118, 0.266, 0.122, 0.041), [physicalLineFragment('line_1', 0.118, 0.269, 0.122, 0.031)]],
    [unitBox(0.291, 0.147, 0.081, 0.072), [
      physicalLineFragment('line_2', 0.291, 0.147, 0.057, 0.027),
      physicalLineFragment('line_3', 0.348, 0.153, 0.024, 0.066),
    ]],
    [unitBox(0.364, 0.269, 0.114, 0.034), [physicalLineFragment('line_4', 0.364, 0.269, 0.114, 0.028)]],
    [unitBox(0.355, 0.351, 0.094, 0.08), [physicalLineFragment('line_5', 0.355, 0.351, 0.094, 0.058)]],
    [unitBox(0.602, 0.171, 0.132, 0.119), [
      physicalLineFragment('line_6', 0.602, 0.171, 0.115, 0.028),
      physicalLineFragment('line_7', 0.602, 0.194, 0.114, 0.031),
      physicalLineFragment('line_8', 0.602, 0.219, 0.132, 0.035),
    ]],
    [unitBox(0.827, 0.336, 0.112, 0.087), [
      physicalLineFragment('line_9', 0.827, 0.336, 0.108, 0.035),
      physicalLineFragment('line_10', 0.827, 0.373, 0.112, 0.034),
    ]],
    [unitBox(0.621, 0.332, 0.108, 0.119), [
      physicalLineFragment('line_11', 0.621, 0.332, 0.07, 0.029),
      physicalLineFragment('line_12', 0.62, 0.359, 0.087, 0.031),
      physicalLineFragment('line_13', 0.669, 0.379, 0.06, 0.072),
    ]],
    [unitBox(0.53, 0.448, 0.118, 0.089), [
      physicalLineFragment('line_14', 0.53, 0.448, 0.091, 0.035),
      physicalLineFragment('line_15', 0.581, 0.483, 0.067, 0.054),
    ]],
    [unitBox(0.418, 0.623, 0.095, 0.089), [
      physicalLineFragment('line_16', 0.418, 0.623, 0.095, 0.044),
      physicalLineFragment('line_17', 0.462, 0.663, 0.029, 0.049),
    ]],
  ];
}

function liveExport7TopologyRaw() {
  const stateBoxes = [
    unitBox(0.01, 0.241, 0.113, 0.166), unitBox(0.267, 0.248, 0.081, 0.123),
    unitBox(0.505, 0.252, 0.091, 0.111), unitBox(0.768, 0.233, 0.075, 0.099),
    unitBox(0.779, 0.454, 0.053, 0.079), unitBox(0.271, 0.609, 0.071, 0.094),
    unitBox(0.507, 0.592, 0.074, 0.085),
  ];
  const arrowBoxes = [
    unitBox(0.242, 0.296, 0.016, 0.028), unitBox(0.316, 0.235, 0.016, 0.023),
    unitBox(0.492, 0.294, 0.015, 0.024), unitBox(0.314, 0.544, 0.014, 0.028),
    unitBox(0.735, 0.287, 0.012, 0.026), unitBox(0.789, 0.441, 0.014, 0.027),
    unitBox(0.539, 0.356, 0.016, 0.024), unitBox(0.531, 0.55, 0.014, 0.029),
    unitBox(0.333, 0.631, 0.018, 0.025),
  ];
  const endpoints = [
    ['state_1', 'state_2'], ['state_2', 'state_2'], ['state_2', 'state_3'],
    ['state_3', 'state_6'], ['state_3', 'state_4'], ['state_4', 'state_5'],
    ['state_5', 'state_3'], ['state_3', 'state_7'], ['state_7', 'state_6'],
  ];
  const connectorObservations = arrowBoxes.map((arrowheadBbox, index) => ({
    connector_observation_id: `connector_${index + 1}`,
    connector_bbox: unitBox(0.1 + (index % 3) * 0.2, 0.1 + Math.floor(index / 3) * 0.2, 0.12, 0.08),
    arrowhead_bbox: arrowheadBbox,
    label_block_bbox: unitBox(0.12 + (index % 3) * 0.2, 0.12 + Math.floor(index / 3) * 0.2, 0.08, 0.04),
    visible_line_count: 0,
    line_hints: [],
    confidence: 0.95,
    issues: [],
  }));
  return {
    visible_state_count: stateBoxes.length,
    visible_connector_count: connectorObservations.length,
    states: stateBoxes.map((bbox, index) => ({
      observation_id: `state_${index + 1}`, bbox,
      is_start: { value: false, confidence: 0.95 },
      is_accepting: { value: false, confidence: 0.95 }, confidence: 0.95, issues: [],
    })),
    start_marker_observations: [],
    connector_observations: connectorObservations,
    transitions: endpoints.map(([source, target], index) => ({
      transition_id: `transition_${index + 1}`,
      connector_observation_id: `connector_${index + 1}`,
      source_observation_id: source,
      target_observation_id: target,
      confidence: 0.95,
      issues: [],
    })),
    issues: [],
  };
}

function liveExport7InventoryRaw() {
  const stateBoxes = [
    unitBox(0.009, 0.302, 0.103, 0.165), unitBox(0.268, 0.308, 0.092, 0.147),
    unitBox(0.507, 0.311, 0.098, 0.134), unitBox(0.793, 0.293, 0.089, 0.121),
    unitBox(0.796, 0.534, 0.055, 0.08), unitBox(0.509, 0.689, 0.081, 0.12),
    unitBox(0.274, 0.702, 0.078, 0.112),
  ];
  const arrows = [
    [unitBox(0.239, 0.391, 0.019, 0.024), 'E', 'NO'],
    [unitBox(0.463, 0.389, 0.02, 0.023), 'E', 'NO'],
    [unitBox(0.698, 0.366, 0.018, 0.024), 'S', 'YES'],
    [unitBox(0.748, 0.513, 0.017, 0.034), 'S', 'NO'],
    [unitBox(0.628, 0.472, 0.022, 0.03), 'NW', 'NO'],
    [unitBox(0.341, 0.66, 0.021, 0.031), 'SW', 'NO'],
    [unitBox(0.507, 0.639, 0.019, 0.034), 'S', 'NO'],
    [unitBox(0.34, 0.737, 0.02, 0.022), 'W', 'NO'],
    [unitBox(0.584, 0.728, 0.019, 0.026), 'W', 'YES'],
  ];
  return {
    visible_state_circle_count: stateBoxes.length,
    visible_computational_arrowhead_count: arrows.length,
    state_circle_candidates: stateBoxes.map((bbox, index) => ({
      candidate_id: `sc${index + 1}`, bbox, confidence: 0.95, issues: [],
    })),
    computational_arrowhead_candidates: arrows.map(([bbox, orientation, selfLoop], index) => ({
      candidate_id: `ah${index + 1}`, bbox,
      orientation: { value: orientation, confidence: 0.95 },
      self_loop_hint: { value: selfLoop, confidence: 0.95 },
      confidence: 0.95,
      issues: [],
    })),
    issues: [],
  };
}

test('12zfa. independent geometric-inventory schema contains only physical candidates and counts', () => {
  const schema = server.topologyInventorySchema();
  for (const key of ['visible_state_circle_count', 'visible_computational_arrowhead_count',
    'state_circle_candidates', 'computational_arrowhead_candidates', 'issues']) {
    assert.ok(schema.required.includes(key));
  }
  assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, 'topology'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, 'initial_topology'), false);
  const arrow = schema.properties.computational_arrowhead_candidates.items;
  assert.ok(arrow.required.includes('bbox'));
  assert.ok(arrow.required.includes('orientation'));
  assert.ok(arrow.required.includes('self_loop_hint'));
  assert.equal(Object.prototype.hasOwnProperty.call(arrow.properties, 'source_observation_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(arrow.properties, 'target_observation_id'), false);
});

test('12zfb. geometric inventory normalizes candidates without creating topology objects', () => {
  const out = server.normalizeTopologyInventoryResult(mockedTopologyInventoryRaw(), 'scan-inventory-ok');
  assert.equal(out.stage, 'topology-inventory');
  assert.equal(out.review_only, false);
  assert.equal(out.inventory.visible_state_circle_count, 2);
  assert.equal(out.inventory.visible_computational_arrowhead_count, 1);
  assert.deepEqual(out.inventory.computational_arrowhead_candidates[0].orientation,
    { value: 'E', confidence: 0.93 });
  assert.deepEqual(out.inventory.computational_arrowhead_candidates[0].self_loop_hint,
    { value: 'NO', confidence: 0.91 });
  assert.equal(Object.prototype.hasOwnProperty.call(out.inventory, 'transitions'), false,
    'an arrowhead candidate is evidence only and never fabricates a connector');
});

test('12zfc. inventory count mismatch and malformed candidate evidence are review-only', () => {
  const raw = mockedTopologyInventoryRaw();
  raw.visible_computational_arrowhead_count = 10;
  raw.state_circle_candidates[0].bbox = { x: 0.1, y: 0.1, w: -1, h: 0.2 };
  raw.computational_arrowhead_candidates[0].orientation = { value: 'RIGHT', confidence: 0.95 };
  const out = server.normalizeTopologyInventoryResult(raw, 'scan-inventory-bad');
  assert.equal(out.review_only, true);
  assert.match(out.inventory.issues.join(' | '), /visible_computational_arrowhead_count 10 does not match candidates.length 1/);
  assert.match(out.inventory.state_circle_candidates[0].issues.join(' | '), /bbox is malformed/);
  assert.match(out.inventory.computational_arrowhead_candidates[0].issues.join(' | '), /orientation.value is missing or malformed/);
});

test('12zfd. inventory prompt is independent of initial topology and forbids OCR', () => {
  const sentinel = 'SECRET_INITIAL_TOPOLOGY_SENTINEL';
  const prompt = server.buildTopologyInventoryPrompt(
    ['original_same_frame'], [{ crop_id: 'tile', original_bbox: unitBox() }], [], 'pda',
  );
  assert.equal(prompt.includes('FALLIBLE INITIAL TOPOLOGY'), false);
  assert.equal(prompt.includes(sentinel), false);
  assert.match(prompt, /No prior topology is supplied/);
  assert.match(prompt, /Do not read, transcribe/);
  assert.match(prompt, /EXCLUDED from the computational-arrowhead count/);
  assert.match(prompt, /bottom-left region/);
  const auditPrompt = server.buildTopologyReplacementAuditPrompt(
    { sentinel }, mockedTopologyInventoryRaw(), ['original_same_frame'], [], [], 'pda',
  );
  assert.ok(auditPrompt.includes(sentinel), 'only the replacement audit receives the initial topology');
  assert.match(auditPrompt, /INDEPENDENT PIXEL INVENTORY EVIDENCE/);
  assert.match(auditPrompt, /Never invent a state or connector merely to reconcile a count/);
});

test('12zfda. targeted trace has a strict geometry-only schema and requires mapped candidate evidence', () => {
  const schema = server.topologyTargetedTraceSchema();
  assert.deepEqual(schema.required, ['candidate_traces', 'issues']);
  const row = schema.properties.candidate_traces.items;
  for (const key of ['candidate_id', 'verdict', 'evidence_crop_id',
    'arrowhead_bbox_in_crop', 'connector_bbox_in_crop', 'tail_contact_bbox_in_crop',
    'trace_status', 'source_observation_id', 'target_observation_id',
    'existing_transition_id', 'orientation', 'self_loop', 'candidate_confidence',
    'endpoint_confidence', 'connector_confidence', 'issues']) {
    assert.ok(row.required.includes(key), `strict targeted trace requires ${key}`);
  }
  for (const forbidden of ['raw_label_text', 'visible_label', 'read_input', 'stack_action', 'rules']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row.properties, forbidden), false);
  }
  const fixture = targetedTraceFixture('scan-trace-schema-plan');
  assert.equal(fixture.plan.has_unmatched, true);
  assert.equal(fixture.plan.should_call, true);
  assert.deepEqual(fixture.plan.requested_candidate_ids, ['loop_arrow_candidate']);
  assert.deepEqual(fixture.plan.candidate_manifest[0].allowed_evidence_crop_ids, ['trace_tile']);
  assert.equal(fixture.plan.request_urls.length, 2,
    'the conditional request contains the full original and one existing containing tile');
  assert.equal(JSON.stringify(fixture.plan).includes('q0'), false,
    'the targeted plan carries opaque observation geometry, never semantic q labels');
  const prompt = server.buildTopologyTargetedTracePrompt(fixture.plan, 'pda');
  assert.match(prompt, /PIXELS AND GEOMETRY ONLY, NO OCR/);
  assert.match(prompt, /exactly one candidate_traces row/);
  assert.match(prompt, /VERIFIED_OMITTED only if a complete continuous/);
  assert.match(prompt, /crop's LOCAL pixel frame/);
  const noFullPlan = server.planTopologyTargetedTrace(
    fixture.replacement, ['data:image/png;base64,enhanced'], ['enhanced_same_frame'],
    [fixture.tile], server.normalizeTopologyAuditManifest([fixture.tile], []),
  );
  assert.equal(noFullPlan.should_call, false,
    'an unmatched candidate cannot trigger the trace without explicit original_same_frame pixels');
  const skipped = server.applyTopologyTargetedTrace(fixture.replacement, null, fixture.session,
    { plan: noFullPlan, attempted: false });
  assert.equal(skipped.topology.transitions.length, 1);
  assert.equal(skipped.topology_audit.targeted_trace.unresolved_connector_candidates.length, 1);
});

test('12zfdb. only a complete high-confidence verified trace adds one provisional blocked connector', () => {
  const fixture = targetedTraceFixture('scan-trace-positive');
  assert.equal(fixture.replacement.topology_audit.inventory_reconciliation.alignment.applied, true,
    'the positive fixture proves a common coordinate frame before any candidate can be added');
  assert.equal(fixture.plan.candidate_manifest[0].alignment_validated, true);
  const out = server.applyTopologyTargetedTrace(
    fixture.replacement, traceResponse(), fixture.session,
    { plan: fixture.plan, attempted: true, model: 'trace-model' },
  );
  assert.equal(out.topology.transitions.length, 2);
  assert.equal(out.topology.connector_observations.length, 2);
  assert.equal(out.topology.visible_connector_count, 2);
  const added = out.topology.transitions.find(transition => transition.provisional);
  assert.ok(added);
  assert.equal(added.source_observation_id, 'state_right');
  assert.equal(added.target_observation_id, 'state_right');
  assert.equal(added.scan_incomplete, true);
  assert.equal(added.review_only, true);
  assert.equal(added.human_review_required, true);
  assert.match(added.issues.join(' | '), /provisionally recovered.*human review/);
  assert.equal(out.review_only, true);
  const trace = out.topology_audit.targeted_trace;
  assert.deepEqual(trace.added_provisional_transition_ids, [added.transition_id]);
  assert.equal(trace.candidate_traces[0].disposition, 'provisional_review_only');
  assert.equal(trace.candidate_traces[0].added_provisional_connector, true);
  assert.deepEqual(trace.candidate_traces[0].arrowhead_bbox_original,
    verifiedOmittedTraceRow().arrowhead_bbox_in_crop,
    'crop-local evidence was mapped deterministically through the full-frame tile');
  assert.equal(server.topologyLineGeometryConnectorManifest(out).length, 2,
    'the provisional connector enters the following line-geometry audit');
  assert.equal(JSON.stringify(trace).includes('data:image'), false,
    'request image URLs are never copied into persistent targeted-trace evidence');

  const lineRows = out.topology.transitions.map((transition, index) => ({
    transition_id: transition.transition_id,
    label_block_bbox: unitBox(0.3 + index * 0.3, 0.2, 0.2, 0.08),
    visible_line_count: 1,
    line_hints: [{ line_id: `trace_line_${index + 1}`,
      bbox: unitBox(0.31 + index * 0.3, 0.21, 0.18, 0.04), confidence: 0.95, issues: [] }],
    confidence: 0.95,
    issues: [],
  }));
  const afterLineAudit = server.applyTopologyLineGeometryAudit(out,
    { connector_lines: lineRows, issues: [] }, fixture.session, { model: 'line-model' });
  const stillBlocked = afterLineAudit.topology.transitions.find(transition => transition.provisional);
  assert.equal(stillBlocked.scan_incomplete, true);
  assert.equal(stillBlocked.review_only, true);
  assert.equal(afterLineAudit.review_only, true,
    'line geometry may localize its label but can never make it runnable');
});

test('12zfdc. unknown, duplicate, foreign, partial, and bad-geometry trace evidence never creates topology', () => {
  const cases = [
    ['unknown verdict', fixture => traceResponse(verifiedOmittedTraceRow({ verdict: 'MAYBE' }))],
    ['partial trace', fixture => traceResponse(verifiedOmittedTraceRow({ trace_status: 'PARTIAL' }))],
    ['low confidence', fixture => traceResponse(verifiedOmittedTraceRow({ candidate_confidence: 0.84 }))],
    ['foreign crop', fixture => traceResponse(verifiedOmittedTraceRow({ evidence_crop_id: 'foreign_tile' }))],
    ['foreign candidate and endpoint ids', fixture => traceResponse(verifiedOmittedTraceRow({
      candidate_id: 'foreign_candidate', source_observation_id: 'foreign_source',
      target_observation_id: 'foreign_target',
    }))],
    ['MATCHES_EXISTING with a foreign transition id', fixture => traceResponse(verifiedOmittedTraceRow({
      verdict: 'MATCHES_EXISTING', existing_transition_id: 'foreign_transition',
    }))],
    ['bad localized geometry', fixture => traceResponse(verifiedOmittedTraceRow({
      arrowhead_bbox_in_crop: unitBox(0.1, 0.1, 0.02, 0.02),
      connector_bbox_in_crop: unitBox(0.08, 0.08, 0.1, 0.08),
      tail_contact_bbox_in_crop: unitBox(0.09, 0.1, 0.02, 0.02),
    }))],
    ['geometry duplicates an existing connector', fixture => traceResponse(verifiedOmittedTraceRow({
      arrowhead_bbox_in_crop: unitBox(0.70, 0.45, 0.04, 0.04),
      connector_bbox_in_crop: unitBox(0.2, 0.45, 0.55, 0.1),
      tail_contact_bbox_in_crop: unitBox(0.2, 0.45, 0.03, 0.03),
      source_observation_id: 'state_ref_001', target_observation_id: 'state_ref_002',
      self_loop: { value: 'NO', confidence: 0.96 }, orientation: { value: 'E', confidence: 0.96 },
    }))],
    ['duplicate rows', fixture => ({ candidate_traces: [verifiedOmittedTraceRow(),
      verifiedOmittedTraceRow()], issues: [] })],
    ['global trace uncertainty', fixture => ({ candidate_traces: [verifiedOmittedTraceRow()],
      issues: ['the physical trace crosses ambiguous ink'] })],
  ];
  cases.forEach(([name, responseFactory], index) => {
    const fixture = targetedTraceFixture(`scan-trace-negative-${index}`);
    const out = server.applyTopologyTargetedTrace(
      fixture.replacement, responseFactory(fixture), fixture.session,
      { plan: fixture.plan, attempted: true },
    );
    assert.equal(out.topology.transitions.length, 1, `${name}: no transition was added`);
    assert.equal(out.topology.connector_observations.length, 1, `${name}: no connector was added`);
    assert.equal(out.review_only, true, `${name}: evidence remains blocked`);
    assert.ok(out.topology_audit.targeted_trace.unresolved_connector_candidates.length > 0,
      `${name}: failure is retained as unresolved evidence`);
  });
});

test('12zfdca. verified omissions fail closed for interior contacts, full-frame extents, and absent alignment', () => {
  const insideFixture = targetedTraceFixture('scan-trace-interior-contacts', {
    candidateBbox: unitBox(0.815, 0.47, 0.02, 0.02),
  });
  const inside = server.applyTopologyTargetedTrace(
    insideFixture.replacement,
    traceResponse(verifiedOmittedTraceRow({
      arrowhead_bbox_in_crop: unitBox(0.815, 0.47, 0.02, 0.02),
      connector_bbox_in_crop: unitBox(0.79, 0.45, 0.09, 0.10),
      tail_contact_bbox_in_crop: unitBox(0.85, 0.52, 0.02, 0.02),
    })),
    insideFixture.session, { plan: insideFixture.plan, attempted: true },
  );
  assert.equal(inside.topology.transitions.length, 1,
    'arrowhead and tail boxes wholly inside a state never recover a self-loop');
  assert.match(inside.topology_audit.targeted_trace.candidate_traces[0].issues.join(' | '),
    /state interior|boundary contact|exit and re-enter/);

  const fullFrameFixture = targetedTraceFixture('scan-trace-full-frame-connector');
  const fullFrame = server.applyTopologyTargetedTrace(
    fullFrameFixture.replacement,
    traceResponse(verifiedOmittedTraceRow({ connector_bbox_in_crop: unitBox(0, 0, 1, 1) })),
    fullFrameFixture.session, { plan: fullFrameFixture.plan, attempted: true },
  );
  assert.equal(fullFrame.topology.transitions.length, 1,
    'a full-frame connector bbox is implausible evidence and adds nothing');
  assert.match(fullFrame.topology_audit.targeted_trace.candidate_traces[0].issues.join(' | '),
    /implausibly large|full-frame/);

  const stripeFixture = targetedTraceFixture('scan-trace-relative-stripe');
  const stripe = server.applyTopologyTargetedTrace(
    stripeFixture.replacement,
    traceResponse(verifiedOmittedTraceRow({
      connector_bbox_in_crop: unitBox(0.02, 0.20, 0.96, 0.46),
    })),
    stripeFixture.session, { plan: stripeFixture.plan, attempted: true },
  );
  assert.equal(stripe.topology.transitions.length, 1,
    'a near-full stripe around a small state cannot masquerade as a local loop');
  assert.match(stripe.topology_audit.targeted_trace.candidate_traces[0].issues.join(' | '),
    /implausibly large relative to its state/);

  const noAlignmentFixture = targetedTraceFixture('scan-trace-no-alignment');
  noAlignmentFixture.replacement.topology_audit.inventory_reconciliation.alignment.applied = false;
  noAlignmentFixture.plan.candidate_manifest[0].alignment_validated = false;
  const noAlignment = server.applyTopologyTargetedTrace(
    noAlignmentFixture.replacement, traceResponse(), noAlignmentFixture.session,
    { plan: noAlignmentFixture.plan, attempted: true },
  );
  assert.equal(noAlignment.topology.transitions.length, 1,
    'raw fallback coordinates may retain evidence but can never add a connector');
  assert.match(noAlignment.topology_audit.targeted_trace.candidate_traces[0].issues.join(' | '),
    /validated and applied.*alignment|fallback coordinates/);
});

test('12zfdcaa. one foreign extra row atomically blocks every otherwise-valid verified omission', () => {
  const fixture = targetedTraceFixture('scan-trace-atomic-foreign');
  const valid = verifiedOmittedTraceRow();
  const foreign = { ...verifiedOmittedTraceRow(), candidate_id: 'foreign_candidate' };
  const out = server.applyTopologyTargetedTrace(
    fixture.replacement, { candidate_traces: [valid, foreign], issues: [] }, fixture.session,
    { plan: fixture.plan, attempted: true },
  );
  assert.equal(out.topology.transitions.length, 1);
  assert.equal(out.topology.connector_observations.length, 1);
  const audit = out.topology_audit.targeted_trace;
  assert.equal(audit.added_provisional_transition_ids.length, 0);
  assert.equal(audit.raw_candidate_traces.length, 2, 'both raw rows remain available for audit');
  assert.ok(audit.atomic_structural_issues.length > 0);
  assert.match(audit.atomic_structural_issues.join(' | '), /foreign|returned 2 rows/);
  assert.equal(audit.candidate_traces.find(row => row.candidate_id === valid.candidate_id).disposition,
    'unresolved');
  assert.ok(audit.unresolved_connector_candidates.some(row =>
    row.candidate_id === 'foreign_candidate'), 'the foreign row is retained as unresolved evidence');
});

test('12zfdcab. MATCHES_EXISTING closes only on complete clean high-confidence geometry and never mutates topology', () => {
  const apply = (fixture, row, globalIssues = [], plan = fixture.plan) =>
    server.applyTopologyTargetedTrace(
      fixture.replacement, { candidate_traces: [row], issues: globalIssues }, fixture.session,
      { plan, attempted: true },
    );

  const positiveFixture = targetedExistingMatchFixture('scan-trace-match-positive');
  const transitionsBefore = JSON.parse(JSON.stringify(positiveFixture.replacement.topology.transitions));
  const observationsBefore = JSON.parse(JSON.stringify(
    positiveFixture.replacement.topology.connector_observations));
  const positive = apply(positiveFixture, matchesExistingTraceRow());
  assert.equal(positive.topology_audit.targeted_trace.candidate_traces[0].disposition,
    'matched_existing');
  assert.deepEqual(positive.topology.transitions, transitionsBefore,
    'matching existing evidence never creates or rewrites a transition');
  assert.deepEqual(positive.topology.connector_observations, observationsBefore,
    'matching existing evidence never creates or rewrites connector geometry');
  assert.deepEqual(positive.topology_audit.targeted_trace.added_provisional_transition_ids, []);

  const cases = [
    ['zero endpoint confidence', matchesExistingTraceRow({ endpoint_confidence: 0 })],
    ['unknown orientation', matchesExistingTraceRow({
      orientation: { value: 'UNKNOWN', confidence: 0.96 },
    })],
    ['low orientation confidence', matchesExistingTraceRow({
      orientation: { value: 'SE', confidence: 0 },
    })],
    ['unknown self-loop', matchesExistingTraceRow({
      self_loop: { value: 'UNKNOWN', confidence: 0.96 },
    })],
    ['low self-loop confidence', matchesExistingTraceRow({
      self_loop: { value: 'YES', confidence: 0 },
    })],
    ['model row issue', matchesExistingTraceRow({ issues: ['trace ownership is uncertain'] })],
    ['mismatched connector geometry', matchesExistingTraceRow({
      connector_bbox_in_crop: unitBox(0.20, 0.45, 0.55, 0.10),
    })],
    ['malformed arrow geometry', matchesExistingTraceRow({
      arrowhead_bbox_in_crop: { x: -1, y: -1, w: -1, h: -1 },
    })],
  ];
  cases.forEach(([name, row], index) => {
    const fixture = targetedExistingMatchFixture(`scan-trace-match-negative-${index}`);
    const out = apply(fixture, row);
    assert.equal(out.topology_audit.targeted_trace.candidate_traces[0].disposition,
      'unresolved', `${name}: never marked matched_existing`);
    assert.equal(out.topology.transitions.length, 1, `${name}: topology is unchanged`);
    assert.deepEqual(out.topology_audit.targeted_trace.added_provisional_transition_ids, []);
  });

  const globalFixture = targetedExistingMatchFixture('scan-trace-match-global-issue');
  const global = apply(globalFixture, matchesExistingTraceRow(), ['global trace ambiguity']);
  assert.equal(global.topology_audit.targeted_trace.candidate_traces[0].disposition, 'unresolved');
  assert.match(global.topology_audit.targeted_trace.candidate_traces[0].issues.join(' | '),
    /global model-reported trace uncertainty/);

  const staleFixture = targetedExistingMatchFixture('scan-trace-match-stale-crop');
  const stalePlan = JSON.parse(JSON.stringify(staleFixture.plan));
  stalePlan.tile_manifest[0].mapping_verified = false;
  const stale = apply(staleFixture, matchesExistingTraceRow(), [], stalePlan);
  assert.equal(stale.topology_audit.targeted_trace.candidate_traces[0].disposition, 'unresolved');
  assert.match(stale.topology_audit.targeted_trace.candidate_traces[0].issues.join(' | '),
    /mapping metadata is missing, stale, or inconsistent/);
});

test('12zfdcb. targeted trace requires complete same-frame crop provenance at plan and apply time', () => {
  const fixture = targetedTraceFixture('scan-trace-provenance');
  const variants = [
    ['missing original_size', tile => { delete tile.original_size; }],
    ['stale crop_bbox', tile => { tile.crop_bbox = unitBox(0.01, 0, 0.99, 1); }],
    ['stale source_bbox', tile => { tile.source_bbox = unitBox(0, 0.01, 1, 0.99); }],
    ['foreign image role', tile => { tile.image_role = 'topology_tile'; }],
  ];
  variants.forEach(([name, mutate], index) => {
    const tile = JSON.parse(JSON.stringify(fixture.tile));
    mutate(tile);
    const manifest = server.normalizeTopologyAuditManifest([tile], []);
    const plan = server.planTopologyTargetedTrace(
      fixture.replacement, ['data:image/png;base64,full-original'], ['original_same_frame'],
      [tile], manifest,
    );
    assert.equal(plan.should_call, false, `${name}: untrustworthy mapping cannot reach the model`);
    assert.ok(plan.rejected_tile_mappings.length > 0, `${name}: mapping failure remains explicit evidence`);
    const skipped = server.applyTopologyTargetedTrace(
      fixture.replacement, null, fixture.session,
      { plan, attempted: false },
    );
    assert.deepEqual(skipped.topology_audit.targeted_trace.rejected_tile_mappings,
      plan.rejected_tile_mappings, `${name}: exact provenance rejection survives in persisted audit evidence`);
    assert.match(skipped.topology_audit.targeted_trace.issues.join(' | '),
      /no provenance-validated topology tile/, `${name}: exported issue distinguishes rejected provenance from geometric containment`);
  });

  const stalePlan = JSON.parse(JSON.stringify(fixture.plan));
  stalePlan.tile_manifest[0].mapping_verified = false;
  const out = server.applyTopologyTargetedTrace(
    fixture.replacement, traceResponse(), fixture.session,
    { plan: stalePlan, attempted: true },
  );
  assert.equal(out.topology.transitions.length, 1,
    'a stale mapping introduced after planning is revalidated and cannot add');
  assert.match(out.topology_audit.targeted_trace.candidate_traces[0].issues.join(' | '),
    /mapping metadata is missing, stale, or inconsistent/);
});

test('12zfdcc. targeted trace prompt exposes only opaque call-local aliases and maps them back server-side', () => {
  const fixture = targetedTraceFixture('scan-trace-opaque-aliases', {
    stateIds: ['q0', 'q1', 'q2'], transitionId: 'q0_to_q1',
  });
  const prompt = server.buildTopologyTargetedTracePrompt(fixture.plan, 'pda');
  assert.doesNotMatch(prompt, /q0|q1|q2|q0_to_q1/,
    'raw observation/transition ids and visible-looking q labels never enter the model prompt');
  assert.deepEqual(fixture.plan.state_manifest.map(row => row.observation_ref),
    ['state_ref_001', 'state_ref_002', 'state_ref_003']);
  assert.equal(fixture.plan.state_manifest.some(row => 'observation_id' in row), false);
  assert.equal(fixture.plan.existing_transition_manifest.some(row => 'transition_id' in row), false);

  const out = server.applyTopologyTargetedTrace(
    fixture.replacement, traceResponse(), fixture.session,
    { plan: fixture.plan, attempted: true },
  );
  const added = out.topology.transitions.find(row => row.provisional);
  assert.ok(added, 'valid call-local aliases still map to the intended stored geometry');
  assert.equal(added.source_observation_id, 'q1');
  assert.equal(added.target_observation_id, 'q1');
});

test('12zfdcd. non-arrowhead and start-marker verdicts resolve only with complete high-confidence clean evidence', () => {
  const fixture = targetedTraceFixture('scan-trace-verdict-gates', { candidateSelfLoop: 'NO' });
  const applyRow = (row, responseIssues = []) => server.applyTopologyTargetedTrace(
    fixture.replacement, { candidate_traces: [row], issues: responseIssues }, fixture.session,
    { plan: fixture.plan, attempted: true },
  ).topology_audit.targeted_trace.candidate_traces[0];

  assert.equal(applyRow(verifiedOmittedTraceRow({ verdict: 'NOT_ARROWHEAD' })).disposition,
    'not_arrowhead');
  assert.equal(applyRow(verifiedOmittedTraceRow({
    verdict: 'NOT_ARROWHEAD', candidate_confidence: 0.89,
  })).disposition, 'unresolved');
  assert.equal(applyRow(verifiedOmittedTraceRow({
    verdict: 'NOT_ARROWHEAD', issues: ['ink classification remains ambiguous'],
  })).disposition, 'unresolved');

  const startMarkerRow = verifiedOmittedTraceRow({
    verdict: 'START_MARKER',
    connector_bbox_in_crop: unitBox(0.82, 0.32, 0.05, 0.075),
    tail_contact_bbox_in_crop: unitBox(0.83, 0.32, 0.02, 0.02),
    source_observation_id: '', target_observation_id: 'state_ref_002',
    orientation: { value: 'S', confidence: 0.96 },
    self_loop: { value: 'NO', confidence: 0.96 },
  });
  assert.equal(applyRow(startMarkerRow).disposition, 'start_marker');
  assert.equal(applyRow({ ...startMarkerRow, connector_confidence: 0.89 }).disposition,
    'unresolved');
  assert.equal(applyRow({ ...startMarkerRow,
    self_loop: { value: 'NO', confidence: 0 },
  }).disposition, 'unresolved', 'zero self-loop confidence cannot resolve a start marker');
  assert.equal(applyRow({ ...startMarkerRow, issues: ['tail origin is not fully visible'] }).disposition,
    'unresolved');

  const straddling = applyRow({
    ...startMarkerRow,
    connector_bbox_in_crop: unitBox(0.80, 0.36, 0.08, 0.08),
    tail_contact_bbox_in_crop: unitBox(0.80, 0.39, 0.03, 0.03),
  });
  assert.equal(straddling.disposition, 'unresolved');
  assert.match(straddling.issues.join(' | '), /tail must remain in clear empty space/,
    'a tail straddling a state boundary is not an empty-space start tail');

  const conflictingFixture = targetedTraceFixture('scan-trace-start-inventory-conflict', {
    candidateSelfLoop: 'YES',
  });
  const inventoryConflict = server.applyTopologyTargetedTrace(
    conflictingFixture.replacement,
    { candidate_traces: [startMarkerRow], issues: [] }, conflictingFixture.session,
    { plan: conflictingFixture.plan, attempted: true },
  ).topology_audit.targeted_trace.candidate_traces[0];
  assert.equal(inventoryConflict.disposition, 'unresolved');
  assert.match(inventoryConflict.issues.join(' | '), /inventory self-loop evidence/);
});

test('12zfdcda. foreign extra rows atomically block NOT_ARROWHEAD and START_MARKER closure', () => {
  const startMarkerRow = verifiedOmittedTraceRow({
    verdict: 'START_MARKER',
    connector_bbox_in_crop: unitBox(0.82, 0.32, 0.05, 0.075),
    tail_contact_bbox_in_crop: unitBox(0.83, 0.32, 0.02, 0.02),
    source_observation_id: '', target_observation_id: 'state_ref_002',
    orientation: { value: 'S', confidence: 0.96 },
    self_loop: { value: 'NO', confidence: 0.96 },
  });
  const cases = [
    ['NOT_ARROWHEAD', verifiedOmittedTraceRow({ verdict: 'NOT_ARROWHEAD' })],
    ['START_MARKER', startMarkerRow],
  ];
  cases.forEach(([name, valid], index) => {
    const fixture = targetedTraceFixture(`scan-trace-atomic-${name}-${index}`, {
      candidateSelfLoop: 'NO',
    });
    const foreign = { ...valid, candidate_id: `foreign_${name.toLowerCase()}` };
    const out = server.applyTopologyTargetedTrace(
      fixture.replacement, { candidate_traces: [valid, foreign], issues: [] }, fixture.session,
      { plan: fixture.plan, attempted: true },
    );
    const audit = out.topology_audit.targeted_trace;
    assert.equal(audit.candidate_traces.find(row =>
      row.candidate_id === valid.candidate_id).disposition, 'unresolved',
    `${name}: a foreign extra row prevents definitive closure`);
    assert.equal(audit.raw_candidate_traces.length, 2, `${name}: raw rows remain preserved`);
    assert.ok(audit.unresolved_connector_candidates.some(row =>
      row.candidate_id === foreign.candidate_id), `${name}: foreign row remains unresolved`);
    assert.match(audit.atomic_structural_issues.join(' | '), /foreign|returned 2 rows/);
    assert.equal(out.topology.transitions.length, 1);
  });
});

test('12zfdce. a target-only tile cannot verify an omitted long connector', () => {
  const tileBbox = unitBox(0.72, 0.30, 0.22, 0.32);
  const fixture = targetedTraceFixture('scan-trace-long-connector-tile', { tileBbox });
  fixture.plan.candidate_manifest[0].inventory_orientation = { value: 'E', confidence: 0.95 };
  fixture.plan.candidate_manifest[0].inventory_self_loop_hint = { value: 'NO', confidence: 0.95 };
  const out = server.applyTopologyTargetedTrace(
    fixture.replacement,
    traceResponse(verifiedOmittedTraceRow({
      arrowhead_bbox_in_crop: unitBox(0.50, 0.21875, 0.113636, 0.078125),
      connector_bbox_in_crop: unitBox(0.01, 0.20, 0.61, 0.35),
      tail_contact_bbox_in_crop: unitBox(0.01, 0.45, 0.05, 0.05),
      source_observation_id: 'state_ref_001', target_observation_id: 'state_ref_002',
      orientation: { value: 'E', confidence: 0.96 },
      self_loop: { value: 'NO', confidence: 0.96 },
    })),
    fixture.session, { plan: fixture.plan, attempted: true },
  );
  assert.equal(out.topology.transitions.length, 1);
  assert.match(out.topology_audit.targeted_trace.candidate_traces[0].issues.join(' | '),
    /long connector.*endpoint boundaries lie outside|endpoint boundaries lie outside.*tile/);
});

test('12zfdd. targeted trace API failure is persisted and adds nothing', () => {
  const fixture = targetedTraceFixture('scan-trace-failure');
  const out = server.applyTopologyTargetedTrace(
    fixture.replacement, null, fixture.session,
    { plan: fixture.plan, attempted: true, error: new Error('trace verifier unavailable') },
  );
  assert.equal(out.topology.transitions.length, 1);
  assert.equal(out.topology_audit.targeted_trace.failed, true);
  assert.equal(out.topology_audit.targeted_trace.unresolved_connector_candidates.length, 1);
  assert.match(out.issues.join(' | '), /targeted unmatched-arrowhead trace failed.*trace verifier unavailable/);
});

test('12zfde. parse audit conditionally traces unmatched evidence before line geometry', async () => {
  const fixture = targetedTraceFixture('scan-trace-parse-positive');
  const calls = [];
  const visionCall = async request => {
    calls.push(request);
    if (request.schemaName === 'automaton_topology_geometric_inventory') return fixture.inventoryRaw;
    if (request.schemaName === 'automaton_topology_audit_stage') return fixture.topologyRaw;
    if (request.schemaName === 'automaton_topology_targeted_trace') return traceResponse();
    if (request.schemaName === 'automaton_topology_line_geometry_audit') {
      return {
        connector_lines: ['transition_1', 'transition_trace_1'].map((transitionId, index) => ({
          transition_id: transitionId,
          label_block_bbox: unitBox(0.3 + index * 0.3, 0.2, 0.2, 0.08),
          visible_line_count: 1,
          line_hints: [{ line_id: `parse_trace_line_${index + 1}`,
            bbox: unitBox(0.31 + index * 0.3, 0.21, 0.18, 0.04), confidence: 0.95, issues: [] }],
          confidence: 0.95,
          issues: [],
        })),
        issues: [],
      };
    }
    throw new Error(`unexpected schema ${request.schemaName}`);
  };
  const out = await server.parseTopologyAuditStage(
    fixture.initial,
    ['data:image/png;base64,full-original'],
    ['original_same_frame'],
    [fixture.tile],
    'pda', fixture.session, { callVisionJson: visionCall,
      topologyEscalationEnabled: true, topologyEscalationModel: 'gpt-5.6-terra',
      topologyLineGeometryEnabled: true },
  );
  assert.deepEqual(calls.map(call => call.schemaName), [
    'automaton_topology_geometric_inventory',
    'automaton_topology_audit_stage',
    'automaton_topology_audit_stage',
    'automaton_topology_targeted_trace',
    'automaton_topology_line_geometry_audit',
  ]);
  assert.equal(calls[0].model, 'gpt-5.6-luna');
  assert.equal(calls[1].model, 'gpt-5.6-luna');
  assert.equal(calls[2].model, 'gpt-5.6-terra',
    'a structurally uncertain replacement is rechecked by Terra');
  assert.equal(calls[3].model, 'gpt-5.6-terra',
    'targeted unmatched evidence is a high-risk escalation');
  assert.equal(calls[3].urls.length, 2, 'targeted call sees the full original plus containing tile only');
  assert.match(calls[4].prompt, /transition_trace_1/,
    'the provisional connector is present in the subsequent line audit manifest');
  assert.equal(out.topology.transitions.length, 2);
  const provisional = out.topology.transitions.find(transition => transition.provisional);
  assert.equal(provisional.scan_incomplete, true);
  assert.equal(out.review_only, true);
});

test('12zfdf. parse makes no targeted call without unmatched candidates and survives trace API failure', async () => {
  const cleanSession = 'scan-trace-no-unmatched';
  const cleanTopologyRaw = mockedTopologyRaw(1);
  const cleanInitial = server.normalizeTopologyStageResult(cleanTopologyRaw, cleanSession);
  const cleanInventoryRaw = mockedTopologyInventoryRaw(2, 1);
  const cleanTile = mockedTopologyTile('clean_trace_tile', unitBox(0, 0, 1, 1));
  const cleanCalls = [];
  const cleanOut = await server.parseTopologyAuditStage(
    cleanInitial, ['data:image/png;base64,full-original'], ['original_same_frame'],
    [cleanTile], 'pda', cleanSession, { callVisionJson: async request => {
      cleanCalls.push(request.schemaName);
      if (request.schemaName === 'automaton_topology_geometric_inventory') return cleanInventoryRaw;
      if (request.schemaName === 'automaton_topology_audit_stage') return cleanTopologyRaw;
      if (request.schemaName === 'automaton_topology_line_geometry_audit') return mockedLineGeometryAuditRaw(1);
      throw new Error('targeted trace must not be called');
    } },
  );
  assert.deepEqual(cleanCalls, ['automaton_topology_geometric_inventory',
    'automaton_topology_audit_stage', 'automaton_topology_line_geometry_audit']);
  assert.equal(cleanOut.topology_audit.targeted_trace.attempted, false);
  assert.equal(cleanOut.topology_audit.targeted_trace.requested_candidate_ids.length, 0);

  const failureFixture = targetedTraceFixture('scan-trace-parse-failure');
  const failureCalls = [];
  const failed = await server.parseTopologyAuditStage(
    failureFixture.initial, ['data:image/png;base64,full-original'], ['original_same_frame'],
    [failureFixture.tile], 'pda', failureFixture.session, { callVisionJson: async request => {
      failureCalls.push(request.schemaName);
      if (request.schemaName === 'automaton_topology_geometric_inventory') return failureFixture.inventoryRaw;
      if (request.schemaName === 'automaton_topology_audit_stage') return failureFixture.topologyRaw;
      if (request.schemaName === 'automaton_topology_targeted_trace') throw new Error('mock trace outage');
      if (request.schemaName === 'automaton_topology_line_geometry_audit') return mockedLineGeometryAuditRaw(1);
      throw new Error(`unexpected schema ${request.schemaName}`);
    } },
  );
  assert.deepEqual(failureCalls, ['automaton_topology_geometric_inventory',
    'automaton_topology_audit_stage', 'automaton_topology_targeted_trace',
    'automaton_topology_line_geometry_audit']);
  assert.equal(failed.topology.transitions.length, 1);
  assert.equal(failed.topology_audit.targeted_trace.failed, true);
  assert.equal(failed.review_only, true);
});

test('12zfe. line-geometry schema is keyed by transition and cannot rewrite topology or semantics', () => {
  const schema = server.topologyLineGeometryAuditSchema();
  assert.deepEqual(schema.required, ['connector_lines', 'issues']);
  const row = schema.properties.connector_lines.items;
  for (const key of ['transition_id', 'label_block_bbox', 'visible_line_count',
    'line_hints', 'confidence', 'issues']) assert.ok(row.required.includes(key));
  for (const forbidden of ['source_observation_id', 'target_observation_id', 'connector_bbox',
    'arrowhead_bbox', 'states', 'raw_label_text', 'read_input', 'stack_action']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row.properties, forbidden), false);
  }
});

test('12zff. line-geometry audit normalization preserves one complete row per existing connector', () => {
  const topology = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-line-audit-ok');
  const out = server.normalizeTopologyLineGeometryAuditResult(
    mockedLineGeometryAuditRaw(1), topology, 'scan-line-audit-ok');
  assert.equal(out.stage, 'topology-line-geometry-audit');
  assert.equal(out.review_only, false);
  assert.equal(out.line_geometry_audit.connector_lines.length, 1);
  assert.equal(out.line_geometry_audit.connector_lines[0].transition_id, 'transition_1');
  assert.equal(out.line_geometry_audit.connector_lines[0].line_hints.length, 1);
});

test('12zfg. missing duplicate foreign and count-mismatched line rows remain review evidence', () => {
  const topology = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-line-audit-bad');
  const first = mockedLineGeometryAuditRaw(1).connector_lines[0];
  const duplicate = JSON.parse(JSON.stringify(first));
  const foreign = mockedLineGeometryAuditRaw(1, 'foreign_transition').connector_lines[0];
  first.visible_line_count = 3;
  const out = server.normalizeTopologyLineGeometryAuditResult({
    connector_lines: [first, duplicate, foreign], issues: [],
  }, topology, 'scan-line-audit-bad');
  assert.equal(out.review_only, true);
  assert.equal(out.line_geometry_audit.connector_lines.length, 3,
    'foreign and duplicate evidence is retained rather than deleted');
  assert.match(out.line_geometry_audit.issues.join(' | '), /duplicate line-geometry row/);
  assert.match(out.line_geometry_audit.connector_lines[0].issues.join(' | '), /visible_line_count 3 does not match/);
  assert.match(out.line_geometry_audit.connector_lines[2].issues.join(' | '), /foreign line-geometry transition_id/);
});

test('12zfh. line-geometry apply changes only the whitelisted label fields and keeps pre-line evidence', () => {
  const replacement = server.normalizeTopologyAuditStageResult(
    mockedTopologyRaw(1), server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-line-apply'),
    [mockedTopologyTile()], 'scan-line-apply');
  const before = JSON.parse(JSON.stringify(replacement.topology));
  const raw = mockedLineGeometryAuditRaw(2);
  const out = server.applyTopologyLineGeometryAudit(replacement, raw, 'scan-line-apply',
    { model: 'line-model' });
  assert.equal(out.topology_audit.line_geometry_changed, true);
  assert.equal(out.topology_audit.line_geometry_failed, false);
  assert.equal(out.review_only, true, 'every geometry replacement requires human review');
  assert.deepEqual(out.topology.states, before.states);
  assert.equal(out.topology.transitions.length, before.transitions.length);
  assert.equal(out.topology.transitions[0].source_observation_id,
    before.transitions[0].source_observation_id);
  assert.equal(out.topology.transitions[0].target_observation_id,
    before.transitions[0].target_observation_id);
  assert.deepEqual(out.topology.transitions[0].connector_bbox, before.transitions[0].connector_bbox);
  assert.deepEqual(out.topology.transitions[0].arrowhead_bbox, before.transitions[0].arrowhead_bbox);
  assert.equal(out.topology.transitions[0].visible_line_count, 2);
  assert.deepEqual(out.topology.transitions[0].line_hints.map(line => line.line_id),
    ['audited_line_1', 'audited_line_2']);
  assert.equal(out.topology.connector_observations[0].visible_line_count, 2);
  assert.deepEqual(out.topology.connectors[0].line_hints, out.topology.transitions[0].line_hints);
  assert.equal(out.topology.connectors[0].source_observation_id,
    before.connectors[0].source_observation_id);
  assert.equal(out.topology.connectors[0].target_observation_id,
    before.connectors[0].target_observation_id);
  assert.deepEqual(out.topology_audit.pre_line_topology, before);
  assert.equal(out.topology_audit.line_geometry_audit.connector_lines.length, 1);
  assert.equal(out.topology_audit.line_geometry_model, 'line-model');
});

test('12zfi. duplicate line rows are never applied and cannot alter the connector', () => {
  const replacement = server.normalizeTopologyAuditStageResult(
    mockedTopologyRaw(1), server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-line-duplicate'),
    [mockedTopologyTile()], 'scan-line-duplicate');
  const before = JSON.parse(JSON.stringify(replacement.topology));
  const row = mockedLineGeometryAuditRaw(2).connector_lines[0];
  const out = server.applyTopologyLineGeometryAudit(replacement, {
    connector_lines: [row, JSON.parse(JSON.stringify(row))], issues: [],
  }, 'scan-line-duplicate');
  assert.equal(out.topology_audit.line_geometry_changed, false);
  assert.equal(out.review_only, true);
  assert.deepEqual(out.topology.transitions[0].line_hints, before.transitions[0].line_hints);
  assert.deepEqual(out.topology.transitions[0].label_block_bbox, before.transitions[0].label_block_bbox);
});

test('12zfj. line-geometry failure preserves replacement topology and records normalized evidence', () => {
  const replacement = server.normalizeTopologyAuditStageResult(
    mockedTopologyRaw(1), server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-line-failed'),
    [mockedTopologyTile()], 'scan-line-failed');
  const before = JSON.parse(JSON.stringify(replacement.topology));
  const out = server.applyTopologyLineGeometryAudit(replacement, null, 'scan-line-failed',
    { error: new Error('line verifier unavailable') });
  assert.equal(out.topology_audit.line_geometry_failed, true);
  assert.equal(out.topology_audit.line_geometry_changed, false);
  assert.equal(out.review_only, true);
  assert.deepEqual(out.topology.states, before.states);
  assert.deepEqual(out.topology.transitions, before.transitions);
  assert.deepEqual(out.topology.connector_observations, before.connector_observations);
  assert.match(out.issues.join(' | '), /line-geometry audit failed.*replacement topology preserved/);
  assert.match(out.topology_audit.line_geometry_audit.issues.join(' | '), /missing its line-geometry row/);
});

test('12zfk. line-geometry prompt receives only immutable connector geometry and forbids OCR', () => {
  const topology = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-line-prompt');
  const manifest = server.topologyLineGeometryConnectorManifest(topology);
  assert.equal(manifest.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest[0], 'source_observation_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest[0], 'target_observation_id'), false);
  const prompt = server.buildTopologyLineGeometryAuditPrompt(
    manifest, ['original_same_frame'], [mockedTopologyTile()], [], 'pda');
  assert.match(prompt, /PIXELS ONLY, NO OCR/);
  assert.match(prompt, /exactly one connector_lines row for every manifest transition_id/);
  assert.match(prompt, /One handwritten transition-rule row is one baseline/);
  assert.match(prompt, /Never add, remove, merge, split, redirect, or renumber/);
  assert.match(prompt, /bottom-left region/);
});

test('12zfl. one full row plus one narrow overlapping fragment becomes one logical baseline', () => {
  const physical = [
    physicalLineFragment('main_fragment', 0.2, 0.2, 0.24, 0.04),
    physicalLineFragment('right_fragment', 0.41, 0.205, 0.055, 0.045),
  ];
  const original = JSON.parse(JSON.stringify(physical));
  const grouped = server.groupTopologyLineFragments(unitBox(0.2, 0.18, 0.3, 0.1), physical);
  assert.equal(grouped.logical_visible_line_count, 1);
  assert.equal(grouped.grouping_changed, true);
  assert.equal(grouped.structurally_valid, true);
  assert.deepEqual(grouped.logical_line_groups[0].member_line_ids,
    ['main_fragment', 'right_fragment']);
  assert.deepEqual(grouped.logical_line_groups[0].member_fragment_indexes, [0, 1]);
  assert.deepEqual(grouped.logical_line_groups[0].member_fragments, original,
    'logical-line lineage retains the complete normalized physical fragments');
  assert.deepEqual(grouped.physical_fragments, original,
    'physical fragments remain verbatim evidence after grouping');
  assert.deepEqual(physical, original, 'grouping never mutates its input evidence');
});

test('12zfla. one tiny action symbol wrapped below its word remains part of the same rule', () => {
  const grouped = server.groupTopologyLineFragments(unitBox(0.1, 0.1, 0.5, 0.18), [
    physicalLineFragment('complete_rule_without_final_symbol', 0.1, 0.12, 0.43, 0.055),
    physicalLineFragment('wrapped_action_symbol', 0.49, 0.18, 0.035, 0.035),
  ]);
  assert.equal(grouped.logical_visible_line_count, 1);
  assert.equal(grouped.structurally_valid, true);
  assert.deepEqual(grouped.logical_line_groups[0].member_line_ids,
    ['complete_rule_without_final_symbol', 'wrapped_action_symbol']);
});

test('wrapped glyph grouping requires a complete left-anchored row, not another action fragment', () => {
  const original=[
    physicalLineFragment('short_action_fragment',0.4,0.12,0.12,0.04),
    physicalLineFragment('tiny_lower_fragment',0.48,0.17,0.025,0.03),
  ];
  const grouped=server.groupTopologyLineFragments(unitBox(0.1,0.1,0.5,0.3),original);
  assert.equal(grouped.logical_visible_line_count,2);
  assert.equal(grouped.grouping_changed,false);
  assert.deepEqual(grouped.physical_fragments,original);
});

test('12zfm. two full seeds stay separate while one narrow fragment joins only its unique nearest seed', () => {
  const grouped = server.groupTopologyLineFragments(unitBox(0.1, 0.1, 0.5, 0.3), [
    physicalLineFragment('upper_seed', 0.1, 0.12, 0.42, 0.05),
    physicalLineFragment('lower_seed', 0.1, 0.3, 0.43, 0.05),
    physicalLineFragment('upper_suffix', 0.48, 0.125, 0.08, 0.055),
  ]);
  assert.equal(grouped.logical_visible_line_count, 2);
  assert.deepEqual(grouped.logical_line_groups.map(group => group.member_line_ids), [
    ['upper_seed', 'upper_suffix'],
    ['lower_seed'],
  ]);
});

test('12zfma. a nearby short real row without strong same-baseline suffix evidence is never merged', () => {
  const cases = [
    [
      physicalLineFragment('same_x_full_row', 0.1, 0.12, 0.42, 0.05),
      physicalLineFragment('same_x_short_row', 0.1, 0.16, 0.16, 0.045),
    ],
    [
      physicalLineFragment('shifted_full_row', 0.1, 0.12, 0.42, 0.05),
      physicalLineFragment('shifted_but_separate_short_row', 0.34, 0.185, 0.16, 0.045),
    ],
  ];
  cases.forEach(fragments => {
    const grouped = server.groupTopologyLineFragments(unitBox(0.1, 0.1, 0.5, 0.2), fragments);
    assert.equal(grouped.logical_visible_line_count, 2);
    assert.equal(grouped.grouping_changed, false);
    assert.equal(grouped.structurally_valid, true);
    assert.deepEqual(grouped.logical_line_groups.map(group => group.member_line_ids),
      fragments.map(fragment => [fragment.line_id]),
    'same-x evidence or a missing baseline overlap keeps the short row independent');
    assert.deepEqual(grouped.physical_fragments, fragments, 'all original segment evidence remains intact');
  });
});

test('12zfn. three full left-anchored rows are protected from merging', () => {
  const grouped = server.groupTopologyLineFragments(unitBox(0.1, 0.1, 0.5, 0.3), [
    physicalLineFragment('row_one', 0.1, 0.11, 0.46, 0.055),
    physicalLineFragment('row_two', 0.1, 0.2, 0.45, 0.055),
    physicalLineFragment('row_three', 0.1, 0.29, 0.47, 0.055),
  ]);
  assert.equal(grouped.logical_visible_line_count, 3);
  assert.equal(grouped.grouping_changed, false);
  assert.deepEqual(grouped.logical_line_groups.map(group => group.member_line_ids),
    [['row_one'], ['row_two'], ['row_three']]);
});

test('12zfo. an equidistant fragment is unresolved and cannot silently replace line geometry', () => {
  const block = unitBox(0.2, 0.1, 0.4, 0.3);
  const lines = [
    physicalLineFragment('upper_seed', 0.2, 0.14, 0.32, 0.06),
    physicalLineFragment('lower_seed', 0.2, 0.19, 0.33, 0.06),
    physicalLineFragment('ambiguous_fragment', 0.5, 0.175, 0.06, 0.04),
  ];
  const grouped = server.groupTopologyLineFragments(block, lines);
  assert.equal(grouped.structurally_valid, false);
  assert.equal(grouped.unresolved_fragments.length, 1);
  assert.equal(grouped.unresolved_fragments[0].line_id, 'ambiguous_fragment');

  const replacement = server.normalizeTopologyAuditStageResult(
    mockedTopologyRaw(1), server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-ambiguous-lines'),
    [mockedTopologyTile()], 'scan-ambiguous-lines');
  const before = JSON.parse(JSON.stringify(replacement.topology.transitions[0]));
  const out = server.applyTopologyLineGeometryAudit(replacement, {
    connector_lines: [{
      transition_id: 'transition_1', label_block_bbox: block,
      visible_line_count: lines.length, line_hints: lines, confidence: 0.94, issues: [],
    }],
    issues: [],
  }, 'scan-ambiguous-lines');
  assert.deepEqual(out.topology.transitions[0].line_hints, before.line_hints);
  assert.deepEqual(out.topology.transitions[0].label_block_bbox, before.label_block_bbox);
  assert.match(out.issues.join(' | '), /not applied.*ambiguous/);
});

test('12zfp. low-confidence grouped geometry remains evidence but cannot replace crop geometry', () => {
  const replacement = server.normalizeTopologyAuditStageResult(
    mockedTopologyRaw(1), server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-low-group'),
    [mockedTopologyTile()], 'scan-low-group');
  const before = JSON.parse(JSON.stringify(replacement.topology.transitions[0]));
  const raw = mockedLineGeometryAuditRaw(1);
  raw.connector_lines[0].label_block_bbox = unitBox(0.2, 0.18, 0.3, 0.1);
  raw.connector_lines[0].visible_line_count = 2;
  raw.connector_lines[0].line_hints = [
    physicalLineFragment('main_fragment', 0.2, 0.2, 0.24, 0.04, 0.51),
    physicalLineFragment('right_fragment', 0.41, 0.205, 0.055, 0.045, 0.43),
  ];
  raw.connector_lines[0].confidence = 0.49;
  const out = server.applyTopologyLineGeometryAudit(replacement, raw, 'scan-low-group');
  const evidence = out.topology_audit.line_geometry_audit.connector_lines[0];
  assert.deepEqual(out.topology.transitions[0].label_block_bbox, before.label_block_bbox);
  assert.deepEqual(out.topology.transitions[0].line_hints, before.line_hints,
    'low-confidence audit pixels never overwrite the previous crop coordinates');
  assert.equal(out.topology_audit.line_geometry_changed, false);
  assert.equal(out.review_only, true, 'low confidence and grouping remain globally blocking');
  assert.equal(evidence.physical_fragments.length, 2);
  assert.equal(evidence.raw_physical_fragments.length, 2);
  assert.deepEqual(evidence.raw_physical_fragments, raw.connector_lines[0].line_hints,
    'the original model fragments remain verbatim in audit evidence');
  assert.match(out.issues.join(' | '), /not applied.*invalid or geometrically ambiguous/);
});

test('12zfq. generic export-like geometry reduces eighteen fragments to fourteen logical rows without ids', () => {
  const cases = [
    [unitBox(0.1, 0.1, 0.1, 0.05), [physicalLineFragment('a1', 0.1, 0.1, 0.1, 0.05)]],
    [unitBox(0.2, 0.1, 0.1, 0.08), [
      physicalLineFragment('b1', 0.2, 0.1, 0.055, 0.035),
      physicalLineFragment('b2', 0.265, 0.108, 0.035, 0.064),
    ]],
    [unitBox(0.3, 0.1, 0.1, 0.05), [physicalLineFragment('c1', 0.3, 0.1, 0.1, 0.05)]],
    [unitBox(0.4, 0.1, 0.15, 0.13), [
      physicalLineFragment('d1', 0.4, 0.1, 0.14, 0.036),
      physicalLineFragment('d2', 0.4, 0.14, 0.14, 0.036),
      physicalLineFragment('d3', 0.4, 0.18, 0.14, 0.036),
    ]],
    [unitBox(0.6, 0.1, 0.12, 0.11), [
      physicalLineFragment('e1', 0.6, 0.1, 0.115, 0.045),
      physicalLineFragment('e2', 0.6, 0.16, 0.115, 0.045),
    ]],
    [unitBox(0.1, 0.4, 0.12, 0.15), [
      physicalLineFragment('f1', 0.1, 0.4, 0.1, 0.046),
      physicalLineFragment('f2', 0.1, 0.44, 0.118, 0.048),
      physicalLineFragment('f3', 0.17, 0.445, 0.046, 0.038),
    ]],
    [unitBox(0.25, 0.4, 0.1, 0.07), [physicalLineFragment('g1', 0.25, 0.4, 0.1, 0.07)]],
    [unitBox(0.4, 0.4, 0.09, 0.11), [
      physicalLineFragment('h1', 0.4, 0.4, 0.09, 0.062),
      physicalLineFragment('h2', 0.46, 0.407, 0.028, 0.05),
    ]],
    [unitBox(0.55, 0.4, 0.13, 0.07), [
      physicalLineFragment('i1', 0.55, 0.4, 0.13, 0.041),
      physicalLineFragment('i2', 0.65, 0.407, 0.03, 0.027),
    ]],
    [unitBox(0.7, 0.4, 0.14, 0.06), [physicalLineFragment('j1', 0.7, 0.4, 0.14, 0.06)]],
  ];
  const grouped = cases.map(([block, fragments]) =>
    server.groupTopologyLineFragments(block, fragments));
  assert.equal(grouped.reduce((sum, row) => sum + row.physical_fragments.length, 0), 18);
  assert.equal(grouped.reduce((sum, row) => sum + row.logical_visible_line_count, 0), 14);
  assert.ok(grouped.every(row => row.structurally_valid));
});

test('12zfra. live export 5 exact ten-block geometry reduces 18 physical fragments to 14 logical rows', () => {
  const fixture = liveExport5LineGeometryFixture();
  const originals = JSON.parse(JSON.stringify(fixture));
  const grouped = fixture.map(([block, fragments]) =>
    server.groupTopologyLineFragments(block, fragments));
  assert.equal(grouped.reduce((sum, row) => sum + row.physical_fragments.length, 0), 18);
  assert.equal(grouped.reduce((sum, row) => sum + row.logical_visible_line_count, 0), 14);
  assert.deepEqual(grouped.map(row => row.logical_visible_line_count),
    [1, 1, 1, 3, 2, 2, 1, 1, 1, 1]);
  assert.ok(grouped.every(row => row.structurally_valid));
  assert.deepEqual(fixture, originals, 'the exact live physical fixture remains immutable');
  assert.deepEqual(grouped[1].logical_line_groups[0].member_line_ids, ['line_2', 'line_3']);
  assert.deepEqual(grouped[5].logical_line_groups[0].member_line_ids, ['line_10', 'line_11']);
  assert.deepEqual(grouped[7].logical_line_groups[0].member_line_ids, ['line_14', 'line_15']);
  assert.deepEqual(grouped[8].logical_line_groups[0].member_line_ids, ['line_16', 'line_17']);
});

test('12zfrb. live export 6 exact ten-block geometry reduces 17 physical fragments to 14 logical rows', () => {
  const fixture = liveExport6LineGeometryFixture();
  const originals = JSON.parse(JSON.stringify(fixture));
  const grouped = fixture.map(([block, fragments]) =>
    server.groupTopologyLineFragments(block, fragments));
  assert.equal(grouped.reduce((sum, row) => sum + row.physical_fragments.length, 0), 17);
  assert.equal(grouped.reduce((sum, row) => sum + row.logical_visible_line_count, 0), 14);
  assert.deepEqual(grouped.map(row => row.logical_visible_line_count),
    [1, 1, 1, 1, 3, 2, 2, 1, 1, 1]);
  assert.ok(grouped.every(row => row.structurally_valid));
  assert.deepEqual(fixture, originals, 'the second live physical fixture remains immutable');
  assert.deepEqual(grouped[1].logical_line_groups[0].member_line_ids, ['line_2', 'line_3']);
  assert.deepEqual(grouped[7].logical_line_groups[0].member_line_ids, ['line_13', 'line_14']);
  assert.deepEqual(grouped[8].logical_line_groups[0].member_line_ids, ['line_15', 'line_16']);
});

test('12zfrc. live export 7 exact nine-block geometry reduces 17 physical fragments to 13 logical rows', () => {
  const fixture = liveExport7LineGeometryFixture();
  const originals = JSON.parse(JSON.stringify(fixture));
  const grouped = fixture.map(([block, fragments]) =>
    server.groupTopologyLineFragments(block, fragments));
  assert.equal(grouped.reduce((sum, row) => sum + row.physical_fragments.length, 0), 17);
  assert.equal(grouped.reduce((sum, row) => sum + row.logical_visible_line_count, 0), 13);
  assert.deepEqual(grouped.map(row => row.logical_visible_line_count),
    [1, 1, 1, 1, 3, 2, 2, 1, 1]);
  assert.ok(grouped.every(row => row.structurally_valid));
  assert.deepEqual(fixture, originals, 'the third live physical fixture remains immutable');
  assert.deepEqual(grouped[1].logical_line_groups[0].member_line_ids, ['line_2', 'line_3']);
  assert.deepEqual(grouped[6].logical_line_groups.find(group =>
    group.member_line_ids.length === 2).member_line_ids, ['line_12', 'line_13']);
  assert.deepEqual(grouped[7].logical_line_groups[0].member_line_ids, ['line_14', 'line_15']);
  assert.deepEqual(grouped[8].logical_line_groups[0].member_line_ids, ['line_16', 'line_17']);
});

test('12zf. topology-audit tile manifest preserves foreign and missing-bbox evidence as review-only', () => {
  const topIssues = [];
  const foreign = mockedTopologyTile('foreign_tile');
  foreign.kind = 'line';
  delete foreign.original_bbox;
  const rows = server.normalizeTopologyAuditManifest([
    mockedTopologyTile('valid_tile'),
    foreign,
  ], topIssues);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].scan_incomplete, false);
  assert.equal(rows[1].scan_incomplete, true);
  assert.match(rows[1].issues.join(' | '), /foreign topology-audit crop kind/);
  assert.match(rows[1].issues.join(' | '), /topology tile original_bbox is missing/);
  assert.match(topIssues.join(' | '), /foreign_tile.*malformed or incomplete/);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'image_url'), false,
    'base64 tile pixels are not echoed into persistent audit evidence');
});

test('12zg. a changed topology audit is review-only and keeps immutable initial evidence', () => {
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-audit-changed');
  const inputBefore = JSON.parse(JSON.stringify(initial));
  const auditedRaw = mockedTopologyRaw(1);
  auditedRaw.transitions[0].target_observation_id = 'state_left';
  auditedRaw.connector_observations[0].arrowhead_bbox = unitBox(0.18, 0.43, 0.03, 0.03);
  const out = server.normalizeTopologyAuditStageResult(
    auditedRaw,
    initial,
    [mockedTopologyTile()],
    'scan-audit-changed',
    { initial_model: 'topology-model', audit_model: 'audit-model', model_type: 'pda', image_roles: ['original_same_frame'] },
  );
  assert.equal(out.stage, 'topology-audit');
  assert.equal(out.topology_audit.changed, true);
  assert.equal(out.topology_audit.failed, false);
  assert.equal(out.review_only, true);
  assert.match(out.issues.join(' | '), /audit revised the initial extraction/);
  assert.equal(out.topology.transitions[0].target_observation_id, 'state_left');
  assert.equal(out.topology_audit.initial_topology.transitions[0].target_observation_id, 'state_right');
  assert.deepEqual(out.topology_audit.models, { initial: 'topology-model', audit: 'audit-model' });
  assert.deepEqual(initial, inputBefore, 'audit normalization did not mutate the Pass A envelope');
  out.topology.transitions[0].target_observation_id = 'mutated_afterward';
  assert.equal(out.topology_audit.initial_topology.transitions[0].target_observation_id, 'state_right',
    'the persisted initial snapshot does not alias the final topology');
});

test('12zga. reversed audited endpoints stay unresolved when arrowhead bbox remains beside the new source', () => {
  const session = 'scan-audit-arrowhead-target-conflict';
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), session);
  const auditedRaw = mockedTopologyRaw(1);
  auditedRaw.transitions[0].source_observation_id = 'state_right';
  auditedRaw.transitions[0].target_observation_id = 'state_left';
  // Preserve the physical arrowhead beside state_right. The inconsistent
  // second-pass endpoints remain in audit evidence, while the structured graph
  // keeps the geometrically safer first-pass endpoints.
  const preservedArrowhead = JSON.parse(JSON.stringify(
    auditedRaw.connector_observations[0].arrowhead_bbox));
  const out = server.normalizeTopologyAuditStageResult(
    auditedRaw, initial, [mockedTopologyTile()], session,
    { initial_model: 'topology-model', audit_model: 'audit-model' },
  );
  assert.equal(out.topology.transitions[0].source_observation_id, 'state_left');
  assert.equal(out.topology.transitions[0].target_observation_id, 'state_right');
  assert.deepEqual(out.topology.transitions[0].arrowhead_bbox, preservedArrowhead,
    'the inconsistent physical bbox remains unchanged evidence');
  assert.equal(out.topology.transitions[0].scan_incomplete, true);
  assert.equal(out.review_only, true);
  assert.match(out.issues.join(' | '), /endpoint change remains unresolved.*structured endpoints kept/);
  const validation = out.topology_audit.endpoint_geometry_validation.validations[0];
  assert.equal(validation.transition_id, 'transition_1');
  assert.equal(validation.consistent, false);
  assert.equal(validation.audited_source_observation_id, 'state_right');
  assert.equal(validation.audited_target_observation_id, 'state_left');
  assert.equal(validation.structured_source_observation_id, 'state_left');
  assert.equal(validation.structured_target_observation_id, 'state_right');
  assert.ok(validation.source_edge_distance < validation.target_edge_distance);
  assert.deepEqual(validation.arrowhead_bbox, preservedArrowhead);
});

test('12zgb. one-pass accepting-state hallucination remains audit evidence but not a double circle', () => {
  const session = 'scan-audit-accepting-consensus';
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), session);
  const auditedRaw = mockedTopologyRaw(1);
  auditedRaw.states[0].is_accepting = { value: true, confidence: 0.97 };
  const out = server.normalizeTopologyAuditStageResult(
    auditedRaw, initial, [mockedTopologyTile()], session,
    { initial_model: 'topology-model', audit_model: 'audit-model' },
  );
  assert.equal(out.topology.states[0].is_accepting.value, false,
    'one visual pass cannot create a final accepting state by itself');
  assert.equal(out.topology.states[1].is_accepting.value, true,
    'a double border confirmed by both passes remains accepting');
  assert.equal(out.topology_audit.state_flag_reconciliation.disagreements.length, 1);
  assert.equal(out.topology_audit.state_flag_reconciliation.disagreements[0].audited_value, true);
  assert.match(out.issues.join(' | '), /accepting-state border disagrees between independent passes/);
});

test('12zh. an unchanged clean topology audit can stay runnable', () => {
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-audit-same');
  const inventory = server.normalizeTopologyInventoryResult(mockedTopologyInventoryRaw(), 'scan-audit-same');
  const out = server.normalizeTopologyAuditStageResult(
    mockedTopologyRaw(1), initial, [mockedTopologyTile()], 'scan-audit-same',
    { initial_model: 'same-model', audit_model: 'same-model', inventory },
  );
  assert.equal(out.topology_audit.changed, false);
  assert.equal(out.topology_audit.failed, false);
  assert.equal(out.review_only, false);
  assert.deepEqual(out.issues, []);
});

test('12zha. inventory-versus-final count mismatch blocks review without inventing a connector', () => {
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-audit-inventory-mismatch');
  const inventory = server.normalizeTopologyInventoryResult(
    mockedTopologyInventoryRaw(3, 2), 'scan-audit-inventory-mismatch');
  const out = server.normalizeTopologyAuditStageResult(
    mockedTopologyRaw(1), initial, [mockedTopologyTile()], 'scan-audit-inventory-mismatch',
    { inventory, inventory_model: 'audit-model' },
  );
  assert.equal(out.topology_audit.changed, false, 'the audit output itself matched Pass A');
  assert.equal(out.review_only, true);
  assert.match(out.issues.join(' | '), /inventory state count 3 does not match final topology state count 2/);
  assert.match(out.issues.join(' | '), /inventory computational-arrowhead count 2 does not match final topology connector count 1/);
  assert.equal(out.topology.transitions.length, 1, 'no missing connector was fabricated from the inventory count');
  assert.equal(out.topology.connector_observations.length, 1);
  assert.equal(out.topology_audit.geometric_inventory.computational_arrowhead_candidates.length, 2,
    'all independent physical evidence remains available for human review');
  assert.equal(out.topology_audit.inventory_model, 'audit-model');
});

test('12zhaa. equal inventory counts with foreign bboxes are blocked by candidate-level reconciliation', () => {
  const session = 'scan-audit-inventory-foreign-geometry';
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), session);
  const inventoryRaw = mockedTopologyInventoryRaw();
  inventoryRaw.state_circle_candidates[0].bbox = unitBox(0.36, 0.05, 0.1, 0.12);
  inventoryRaw.state_circle_candidates[1].bbox = unitBox(0.54, 0.78, 0.1, 0.12);
  inventoryRaw.computational_arrowhead_candidates[0].bbox = unitBox(0.08, 0.08, 0.025, 0.025);
  const inventory = server.normalizeTopologyInventoryResult(inventoryRaw, session);
  assert.equal(inventory.review_only, false,
    'the blind inventory is internally well-formed even though it depicts foreign locations');
  const out = server.normalizeTopologyAuditStageResult(
    mockedTopologyRaw(1), initial, [mockedTopologyTile()], session,
    { inventory, inventory_model: 'audit-model' },
  );
  assert.equal(out.topology.visible_state_count, 2);
  assert.equal(out.topology.visible_connector_count, 1);
  assert.equal(out.topology.transitions.length, 1,
    'foreign inventory evidence never creates or replaces a connector');
  assert.equal(out.review_only, true);
  assert.match(out.issues.join(' | '), /state-circle candidate.*no spatial bbox-center\/IoU match/);
  assert.match(out.issues.join(' | '), /computational-arrowhead candidate.*no spatial bbox-center\/IoU match/);
  const reconciliation = out.topology_audit.inventory_reconciliation;
  assert.deepEqual(reconciliation.state_matches, []);
  assert.deepEqual(reconciliation.arrowhead_matches, []);
  assert.equal(reconciliation.unmatched_state_candidate_ids.length, 2);
  assert.equal(reconciliation.unmatched_transition_ids.length, 1);
  assert.equal(reconciliation.review_only, true);
});

test('12zhab. export 7 bounded state-constellation alignment matches common evidence and preserves the 9-versus-9 union mismatch', () => {
  const session = 'scan-export-7-affine-reconciliation';
  const topologyRaw = liveExport7TopologyRaw();
  const inventoryRaw = liveExport7InventoryRaw();
  const rawInventoryBefore = JSON.parse(JSON.stringify(inventoryRaw));
  const initial = server.normalizeTopologyStageResult(topologyRaw, session);
  const inventory = server.normalizeTopologyInventoryResult(inventoryRaw, session);
  const out = server.normalizeTopologyAuditStageResult(
    topologyRaw, initial, [mockedTopologyTile()], session,
    { inventory, inventory_model: 'audit-model' },
  );
  const reconciliation = out.topology_audit.inventory_reconciliation;
  assert.equal(reconciliation.alignment.applied, true);
  assert.equal(reconciliation.alignment.method,
    'bounded-axis-affine-from-state-constellation');
  assert.equal(reconciliation.alignment.consensus_count, 7);
  assert.ok(reconciliation.alignment.scale_x >= 0.75 &&
    reconciliation.alignment.scale_x <= 1.25);
  assert.ok(reconciliation.alignment.scale_y >= 0.75 &&
    reconciliation.alignment.scale_y <= 1.25);
  assert.ok(Math.abs(reconciliation.alignment.translate_x) <= 0.18);
  assert.ok(Math.abs(reconciliation.alignment.translate_y) <= 0.18);
  assert.ok(reconciliation.alignment.rms_center_residual < 0.02);
  assert.equal(reconciliation.state_matches.length, 7,
    'all seven common physical state circles match after one bounded global transform');
  assert.equal(reconciliation.arrowhead_matches.length, 8,
    'only the eight genuinely common computational arrowheads are paired');
  assert.deepEqual(reconciliation.unmatched_arrowhead_candidate_ids, ['ah9'],
    'the q5-loop candidate remains explicit evidence and does not create a connector');
  assert.deepEqual(reconciliation.unmatched_transition_ids, ['transition_2'],
    'the final q1-loop remains explicit unmatched topology evidence');
  assert.equal(out.topology.transitions.length, 9, 'no tenth connector was fabricated from the union');
  assert.equal(out.review_only, true);
  assert.match(out.issues.join(' | '), /arrowhead candidate "ah9".*no connector was invented/);
  assert.match(out.issues.join(' | '), /transition "transition_2".*no spatial.*match/);
  assert.deepEqual(out.topology_audit.geometric_inventory.state_circle_candidates[0].bbox,
    rawInventoryBefore.state_circle_candidates[0].bbox,
  'alignment evidence never rewrites the raw inventory bbox');
  const firstMatch = reconciliation.state_matches.find(match => match.candidate_id === 'sc1');
  assert.deepEqual(firstMatch.raw_candidate_bbox, rawInventoryBefore.state_circle_candidates[0].bbox);
  assert.notDeepEqual(firstMatch.aligned_candidate_bbox, firstMatch.raw_candidate_bbox);
  assert.equal(reconciliation.alignment.state_correspondences.length, 7);
});

test('12zhaba. export 7 unmatched ah9 is targeted only through the containing bottom-right tile', () => {
  const session = 'scan-export-7-targeted-plan';
  const topologyRaw = liveExport7TopologyRaw();
  const initial = server.normalizeTopologyStageResult(topologyRaw, session);
  const inventory = server.normalizeTopologyInventoryResult(liveExport7InventoryRaw(), session);
  const tiles = [
    mockedTopologyTile('tile_top_left', unitBox(0, 0, 0.6, 0.6)),
    mockedTopologyTile('tile_top_right', unitBox(0.4, 0, 0.6, 0.6)),
    mockedTopologyTile('tile_bottom_left', unitBox(0, 0.4, 0.6, 0.6)),
    mockedTopologyTile('tile_bottom_right', unitBox(0.4, 0.4, 0.6, 0.6)),
  ];
  const replacement = server.normalizeTopologyAuditStageResult(
    topologyRaw, initial, tiles, session, { inventory },
  );
  const plan = server.planTopologyTargetedTrace(
    replacement, ['data:image/png;base64,export7-original'], ['original_same_frame'],
    tiles, server.normalizeTopologyAuditManifest(tiles, []),
  );
  assert.deepEqual(plan.requested_candidate_ids, ['ah9']);
  assert.equal(plan.should_call, true);
  assert.deepEqual(plan.candidate_manifest[0].allowed_evidence_crop_ids, ['tile_bottom_right']);
  assert.equal(plan.request_urls.length, 2,
    'the real unmatched candidate gets only the original and its best containing tile');
  assert.equal(replacement.topology.transitions.length, 9,
    'planning alone still cannot invent the tenth connector');
});

test('12zhac. a random foreign seven-state constellation cannot earn a bounded alignment', () => {
  const session = 'scan-foreign-constellation-rejected';
  const topologyRaw = liveExport7TopologyRaw();
  const inventoryRaw = liveExport7InventoryRaw();
  inventoryRaw.state_circle_candidates.forEach((candidate, index) => {
    candidate.bbox = unitBox(0.05 + index * 0.11, 0.04 + index * 0.115, 0.035, 0.04);
  });
  inventoryRaw.computational_arrowhead_candidates.forEach((candidate, index) => {
    candidate.bbox = unitBox(0.03 + index * 0.09, 0.04 + (index % 2) * 0.04, 0.018, 0.02);
  });
  const initial = server.normalizeTopologyStageResult(topologyRaw, session);
  const inventory = server.normalizeTopologyInventoryResult(inventoryRaw, session);
  const out = server.normalizeTopologyAuditStageResult(
    topologyRaw, initial, [mockedTopologyTile()], session, { inventory },
  );
  const reconciliation = out.topology_audit.inventory_reconciliation;
  assert.equal(reconciliation.alignment.applied, false);
  assert.ok(reconciliation.alignment.issues.length > 0,
    'the rejected transform and its reason remain audit evidence');
  assert.ok(reconciliation.state_matches.length < 7);
  assert.ok(reconciliation.unmatched_state_candidate_ids.length > 0);
  assert.ok(reconciliation.unmatched_transition_ids.length > 0);
  assert.equal(out.topology.transitions.length, 9, 'foreign candidates still cannot create topology');
  assert.equal(out.review_only, true);
});

test('12zhb. a replacement-audit failure still persists the normalized independent inventory', () => {
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-audit-inventory-kept');
  const inventory = server.normalizeTopologyInventoryResult(
    mockedTopologyInventoryRaw(), 'scan-audit-inventory-kept');
  const out = server.normalizeTopologyAuditStageResult(
    null, initial, [mockedTopologyTile()], 'scan-audit-inventory-kept',
    { inventory, error: new Error('replacement verifier unavailable'), inventory_model: 'audit-model' },
  );
  assert.equal(out.topology_audit.failed, true);
  assert.equal(out.review_only, true);
  assert.equal(out.topology.transitions[0].target_observation_id, 'state_right');
  assert.deepEqual(out.topology_audit.geometric_inventory, inventory.inventory);
  assert.equal(out.topology_audit.inventory_failed, false);
});

test('12zhc. an inventory-call failure preserves Pass A and records the failed inventory stage', () => {
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-inventory-failed');
  const inventoryError = new Error('inventory verifier unavailable');
  const out = server.normalizeTopologyAuditStageResult(
    null, initial, [mockedTopologyTile()], 'scan-inventory-failed',
    { error: inventoryError, inventory_error: inventoryError },
  );
  assert.equal(out.topology_audit.failed, true);
  assert.equal(out.topology_audit.inventory_failed, true);
  assert.equal(out.topology_audit.geometric_inventory, null);
  assert.equal(out.topology.transitions.length, 1);
  assert.equal(out.review_only, true);
});

test('12zi. topology-audit failure returns the normalized initial topology for review instead of throwing', () => {
  const initial = server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-audit-failed');
  const out = server.normalizeTopologyAuditStageResult(
    null, initial, [], 'scan-audit-failed', { error: new Error('mocked verifier outage') },
  );
  assert.equal(out.stage, 'topology-audit');
  assert.equal(out.topology_audit.failed, true);
  assert.equal(out.topology_audit.changed, false);
  assert.equal(out.review_only, true);
  assert.equal(out.topology.transitions[0].target_observation_id, 'state_right');
  assert.match(out.issues.join(' | '), /audit failed.*initial extraction preserved.*mocked verifier outage/);
});

test('12zj. topology-audit HTTP stage falls back with status 200 when verifier pixels are unavailable', async t => {
  const app = server.server;
  if (!app.listening) {
    await new Promise((resolve, reject) => {
      app.once('error', reject);
      app.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => app.close(resolve)));
  }
  const address = app.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/parse-diagram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stage: 'topology-audit',
      scan_session_id: 'scan-audit-http-fallback',
      model_type: 'pda',
      topology: server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-audit-http-fallback'),
      images: [], crops: [],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stage, 'topology-audit');
  assert.equal(body.topology_audit.failed, true);
  assert.equal(body.review_only, true);
  assert.match(body.issues.join(' | '), /no full image or topology-tile pixels/);
  const tooMany = await fetch(`http://127.0.0.1:${address.port}/api/parse-diagram`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stage: 'topology-audit', scan_session_id: 'scan-audit-too-many', topology: initialTopologyForHttp(),
      crops: Array.from({ length: 13 }, (_, index) => mockedTopologyTile(`tile_${index}`)),
    }),
  });
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /at most 12/);
  const health = await fetch(`http://127.0.0.1:${address.port}/api/health`).then(result => result.json());
  assert.equal(health.topologyAuditStage, true);
  assert.equal(typeof health.topologyAuditModel, 'string');
  assert.equal(health.labelEscalationEnabled, false, 'expensive label escalation is opt-in');
  assert.equal(health.topologyEscalationEnabled, false, 'expensive topology escalation is opt-in');
  assert.equal(health.scanMaxEstimatedUsd, 0.10);
  assert.equal(health.scanMaxApiCalls, 16);
  assert.equal(health.labelTargetedRetryMaxBatches, 2);
  assert.equal(health.topologyLineGeometryEnabled, true);
});

function initialTopologyForHttp() {
  return server.normalizeTopologyStageResult(mockedTopologyRaw(1), 'scan-audit-too-many');
}

test('13. ⊥ is never normalized to Z0 — legacy spellings normalize onto ⊥', () => {
  assert.equal(server.BOTTOM, '⊥');
  assert.equal(server.normalizeSymbolValue('⊥'), '⊥');
  assert.equal(server.normalizeSymbolValue('Z0'), '⊥');
  assert.equal(server.normalizeSymbolValue('Z₀'), '⊥');
  assert.equal(server.normalizeSymbolValue('Z_0'), '⊥');
  assert.equal(server.normalizeSymbolValue('⟂'), '⊥');

  const out = server.normalizePayload(scanPayload([
    scanRule({
      raw_label_text: 'ε,⊥ / S דחוף',
      read_input: { value: 'ε', confidence: 0.9 },
      stack_action: { type: 'PUSH', confidence: 0.9 },
      push_value: { value: 'S', confidence: 0.9 },
      pop_value: { value: '⊥', confidence: 0.9 },
      pop_symbol: { value: 'ε', confidence: 0.9 },
    }),
  ]), '', true, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.pop_value.value, '⊥');
  assert.equal(JSON.stringify(out).includes('Z0'), false, 'שום Z0 לא נותר בפלט');
  assert.equal(rule.semantic_issues.length, 0, 'דחיפה מעל ⊥ תקינה לחלוטין');
});

test('13b. a scanned multi-rule arrow stays one transition with all its rules, in order', () => {
  const out = server.normalizePayload(scanPayload([
    scanRule({ raw_label_text: 'b,⊥ / S דחוף', stack_action: { type: 'PUSH', confidence: 0.9 }, read_input: { value: 'b', confidence: 0.9 }, pop_value: { value: '⊥', confidence: 0.9 }, push_value: { value: 'S', confidence: 0.9 }, pop_symbol: { value: 'ε', confidence: 0.9 } }),
    scanRule({ raw_label_text: 'b,S / A דחוף', stack_action: { type: 'PUSH', confidence: 0.9 }, read_input: { value: 'b', confidence: 0.9 }, pop_value: { value: 'S', confidence: 0.9 }, push_value: { value: 'A', confidence: 0.9 }, pop_symbol: { value: 'ε', confidence: 0.9 } }),
    scanRule({ raw_label_text: 'b,A / A דחוף', stack_action: { type: 'PUSH', confidence: 0.9 }, read_input: { value: 'b', confidence: 0.9 }, pop_value: { value: 'A', confidence: 0.9 }, push_value: { value: 'A', confidence: 0.9 }, pop_symbol: { value: 'ε', confidence: 0.9 } }),
  ]), '', true, false);
  assert.equal(out.transitions.length, 1, 'חץ אחד — לא שלושה');
  const rules = out.transitions[0].rules;
  assert.equal(rules.length, 3, 'שלושת הכללים נשמרו — בלי מיזוג ובלי השמטה');
  assert.deepEqual(rules.map(r => r.pop_value.value), ['⊥', 'S', 'A'], 'הסדר החזותי נשמר');
  assert.deepEqual(rules.map(r => r.semantic_issues.length), [0, 0, 0]);
});

/* ═════════ 14. DFA / NFA / TM ממשיכים לעבוד ═════════ */
test('14. DFA/NFA sheets keep their bare-symbol labels and get no stack semantics', () => {
  const out = server.normalizePayload({
    states: [{ id: 'q0', is_start: true, is_accepting: true }],
    transitions: [{
      transition_id: 't1',
      visible_rule_line_count: 1,
      source_state: { id: 'q0', confidence: 0.95 },
      target_state: { id: 'q0', confidence: 0.95 },
      rules: [{ raw_label_text: '0,1', read_input: { value: '0', confidence: 0.9 } }],
    }],
  }, '', false, false);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.read_input.value, '0');
  assert.equal(rule.stack_action.type, 'NONE');
  assert.equal(rule.pop_value.value, 'ε');
  assert.equal(rule.push_value.value, 'ε');
  assert.equal(rule.pop_symbol.value, 'ε');
  assert.deepEqual(rule.semantic_issues, []);
  assert.equal(rule.raw_label_text, '0,1', 'תווית DFA לא פוצלה לאזורי מחסנית');
});

test('14b. TM sheets keep read/write/direction labels and get no stack semantics', () => {
  const out = server.normalizePayload({
    states: [{ id: 'q0', is_start: true, is_accepting: false }],
    transitions: [{
      transition_id: 't1',
      visible_rule_line_count: 1,
      source_state: { id: 'q0', confidence: 0.95 },
      target_state: { id: 'q1', confidence: 0.95 },
      rules: [{ raw_label_text: 'a -> b, R', read_input: { value: 'a', confidence: 0.9 } }],
    }],
  }, '', false, true);
  const rule = out.transitions[0].rules[0];
  assert.equal(rule.read_input.value, 'a');
  assert.equal(rule.stack_action.type, 'NONE');
  assert.equal(rule.raw_label_text, 'a -> b, R');
  assert.deepEqual(rule.semantic_issues, []);
});

/* ═════════ שמירה, ייצוא וייבוא ═════════ */
test('a rule survives a JSON round-trip with its POP symbol and raw text intact', () => {
  const rule = pdaMakeRule('a', 'A', 'pop', '', 'B');
  rule.raw_label_text = 'a,A / B שלוף';
  const back = JSON.parse(JSON.stringify(rule));
  const P = pdaRuleParts(back);
  assert.equal(P.guard, 'A');
  assert.equal(P.popSym, 'B', 'סימן השליפה שרד את השמירה');
  assert.equal(back.raw_label_text, 'a,A / B שלוף', 'הקריאה הגולמית שרדה');
  assert.equal(pdaRuleBlocked(back), true, 'והוא עדיין מסומן כלא-תקין אחרי טעינה');
});

test('rules saved before the popSym field remain incomplete instead of being silently inferred', () => {
  // פורמט קודם: כלל POP בלי popSym — אין להסיק את השדה הימני מ-STACK_TOP
  const legacy = { read: 'a', top: 'A', op: 'pop', push: [] };
  const P = pdaRuleParts(legacy);
  assert.equal(P.popSym, '');
  assert.equal(pdaRuleBlocked(legacy), true);
  assert.equal(pdaApplyToStack(P, ['A', '⊥']), null);

  // כתיב תחתית ישן נקרא כ-⊥ (סובלנות קלט קיימת, בלי לוגיקת הגירה חדשה)
  const oldBottom = { read: '', top: 'Z₀', op: 'push', push: ['S'] };
  assert.equal(pdaRuleParts(oldBottom).guard, '⊥');
  assert.equal(pdaApplicableRules([arrow('t', 'q0', 'q1', [oldBottom])], 'q0', 0, ['⊥'], '').length, 1);
});

/* ═════════ שלמות הקבצים ═════════ */
test('the client loads the shared PDA core and no longer hard-codes Z₀', () => {
  const html = fs.readFileSync(path.join(__dirname, 'automata.html'), 'utf8');
  assert.match(html, /<script src="pda-core\.js"><\/script>/, 'ליבת ה-PDA נטענת');
  assert.equal(/const PDA_BOTTOM\s*=/.test(html), false, 'אין קבוע תחתית מקומי שמשכפל את הליבה');
  assert.equal(html.includes("_aiR('ε','Z₀'"), false, 'הדוגמה המובנית עברה ל-⊥');
  // מסלולי DFA/NFA/TM עדיין קיימים
  for (const fn of ['function nfaStep', 'function nfaClosure', 'function tmStep', 'function tmMoveCode']) {
    assert.ok(html.includes(fn), `${fn} נשמר`);
  }
  // התיקונים האוטומטיים השקטים הוסרו
  assert.equal(html.includes('repairAiLikelyFalseEpsilonPushReads'), false);
  assert.equal(html.includes('aiGuessCountingInput'), false);
  assert.equal(html.includes('id="pdaBotOp"'), false, 'אין כפתור שמציע לדחוף ⊥');
  assert.match(html, /id="pdaBotTop"/, '⊥ נשאר זמין כתנאי חוקי על ראש המחסנית');
});

test('the server no longer contains the silent repair passes', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(__dirname, 'automata.html'), 'utf8');
  for (const fn of ['repairInitialStackRules', 'repairStackingSelfLoopRules',
    'repairLikelyFalseEpsilonPushReads', 'rewriteRawStackTop', 'rewriteRawRead']) {
    assert.equal(src.includes(fn), false, `${fn} הוסר`);
  }
  assert.ok(src.includes("['/pda-core.js', 'pda-core.js']"), 'ליבת ה-PDA מוגשת ללקוח');
  assert.equal(src.includes('if a forward arrow ended up with two or more rules'), false, 'אין כלל שמעביר ריבוי שורות ללולאה');
  assert.equal(src.includes('the true arrow almost certainly lands'), false, 'אין הנחת backbone שמתקנת יעד');
  assert.equal(src.includes('choose the letter (with lower confidence)'), false, 'אלפבית אינו משמש לניחוש שקט');
  assert.equal(src.includes('transcribe the covered element as best you can'), false, 'מקרה קשקוש חופף נשאר בלתי מוכרע');
  assert.match(src, /A forward arrow with two or more rules is fully valid/);
  assert.match(src, /flat raw_label_text is audit evidence only/);
  assert.equal(src.includes('Unless an image role explicitly says otherwise'), false,
    'unspecified images are never assumed to be aligned');
  assert.match(src, /ONLY images explicitly marked enhanced_same_frame, ink_same_frame, or original_same_frame are aligned/);
  assert.match(src, /An incoming arrow from empty space is a START MARKER only/,
    'Stage A distinguishes the initial marker from computational transitions');
  assert.match(src, /EXCLUDE it from visible_connector_count, connector_observations, and transitions/,
    'the start marker is excluded from every computational connector view');
  assert.match(src, /regular parallel page-spanning blue ruling lines are paper background/,
    'blue notebook ruling is explicitly excluded from topology and scribble detection');
  assert.equal(clientSrc.includes('const isBlueRule='), false,
    'blue-cast pencil must not be erased by per-pixel notebook-rule classification');
  assert.match(src, /Black automaton ink remains real visible evidence when it crosses a blue ruling line/,
    'real ink crossing notebook ruling is retained');
  assert.match(src, /sweep the page as a 3-by-3 grid/,
    'Stage A performs an explicit whole-frame coverage pass before associating connectors');
  assert.match(src, /bbox must conservatively contain the ENTIRE outer circle stroke/,
    'state geometry cannot silently return a cropped inner-label box');
  assert.match(src, /overly tight box that clips ascenders, Hebrew action text, punctuation, or the first\/last glyph is invalid/,
    'label crops are requested with enough visual margin for handwriting');
  assert.match(src, /stage !== 'topology-audit'/,
    'the API exposes a distinct topology-audit stage instead of hiding a second model call inside Pass A');
  assert.equal(src.includes('if (!TOPOLOGY_AUDIT_MODEL) return initial'), false,
    'Pass A no longer conditionally performs an internal topology audit');
  assert.match(src, /TOPOLOGY AUDIT STAGE — GEOMETRY ONLY/,
    'the verifier is explicitly forbidden to OCR semantic labels');
  assert.match(src, /sweep the original frame as a 3-by-3 grid/,
    'the explicit audit independently sweeps the whole frame');
  assert.match(src, /entire 360-degree circumference of every state/,
    'the explicit audit checks self-loops around the full state boundary');
  assert.match(src, /special scrutiny to arrows and arrowheads in the bottom-left/,
    'the explicit audit rechecks the high-risk bottom-left directions');
  assert.match(src, /kind=label_block is the PRIMARY transition-local view/,
    'the complete local block establishes row count and horizontal extent');
  assert.match(src, /kind=line is a TARGET ZOOM/,
    'the baseline crop supplies detail without erasing a visible block row');
  assert.match(src, /INDEPENDENT GEOMETRIC INVENTORY — PIXELS ONLY/,
    'topology-audit starts with an independent physical inventory that has no initial topology');
  assert.match(src, /automaton_topology_geometric_inventory/,
    'the independent inventory uses its own strict model schema');
  assert.ok(src.indexOf("schemaName: 'automaton_topology_geometric_inventory'") <
    src.indexOf("schemaName: 'automaton_topology_audit_stage'"),
  'the inventory model call is issued before the full replacement audit');
  assert.ok(src.indexOf("schemaName: 'automaton_topology_audit_stage'") <
    src.indexOf("schemaName: 'automaton_topology_line_geometry_audit'"),
  'the independent line-geometry pass runs only after replacement topology exists');
  assert.match(src, /Never invent a state or connector merely to reconcile a count/,
    'inventory counts are evidence and never a connector-construction instruction');
  assert.match(src, /INDEPENDENT LINE-GEOMETRY AUDIT — PIXELS ONLY, NO OCR/,
    'the final baseline recount is isolated from OCR and automaton semantics');
  assert.match(src, /One handwritten transition-rule row is one baseline/,
    'line audit explicitly prevents words and punctuation from becoming extra rule rows');
});

test('handwritten scanning is Luna-only by default and keeps Terra explicitly opt-in', () => {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /const MODEL = process\.env\.OPENAI_MODEL \|\| 'gpt-5\.6-luna'/);
  assert.match(source, /const LABEL_MODEL = process\.env\.OPENAI_LABEL_MODEL \|\| 'gpt-5\.6-luna'/);
  assert.match(source, /const LABEL_ESCALATION_MODEL = String\(process\.env\.OPENAI_LABEL_ESCALATION_MODEL \|\| 'gpt-5\.6-terra'\)/);
  assert.match(source, /const TOPOLOGY_MODEL = process\.env\.OPENAI_TOPOLOGY_MODEL \|\| 'gpt-5\.6-luna'/);
  assert.match(source, /const TOPOLOGY_ESCALATION_MODEL = String\(process\.env\.OPENAI_TOPOLOGY_ESCALATION_MODEL \|\| 'gpt-5\.6-terra'\)/);
  assert.match(source, /boolEnv\('OPENAI_LABEL_ESCALATION_ENABLED', false\)/);
  assert.match(source, /boolEnv\('OPENAI_TOPOLOGY_ESCALATION_ENABLED', false\)/);
  assert.match(source, /numberEnv\('OPENAI_SCAN_MAX_ESTIMATED_USD', 0\.10/);
  assert.match(source, /intEnv\('OPENAI_SCAN_MAX_API_CALLS', 16/);
  assert.match(source, /labelBatchEscalationReasons\(primary, batch, mode\)/,
    'the strong model is gated by explicit batch-quality evidence');
  assert.match(source, /topologyAuditEscalationReasons\(selectedReplacement, initialTopology\)/,
    'Terra topology verification is gated by deterministic structural evidence');
  assert.match(source, /intEnv\('OPENAI_TIMEOUT_MS', 240_000/,
    'the full labels pass is not discarded by the former 90-second default');
  assert.match(source, /const callLabelBatch = \(batch, model, attempt, previousAttempt = null\) =>/,
    'the same local crop contract is used for primary and escalation reads');
  assert.match(source, /recordScanRuntime\('stage-failed'/,
    'future stage failures are persisted without logging image data');
});

test('label escalation accepts a complete high-confidence PDA read and flags an uncertain one', () => {
  const batch = { batch_id: 'transitions-1', rows: [
    { kind: 'line', crop_id: 'crop-1', transition_id: 't1', line_id: 'line-1' },
  ] };
  const good = {
    issues: [], state_label_reads: [], label_reads: [{
      crop_id: 'crop-1', transition_id: 't1', line_id: 'line-1', raw_label_text: 'b,S / דחוף A',
      zones: { left_text: 'b', middle_text: 'S', right_text: 'דחוף A' },
      read_input: { value: 'b', confidence: 0.96 }, pop_value: { value: 'S', confidence: 0.96 },
      stack_action: { type: 'PUSH', confidence: 0.95 }, push_value: { value: 'A', confidence: 0.95 },
      pop_symbol: { value: 'ε', confidence: 0.95 }, confidence: 0.95, issues: [],
    }],
  };
  assert.deepEqual(server.labelBatchEscalationReasons(good, batch, 'pda', 0.78), []);
  const uncertain = structuredClone(good);
  uncertain.label_reads[0].read_input = { value: '?', confidence: 0.42 };
  const reasons = server.labelBatchEscalationReasons(uncertain, batch, 'pda', 0.78);
  assert.ok(reasons.includes('INPUT is missing or unreadable'));
  assert.ok(reasons.includes('one or more OCR confidences are below the escalation threshold'));
});

test('label escalation selects Luna or Terra independently for each immutable physical row', () => {
  const batch = { batch_id: 'transitions-mixed', rows: [
    { kind: 'line', crop_id: 'crop-1', transition_id: 't1', line_id: 'line-1' },
    { kind: 'line', crop_id: 'crop-2', transition_id: 't1', line_id: 'line-2' },
  ] };
  const read = (crop, line, input, confidence) => ({
    crop_id: crop, transition_id: 't1', line_id: line,
    raw_label_text: `${input},S / דחוף A`,
    zones: { left_text: input, middle_text: 'S', right_text: 'דחוף A' },
    read_input: { value: input, confidence }, pop_value: { value: 'S', confidence },
    stack_action: { type: 'PUSH', confidence }, push_value: { value: 'A', confidence },
    pop_symbol: { value: 'ε', confidence }, confidence, issues: [],
  });
  const primary = { issues: [], state_label_reads: [], label_reads: [
    read('crop-1', 'line-1', 'b', 0.96), read('crop-2', 'line-2', '?', 0.32),
  ] };
  const escalation = { issues: [], state_label_reads: [], label_reads: [
    read('crop-1', 'line-1', '?', 0.40), read('crop-2', 'line-2', 'c', 0.94),
  ] };
  const merged = server.mergeLabelBatchCandidates(primary, escalation, batch, 'pda');
  assert.deepEqual(merged.parsed.label_reads.map(row => row.read_input.value), ['b', 'c']);
  assert.deepEqual(new Set(merged.selectedModels), new Set(['gpt-5.6-luna', 'gpt-5.6-terra']));
});

test('conflicting OCR attempts retain both readings instead of declaring the more confident guess correct', () => {
  const crop=mockedCrop('crop_1','line_1'),batch={batch_id:'conflict',rows:[crop]};
  const first=mockedLabelRead('crop_1','line_1','A','B');
  first.read_input.value='a';first.zones.left_text='a';
  const second=structuredClone(first);
  second.read_input={value:'ε',confidence:.99};second.zones.left_text='ε';
  const wrap=row=>({label_reads:[row],state_label_reads:[],issues:[]});
  const merged=server.mergeLabelBatchCandidates(wrap(first),wrap(second),batch,'pda').parsed;
  const row=merged.label_reads[0];
  assert.match(row.issues.join(' '),/alternatives disagree on INPUT/);
  assert.equal(row.scan_incomplete,true);
  assert.equal(row.ocr_alternatives.primary.read_input.value,'a');
  assert.equal(row.ocr_alternatives.retry.read_input.value,'ε');
  assert.equal(first.issues.length,0,'inputs stay immutable');
  const normalized=server.normalizeLabelsStageResult(merged,
    server.normalizeTopologyStageResult(mockedTopologyRaw(1),'conflict'),[crop],'pda','conflict').label_reads[0];
  assert.deepEqual(normalized.ocr_alternatives,row.ocr_alternatives);
  assert.equal(normalized.scan_incomplete,true);
  const pop=structuredClone(first);
  pop.stack_action.type='POP';pop.pop_symbol.value='A';pop.push_value.value='ε';pop.zones.right_text='שלוף A';
  const action=server.mergeLabelBatchCandidates(wrap(first),wrap(pop),batch,'pda').parsed.label_reads[0];
  assert.match(action.issues.join(' '),/alternatives disagree on ACTION/);
  const unknown=structuredClone(first);unknown.read_input.value='?';
  const resolved=server.mergeLabelBatchCandidates(wrap(unknown),wrap(first),batch,'pda').parsed.label_reads[0];
  assert.equal(resolved.ocr_alternatives,undefined,'unknown-to-readable is not a contradictory reading');
});

test('OCR retry merge cannot hide duplicate or foreign physical observations', () => {
  const crop=mockedCrop('crop_1','line_1'),batch={batch_id:'duplicate',rows:[crop]};
  const first=mockedLabelRead('crop_1','line_1','A','B');
  const wrap=rows=>({label_reads:rows,state_label_reads:[],issues:[]});
  for (const duplicateInPrimary of [true,false]) {
    const other=structuredClone(first);other.read_input.value='ε';
    const primary=wrap(duplicateInPrimary?[first,other]:[first]);
    const retry=wrap(duplicateInPrimary?[first]:[first,other]);
    const before=JSON.stringify([primary,retry]);
    const merged=server.mergeLabelBatchCandidates(primary,retry,batch,'pda').parsed;
    assert.match(merged.issues.join(' '),/duplicate label_reads identity/);
    assert.equal(merged.review_only,true);
    assert.equal(merged.label_reads.length,primary.label_reads.length);
    assert.equal(merged.label_reads[0].scan_incomplete,true);
    assert.deepEqual(merged.label_reads[0].ocr_alternatives.retry,retry);
    assert.equal(JSON.stringify([primary,retry]),before);
  }
  const foreign={...structuredClone(first),line_id:'other_line'};
  const merged=server.mergeLabelBatchCandidates(wrap([first]),wrap([first,foreign]),batch,'pda').parsed;
  assert.match(merged.issues.join(' '),/foreign label_reads identity/);
  assert.equal(merged.label_reads[0].ocr_alternatives.retry.label_reads.length,2);
});

test('OpenAI scan cost telemetry accounts for cached input separately', () => {
  const cost = server.estimateOpenAICost('gpt-5.4-mini', {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 200 },
    output_tokens: 100,
    total_tokens: 1100,
  });
  assert.equal(cost.estimated_cost_usd, 0.001065);
  assert.equal(cost.cached_input_tokens, 200);
  const luna = server.estimateOpenAICost('gpt-5.6-luna', {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
    output_tokens: 100,
    total_tokens: 1100,
  });
  assert.equal(luna.estimated_cost_usd, 0.000289);
  assert.equal(luna.cache_write_tokens, 100);
  assert.equal(server.estimateOpenAICost('unknown-model', { input_tokens: 10 }).estimated_cost_usd, null);
});

test('scan-wide cost guard blocks Terra and cumulative Luna calls before the default cap', () => {
  assert.deepEqual(server.scanBudgetDecision({ calls: 0, estimatedCostUsd: 0 }, 'gpt-5.6-terra'), {
    allowed: false, reason: 'cost_limit', calls: 0, estimatedCostUsd: 0,
    reserveUsd: 0.12, maxCost: 0.10, maxCalls: 16,
  });
  assert.equal(server.scanBudgetDecision({ calls: 4, estimatedCostUsd: 0.079 }, 'gpt-5.6-luna').allowed, true);
  assert.equal(server.scanBudgetDecision({ calls: 5, estimatedCostUsd: 0.081 }, 'gpt-5.6-luna').reason, 'cost_limit');
  assert.equal(server.scanBudgetDecision({ calls: 16, estimatedCostUsd: 0.01 }, 'gpt-5.6-luna').reason, 'call_limit');
});

test('handwritten q0-q6 benchmark is pinned to 7 states, 10 connectors, and 14 physical rules', () => {
  const truth = JSON.parse(fs.readFileSync(path.join(__dirname,
    'test-fixtures', 'handwriting', 'pda-q0-q6-ground-truth.json'), 'utf8'));
  assert.equal(truth.states.length, 7);
  assert.equal(truth.transitions.length, 10);
  assert.equal(truth.transitions.reduce((sum, transition) => sum + transition.rules.length, 0), 14);
  assert.equal(truth.expected.start_state, 'q0');
  assert.deepEqual(truth.expected.accepting_states, ['q6']);
  assert.deepEqual(truth.expected.self_loops, ['q1', 'q5']);
  assert.equal(truth.transitions.some(transition => transition.from === 'q2' && transition.to === 'q3' &&
    transition.rules.length === 3), true);
});
