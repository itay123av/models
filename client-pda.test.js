/* בדיקות על קוד הלקוח האמיתי מתוך automata.html.
   הסקריפט של הדף נטען לתוך VM עם DOM מינימלי, בלי הרצת init(), וכך אפשר
   לבדוק את מנוע הסימולציה והתצוגה עצמם — לא רק את הליבה המשותפת. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadClient() {
  const html = fs.readFileSync(path.join(__dirname, 'automata.html'), 'utf8');
  let js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  // init() נוגע ב-DOM אמיתי; כאן בודקים רק את הלוגיקה.
  js = js.replace(/\r?\ninit\(\);\s*$/, '\n');
  assert.equal(/\binit\(\);\s*$/.test(js.trim()), false, 'init() הוסר מהרצת הבדיקה');

  const noop = () => {};
  const fakeEl = new Proxy({}, {
    get(_, k) {
      if (k === 'style' || k === 'dataset' || k === 'classList') return new Proxy({}, { get: () => noop });
      if (k === 'querySelectorAll' || k === 'getElementsByTagName') return () => [];
      if (k === 'querySelector' || k === 'closest' || k === 'appendChild' || k === 'insertBefore') return () => fakeEl;
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
      return noop;
    },
    set: () => true,
  });
  const sandbox = {
    console,
    document: {
      getElementById: () => fakeEl,
      querySelector: () => fakeEl,
      querySelectorAll: () => [],
      createElement: () => fakeEl,
      createElementNS: () => fakeEl,
      addEventListener: noop,
      body: fakeEl,
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    requestAnimationFrame: noop,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('no network in this harness')),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    location: { href: '' },
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'pda-core.js'), 'utf8'), ctx, { filename: 'pda-core.js' });
  vm.runInContext(js, ctx, { filename: 'automata-inline.js' });
  // `current` הוא binding לקסיקלי בתוך הסקריפט — מגיעים אליו דרך setter.
  vm.runInContext('globalThis.__setCurrent = v => { current = v; }; globalThis.__getCurrent = () => current;', ctx);
  return ctx;
}

test('OCR frame preserves coloured pencil pixels exactly, including blue-cast handwriting', async () => {
  const ctx = loadClient();
  // These colours satisfy the old blue-rule predicate despite being plausible
  // dark pencil under cool lighting. White/black and warm paper are controls.
  const pixels = new Uint8ClampedArray([145,159,176,255, 120,137,155,255,
    60,75,89,255, 255,255,255,255, 210,195,180,255, 0,0,0,255]);
  ctx.FileReader = class { readAsDataURL() { this.result='input'; this.onload(); } };
  ctx.Image = class { constructor(){this.width=3;this.height=2;} set src(v){this.onload();} };
  ctx.document.createElement = () => {
    let raster = new Uint8ClampedArray(pixels);
    return { getContext:()=>({fillRect(){},drawImage(){},
      getImageData:()=>({data:new Uint8ClampedArray(raster)}),
      putImageData: image=>{raster=new Uint8ClampedArray(image.data);}}),
      toDataURL:type=>JSON.stringify({type,pixels:[...raster]}) };
  };
  const result=await ctx.downscaleImage({},2400,.92,{disableDocumentCrop:true});
  assert.deepEqual(JSON.parse(result.label),{type:'image/png',pixels:[...pixels]});
  assert.notDeepEqual(JSON.parse(result.images[0]).pixels,[...pixels],
    'the test exercises the optional enhancement code as well as the raw OCR path');
});

function pdaModel(ctx, transitions, states) {
  const model = {
    type: 'pda', ndet: false,
    states: states || [
      { id: 'q2', label: 'q2', isStart: true, isAccept: false },
      { id: 'q3', label: 'q3', isStart: false, isAccept: true },
    ],
    transitions,
  };
  ctx.__setCurrent(model);
  return model;
}

/* החץ q2→q3 מהשרטוט: חץ פיזי אחד עם שלושה כללים עצמאיים. */
function q2q3(ctx) {
  return [{
    id: 't23', from: 'q2', to: 'q3',
    rules: [
      ctx.makeRulePDA('b', '⊥', 'push', 'S'),
      ctx.makeRulePDA('b', 'S', 'push', 'A'),
      ctx.makeRulePDA('b', 'A', 'push', 'A'),
    ],
  }];
}

function scannedRule(over = {}) {
  return Object.assign({
    raw_label_text: 'a,A / B דחוף',
    zones: { left_text: 'a', middle_text: 'A', right_text: 'B דחוף' },
    line_bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.08 },
    read_input: { value: 'a', confidence: 0.9 },
    pop_value: { value: 'A', confidence: 0.9 },
    stack_action: { type: 'PUSH', confidence: 0.9 },
    push_value: { value: 'B', confidence: 0.9 },
    pop_symbol: { value: 'ε', confidence: 0.9 },
  }, over);
}

function scannedTransition(id, from, to, rules, over = {}) {
  return Object.assign({
    transition_id: id,
    visible_rule_line_count: rules.length,
    source_state: { id: from, confidence: 0.9 },
    target_state: { id: to, confidence: 0.9 },
    rules,
  }, over);
}

function silenceClientUi(ctx) {
  vm.runInContext('renderAll=()=>{}; renderGraph=()=>{}; renderInspector=()=>{}; save=()=>{}; toast=()=>{};', ctx);
}

test('local persistence removes embedded scan images without discarding textual evidence', () => {
  const ctx = loadClient();
  const compact = ctx.compactForLocalStorage({
    scanSessionId: 'scan-1',
    crops: [{ crop_id: 'line-1', image_url: 'data:image/jpeg;base64,AAAA', raw_label_text: 'b,⊥/דחוף S' }],
    ordinaryUrl: 'https://example.test/evidence.png',
  });
  assert.equal(compact.scanSessionId, 'scan-1');
  assert.equal(compact.crops[0].image_url, '');
  assert.equal(compact.crops[0].raw_label_text, 'b,⊥/דחוף S');
  assert.equal(compact.ordinaryUrl, 'https://example.test/evidence.png');
});

function topologyState(observationId, label, over = {}) {
  return Object.assign({ observation_id: observationId, visible_label: label, id: label, bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    is_start: false, is_start_confidence: 0.95, is_accepting: false, is_accepting_confidence: 0.95, confidence: 0.95, issues: [] }, over);
}

function topologyConnector(transitionId, connectorObservationId, sourceObservationId, targetObservationId, lineIds, over = {}) {
  const lines = lineIds.map((lineId, index) => ({ line_id: lineId, bbox: { x: 0.32, y: 0.2 + index * 0.08, w: 0.25, h: 0.055 } }));
  return Object.assign({
    transition_id: transitionId,
    connector_observation_id: connectorObservationId,
    source_observation_id: sourceObservationId,
    target_observation_id: targetObservationId,
    connector_bbox: { x: 0.2, y: 0.25, w: 0.5, h: 0.05 },
    arrowhead_bbox: { x: 0.67, y: 0.23, w: 0.04, h: 0.04 },
    label_block_bbox: { x: 0.3, y: 0.16, w: 0.3, h: Math.max(0.08, lines.length * 0.08) },
    visible_line_count: lineIds.length,
    line_hints: lines,
    confidence: 0.95,
    issues: [],
  }, over);
}

function topologyPass(sessionId, states, connectors, over = {}) {
  const observations = connectors.map(c => ({ connector_observation_id: c.connector_observation_id, bbox: c.connector_bbox, confidence: c.confidence }));
  return Object.assign({
    stage: 'topology', scan_session_id: sessionId,
    topology: { visible_state_count: states.length, states, visible_connector_count: connectors.length, connector_observations: observations, connectors },
  }, over);
}

function topologyAuditPass(sessionId, topology, over = {}) {
  return Object.assign({
    stage: 'topology-audit', scan_session_id: sessionId, topology: JSON.parse(JSON.stringify(topology)),
    review_only: false, issues: [], topology_audit: { changed: false, failed: false },
  }, over);
}

function materializedCropManifest(ctx, passA, sessionId) {
  return Array.from(ctx.buildTwoStageCropSpecs(passA, sessionId).specs, spec => Object.assign({}, spec, {
    image_url: `data:image/jpeg;base64,${Buffer.from(spec.crop_id).toString('base64')}`,
    crop_bbox: spec.source_bbox,
    original_size: { width: 1200, height: 800 },
    issues: Array.from(new Set([...(spec.bbox_audit && spec.bbox_audit.issues || []), ...(spec.crop_geometry_issues || [])])),
  }));
}

function topologyLabelRead(crop, over = {}) {
  return Object.assign({
    scan_session_id: '', crop_id: crop.crop_id, transition_id: crop.transition_id, line_id: crop.line_id,
    raw_label_text: 'a,A / B דחוף', zones: { left_text: 'a', middle_text: 'A', right_text: 'B דחוף' },
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    read_input: { value: 'a', confidence: 0.9 }, pop_value: { value: 'A', confidence: 0.9 },
    stack_action: { type: 'PUSH', confidence: 0.9 }, push_value: { value: 'B', confidence: 0.9 },
    pop_symbol: { value: 'ε', confidence: 0.9 }, issues: [], scan_incomplete: false,
  }, over);
}

function topologyStateLabelRead(crop, visibleLabel, over = {}) {
  return Object.assign({ scan_session_id: '', crop_id: crop.crop_id, observation_id: crop.observation_id, visible_label: visibleLabel, confidence: 0.9, issues: [], scan_incomplete: false }, over);
}

function labelsPass(sessionId, topology, crops, mapper = crop => topologyLabelRead(crop, { scan_session_id: sessionId })) {
  return {
    stage: 'labels', scan_session_id: sessionId, topology,
    crop_manifest: crops.map(c => Object.assign({}, c)),
    label_reads: crops.filter(c => c.kind === 'line').map(mapper), review_only: false,
    state_label_reads: crops.filter(c => c.kind === 'state_label').map(crop => {
      const state = (topology.states || []).find(s => s.observation_id === crop.observation_id);
      return topologyStateLabelRead(crop, state && (state.visible_label || state.id) || '', { scan_session_id: sessionId });
    }),
  };
}

test('the client script loads without a DOM and exposes the shared PDA core', () => {
  const ctx = loadClient();
  assert.equal(ctx.PDA_BOTTOM, '⊥');
  assert.equal(typeof ctx.pdaApplicableRules, 'function');
  assert.equal(typeof ctx.makeRulePDA, 'function');
  assert.equal(typeof ctx.pdaStep, 'function');
});

test('the transition editor defers missing-action warnings until submit but shows typed invalid values immediately', () => {
  const ctx = loadClient();
  const emptyPush = ctx.makeRulePDA('a', 'A', 'push', '');
  assert.equal(Array.from(ctx.pdaEditorIssues(emptyPush, false)).some(x => x.code === ctx.PDA_ISSUE.PUSH_SYMBOL_MISSING), false,
    'בפתיחת המסך לא מוצגת התראת שדה חובה');
  assert.equal(Array.from(ctx.pdaEditorIssues(emptyPush, true)).some(x => x.code === ctx.PDA_ISSUE.PUSH_SYMBOL_MISSING), true,
    'אחרי ניסיון שמירה ההתראה מוצגת');

  const forbiddenBottom = ctx.makeRulePDA('a', 'A', 'push', '⊥');
  assert.equal(Array.from(ctx.pdaEditorIssues(forbiddenBottom, false)).some(x => x.code === ctx.PDA_ISSUE.PUSH_BOTTOM), true,
    'ערך אסור שכבר הוקלד מוצג מיד');
});

test('the client simulator starts the stack at ⊥ and pushes on top of it', () => {
  const ctx = loadClient();
  pdaModel(ctx, q2q3(ctx));
  const sim = ctx.simInit('b');
  assert.deepEqual(Array.from(sim.stack), ['⊥'], 'המחסנית מתחילה עם ⊥');
  ctx.simStepObj(sim);
  assert.deepEqual(Array.from(sim.stack), ['S', '⊥'], 'S נדחף מעל ⊥ ו-⊥ נשאר');
  assert.equal(sim.state, 'q3');
  assert.equal(sim.pos, 1, 'הקלט נצרך');
});

test('in the q2→q3 example the client finds at most one matching rule per configuration', () => {
  const ctx = loadClient();
  pdaModel(ctx, q2q3(ctx));
  assert.equal(ctx.pdaApplicable('q2', 0, ['⊥'], 'b').length, 1);
  assert.equal(ctx.pdaApplicable('q2', 0, ['S', '⊥'], 'b').length, 1);
  assert.equal(ctx.pdaApplicable('q2', 0, ['A', 'S', '⊥'], 'b').length, 1);
  // אף כלל אינו מתאים — לא שגיאה, פשוט חץ שאינו שמיש
  assert.equal(ctx.pdaApplicable('q2', 0, ['Q', '⊥'], 'b').length, 0);
  assert.equal(ctx.pdaApplicable('q2', 0, ['⊥'], 'a').length, 0);
});

test('the client refuses a POP whose symbol differs from the stack top', () => {
  const ctx = loadClient();
  const rule = ctx.makeRulePDA('a', 'A', 'pop', '', 'B');
  pdaModel(ctx, [{ id: 'tp', from: 'q2', to: 'q3', rules: [rule] }]);
  assert.equal(ctx.pdaRuleBlocked(rule), true);
  assert.equal(ctx.pdaApplicable('q2', 0, ['A', '⊥'], 'a').length, 0, 'הכלל אינו מבוצע');
  // אך הוא נשמר במלואו ומוצג עם אזהרה
  assert.equal(ctx.pdaRuleParts(rule).guard, 'A');
  assert.equal(ctx.pdaRuleParts(rule).popSym, 'B');
  assert.match(ctx.transLabelLines(ctx.__getCurrent().transitions[0])[0], /⚠/);
});

test('the client refuses to pop ⊥ even when such a rule was imported', () => {
  const ctx = loadClient();
  const rule = ctx.makeRulePDA('a', '⊥', 'pop', '', '⊥');
  pdaModel(ctx, [{ id: 'tb', from: 'q2', to: 'q3', rules: [rule] }]);
  assert.equal(ctx.pdaApplicable('q2', 0, ['⊥'], 'a').length, 0);
  const sim = ctx.simInit('a');
  ctx.simStepObj(sim);
  assert.equal(sim.status, 'rejected');
  assert.deepEqual(Array.from(sim.stack), ['⊥'], 'המחסנית לא התרוקנה');
});

test('the client refuses to push a second ⊥ even when such a rule was imported', () => {
  const ctx = loadClient();
  const rule = ctx.makeRulePDA('a', 'A', 'push', '⊥');
  pdaModel(ctx, [{ id: 'tb-push', from: 'q2', to: 'q3', rules: [rule] }]);
  assert.equal(ctx.pdaRuleBlocked(rule), true);
  assert.equal(ctx.pdaRuleSemanticIssues(rule).some(x => x.code === ctx.PDA_ISSUE.PUSH_BOTTOM), true);
  assert.equal(ctx.pdaApplicable('q2', 0, ['A', '⊥'], 'a').length, 0);
  assert.equal(ctx.pdaApplyToStack(ctx.pdaRuleParts(rule), ['A', '⊥']), null);
});

test('the client accepts only when the stack is back to exactly [⊥]', () => {
  const ctx = loadClient();
  // q0 -(a,⊥/דחוף A)-> q1 -(b,A/שלוף A)-> q2(accept)
  pdaModel(ctx, [
    { id: 't1', from: 'q0', to: 'q1', rules: [ctx.makeRulePDA('a', '⊥', 'push', 'A')] },
    { id: 't2', from: 'q1', to: 'q2', rules: [ctx.makeRulePDA('b', 'A', 'pop', '', 'A')] },
  ], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: false },
    { id: 'q2', label: 'q2', isStart: false, isAccept: true },
  ]);
  assert.equal(ctx.pdaAccepts('ab'), true, 'המחסנית חזרה ל-[⊥] במצב מקבל');
  assert.equal(ctx.pdaAccepts('a'), false, 'נשאר A מעל ⊥ — לא מתקבל');
  assert.equal(ctx.pdaAccepts('abb'), false);
});

test('the client imports a scanned multi-rule arrow as one arrow with all rules', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 'q2', label: 'q2', isStart: true, isAccept: false },
    { id: 'q3', label: 'q3', isStart: false, isAccept: true },
  ]);
  const mkRule = (read, top, action, push, popSym, raw) => ({
    raw_label_text: raw,
    zones: { left_text: read, middle_text: top, right_text: action === 'PUSH' ? `${push} דחוף` : (action === 'POP' ? `${popSym} שלוף` : 'ללא שינוי') },
    line_bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.08 },
    read_input: { value: read, confidence: 0.9 },
    stack_action: { type: action, confidence: 0.9 },
    push_value: { value: push, confidence: 0.9 },
    pop_value: { value: top, confidence: 0.9 },
    pop_symbol: { value: popSym, confidence: 0.9 },
  });
  const id = ctx.addAiTransition({
    transition_id: 't23',
    visible_rule_line_count: 3,
    source_state: { id: 'q2', confidence: 0.95 },
    target_state: { id: 'q3', confidence: 0.95 },
    rules: [
      mkRule('b', '⊥', 'PUSH', 'S', 'ε', 'b,⊥ / S דחוף'),
      mkRule('b', 'S', 'PUSH', 'A', 'ε', 'b,S / A דחוף'),
      mkRule('b', 'A', 'PUSH', 'A', 'ε', 'b,A / A דחוף'),
    ],
  });
  assert.ok(id);
  assert.equal(ctx.__getCurrent().transitions.length, 1, 'חץ אחד — לא שלושה');
  const rules = ctx.__getCurrent().transitions[0].rules;
  assert.equal(rules.length, 3, 'כל שלושת הכללים נשמרו');
  assert.deepEqual(Array.from(rules).map(r => ctx.pdaRuleParts(r).guard), ['⊥', 'S', 'A'], 'הסדר החזותי נשמר');
  assert.deepEqual(Array.from(rules).map(r => r.raw_label_text), ['b,⊥ / S דחוף', 'b,S / A דחוף', 'b,A / A דחוף']);
  // ריבוי כללים על חץ רגיל אינו מסומן כבעיה
  assert.equal(ctx.__getCurrent().transitions[0].aiLow, false);
  assert.deepEqual(Array.from(ctx.__getCurrent().transitions[0].aiIssues), []);
});

test('the client keeps a contradictory scanned POP as read and blocks it', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: true },
  ]);
  ctx.addAiTransition({
    transition_id: 't1',
    visible_rule_line_count: 1,
    source_state: { id: 'q0', confidence: 0.95 },
    target_state: { id: 'q1', confidence: 0.95 },
    rules: [{
      raw_label_text: 'a,A / B שלוף',
      zones: { left_text: 'a', middle_text: 'A', right_text: 'B שלוף' },
      line_bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.08 },
      read_input: { value: 'a', confidence: 0.9 },
      stack_action: { type: 'POP', confidence: 0.9 },
      push_value: { value: 'ε', confidence: 0.9 },
      pop_value: { value: 'A', confidence: 0.9 },
      pop_symbol: { value: 'B', confidence: 0.9 },
    }],
  });
  const rule = ctx.__getCurrent().transitions[0].rules[0];
  const parts = ctx.pdaRuleParts(rule);
  assert.equal(parts.guard, 'A', 'STACK_TOP כפי שנקרא');
  assert.equal(parts.popSym, 'B', 'סימן השליפה כפי שנקרא');
  assert.equal(rule.raw_label_text, 'a,A / B שלוף', 'הטקסט הגולמי נשמר');
  assert.equal(ctx.pdaRuleBlocked(rule), true, 'הכלל אינו מבוצע');
  assert.equal(ctx.__getCurrent().transitions[0].aiLow, false, 'בעיה סמנטית אינה מתחזה לביטחון חזותי נמוך');
  assert.equal(ctx.__getCurrent().transitions[0].semanticBlocked, true, 'הבעיה הסמנטית נשמרת בציר נפרד');
  const issues = ctx.pdaRuleSemanticIssues(rule);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, ctx.PDA_ISSUE.POP_SYMBOL_MISMATCH);
});

test('the client never lets flat OCR override the structured spatial ACTION', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: true },
  ]);
  ctx.addAiTransition({
    transition_id: 'action-priority',
    source_state: { id: 'q0', confidence: 0.95 }, target_state: { id: 'q1', confidence: 0.95 },
    rules: [{
      raw_label_text: 'a,A / A שלוף', zones: { left_text: 'a', middle_text: 'A', right_text: 'B דחוף' },
      line_bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 },
      read_input: { value: 'a', confidence: 0.9 }, pop_value: { value: 'A', confidence: 0.9 },
      stack_action: { type: 'PUSH', confidence: 0.9 }, push_value: { value: 'B', confidence: 0.9 },
      pop_symbol: { value: 'ε', confidence: 0.9 },
    }],
  });
  const rule=ctx.__getCurrent().transitions[0].rules[0], P=ctx.pdaRuleParts(rule);
  assert.equal(P.removeTop,false);
  assert.deepEqual(Array.from(P.push),['B']);
  assert.match(rule.aiIssues.join(' | '),/לא דרס/);
});

test('two identical scanned physical lines are both preserved with their evidence', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: true },
  ]);
  const base={
    raw_label_text:'b,A / B דחוף', zones:{left_text:'b',middle_text:'A',right_text:'B דחוף'},
    read_input:{value:'b',confidence:0.88},pop_value:{value:'A',confidence:0.81},
    stack_action:{type:'PUSH',confidence:0.93},push_value:{value:'B',confidence:0.79},pop_symbol:{value:'ε',confidence:0.95}
  };
  ctx.addAiTransition({
    transition_id:'duplicate-lines',cropped_image_segment_url:'data:image/png;base64,AA==',
    source_state:{id:'q0',confidence:0.95},target_state:{id:'q1',confidence:0.95},
    rules:[
      Object.assign({},base,{line_bbox:{x:0.1,y:0.2,w:0.3,h:0.08},field_notes:['line one']}),
      Object.assign({},base,{line_bbox:{x:0.1,y:0.3,w:0.3,h:0.08},field_notes:['line two']}),
    ],
  });
  const rules=ctx.__getCurrent().transitions[0].rules;
  assert.equal(rules.length,2,'שתי שורות זהות אינן מתמזגות');
  assert.notEqual(rules[0].aiLineId,rules[1].aiLineId);
  assert.equal(rules[0].scanEvidence.line_bbox.y,0.2);
  assert.equal(rules[1].scanEvidence.line_bbox.y,0.3);
  assert.equal(rules[0].scanEvidence.cropped_image_segment_url,'data:image/png;base64,AA==');
  assert.equal(rules[1].scanEvidence.field_notes[0],'line two');
  const saved=JSON.parse(JSON.stringify(ctx.__getCurrent()));
  assert.equal(saved.transitions[0].rules[1].scanEvidence.zones.right_text,'B דחוף','הראיות שרדו JSON round-trip');
  assert.equal(saved.transitions[0].rules[0].scanEvidence.confidence.push_symbol,0.79);
});

test('a scanned POP with no right-zone symbol is not inferred from STACK_TOP', () => {
  const ctx=loadClient();
  pdaModel(ctx,[],[
    {id:'q0',label:'q0',isStart:true,isAccept:false},{id:'q1',label:'q1',isStart:false,isAccept:true}
  ]);
  ctx.addAiTransition({transition_id:'missing-pop',source_state:{id:'q0',confidence:0.9},target_state:{id:'q1',confidence:0.9},rules:[{
    raw_label_text:'a,A / שלוף ?',zones:{left_text:'a',middle_text:'A',right_text:'שלוף ?'},line_bbox:{x:.1,y:.1,w:.2,h:.1},
    read_input:{value:'a',confidence:.9},pop_value:{value:'A',confidence:.9},stack_action:{type:'POP',confidence:.6},
    push_value:{value:'ε',confidence:.9}
  }]});
  const rule=ctx.__getCurrent().transitions[0].rules[0],P=ctx.pdaRuleParts(rule);
  assert.equal(P.guard,'A');
  assert.equal(P.popSym,'?');
  assert.equal(rule.scanIncomplete,true);
  assert.equal(ctx.pdaRuleBlocked(rule),true);
  assert.equal(ctx.pdaApplicable('q0',0,['A','⊥'],'a').length,0);
});

test('an UNKNOWN scanned action is preserved and cannot run as NONE', () => {
  const ctx=loadClient();
  pdaModel(ctx,[],[{id:'q0',label:'q0',isStart:true,isAccept:false},{id:'q1',label:'q1',isStart:false,isAccept:true}]);
  ctx.addAiTransition({transition_id:'unknown-action',source_state:{id:'q0',confidence:.9},target_state:{id:'q1',confidence:.9},rules:[{
    raw_label_text:'a,A / □',zones:{left_text:'a',middle_text:'A',right_text:'□'},line_bbox:{x:.1,y:.1,w:.2,h:.1},
    read_input:{value:'a',confidence:.9},pop_value:{value:'A',confidence:.9},stack_action:{type:'UNKNOWN',confidence:.4},
    push_value:{value:'ε',confidence:.4},pop_symbol:{value:'ε',confidence:.4},scan_incomplete:true
  }]});
  const rule=ctx.__getCurrent().transitions[0].rules[0];
  assert.equal(rule.op,'unknown');
  assert.equal(rule.scanIncomplete,true);
  assert.equal(ctx.pdaApplicable('q0',0,['A','⊥'],'a').length,0);
  assert.equal(ctx.pdaActionText(rule),'פעולה לא מזוהה');
});

test('AI state import does not invent a start state when no start arrow was read', () => {
  const ctx=loadClient();
  pdaModel(ctx,[],[]);
  ctx.applyAiStates({states:[{id:'q7',is_start:false,is_accepting:false,confidence:.9}]});
  assert.equal(ctx.__getCurrent().states[0].isStart,false);
  assert.match(ctx.__getCurrent().aiScanIssues.join(' | '),/לא זוהה חץ התחלה/);
});

test('DPDA validation preserves an unresolved overlapping-rule case without choosing display order', () => {
  const ctx=loadClient();
  pdaModel(ctx,[
    {id:'t1',from:'q2',to:'q3',rules:[ctx.makeRulePDA('a','A','push','B')]},
    {id:'t2',from:'q2',to:'q4',rules:[ctx.makeRulePDA('a','A','none','')]},
  ],[
    {id:'q2',label:'q2',isStart:true,isAccept:false},{id:'q3',label:'q3',isStart:false,isAccept:true},{id:'q4',label:'q4',isStart:false,isAccept:true}
  ]);
  const v=ctx.computeValidation();
  assert.equal(v.deterministic,null);
  assert.equal(v.ambiguities.length,1);
  ctx.__getCurrent().ndet=true;
  assert.equal(ctx.computeValidation().deterministic,null,'הנתונים נשמרים; בחירת NPDA קובעת רק את מנוע הריצה ולא משכתבת אותם');
});

test('missing scan fields never become runnable epsilon/NONE rules', () => {
  const ctx = loadClient();
  const unknown = ctx.aiRuleFromPayload(scannedRule({
    stack_action: undefined,
    zones: { left_text: 'a', middle_text: 'A', right_text: '???' },
    raw_label_text: 'a,A / ???',
  }));
  assert.equal(unknown.op, 'unknown');
  assert.equal(unknown.scanIncomplete, true);
  assert.equal(ctx.pdaRuleBlocked(unknown), true);

  const missingRead = ctx.aiRuleFromPayload(scannedRule({ read_input: undefined }));
  assert.equal(ctx.pdaRuleParts(missingRead).read, '?');
  assert.equal(missingRead.scanIncomplete, true);

  const missingTop = ctx.aiRuleFromPayload(scannedRule({ pop_value: undefined }));
  assert.equal(ctx.pdaRuleParts(missingTop).guard, '?');
  assert.equal(missingTop.scanIncomplete, true);

  const missingPush = ctx.aiRuleFromPayload(scannedRule({ push_value: undefined }));
  assert.equal(ctx.pdaRuleParts(missingPush).unreadableField, true, 'חסר נשמר כ־? ולא מומצא לו סימן');
  assert.equal(missingPush.scanIncomplete, true);

  pdaModel(ctx, [{ id: 't', from: 'q2', to: 'q3', rules: [unknown, missingRead, missingTop, missingPush] }]);
  assert.equal(ctx.pdaApplicable('q2', 0, ['A', '⊥'], 'a').length, 0);
});

test('low-confidence spatial evidence is preserved but cannot run before human approval', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: true },
  ]);
  ctx.addAiTransition({
    transition_id: 'low', source_state: { id: 'q0', confidence: 0.95 }, target_state: { id: 'q1', confidence: 0.95 },
    rules: [scannedRule({ read_input: { value: 'a', confidence: 0.4 } })],
  });
  const rule = ctx.__getCurrent().transitions[0].rules[0];
  assert.equal(rule.scanIncomplete, true);
  assert.equal(rule.aiLow, true);
  assert.equal(ctx.pdaApplicable('q0', 0, ['A', '⊥'], 'a').length, 0);
});

test('server line ids and prior scan evidence survive repeated scan sessions without ghost rules', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: true },
  ]);
  const base = {
    transition_id: 't1', source_state: { id: 'q0', confidence: 0.95 }, target_state: { id: 'q1', confidence: 0.95 },
  };
  ctx.addAiTransition(Object.assign({}, base, {
    __scanSessionId: 'scan-one',
    rules: [scannedRule({ ai_line_id: 'server-line-777', raw_label_text: 'a,A / B דחוף' })],
  }));
  let active = ctx.__getCurrent().transitions[0].rules;
  assert.equal(active[0].aiLineId, 'scan-one:server-line-777');

  ctx.addAiTransition(Object.assign({}, base, {
    __scanSessionId: 'scan-two',
    rules: [scannedRule({ ai_line_id: 'server-line-888', raw_label_text: 'b,A / C דחוף',
      zones: { left_text: 'b', middle_text: 'A', right_text: 'C דחוף' },
      read_input: { value: 'b', confidence: 0.9 }, push_value: { value: 'C', confidence: 0.9 } })],
  }));
  active = ctx.__getCurrent().transitions[0].rules;
  assert.equal(active.length, 1, 'הסריקה הישנה אינה נשארת ככלל פעיל/רפאים');
  assert.equal(active[0].aiLineId, 'scan-two:server-line-888');
  assert.equal(ctx.__getCurrent().scanEvidenceHistory.length, 1);
  assert.equal(ctx.__getCurrent().scanEvidenceHistory[0].rules[0].aiLineId, 'scan-one:server-line-777');
});

test('multiple scanned start arrows and unresolved endpoints are preserved for review', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], []);
  ctx.applyAiStates({ states: [
    { id: 'q0', is_start: true, is_accepting: false, confidence: 0.9 },
    { id: 'q1', is_start: true, is_accepting: false, confidence: 0.9 },
  ] });
  assert.equal(ctx.__getCurrent().states.filter(s => s.isStart).length, 2, 'לא נבחר אחד בשקט');
  assert.match(ctx.__getCurrent().aiScanIssues.join(' | '), /כמה חצי התחלה/);

  pdaModel(ctx, [], []);
  const added = ctx.addAiTransition({
    transition_id: 'unresolved',
    source_state: { id: '', confidence: 0.4 }, target_state: { id: 'q1', confidence: 0.9 },
    rules: [scannedRule()],
  });
  assert.equal(added, null);
  assert.equal(ctx.__getCurrent().transitions.length, 0);
  assert.equal(ctx.__getCurrent().states.some(s => s.label === '?'), false);
  assert.equal(ctx.__getCurrent().unresolvedScanTransitions.length, 1);
  assert.equal(ctx.__getCurrent().unresolvedScanTransitions[0].evidence.rules[0].zones.right_text, 'B דחוף');
});

test('DPDA overlap detection covers epsilon/read and wildcard/top without counting blocked rules', () => {
  const ctx = loadClient();
  pdaModel(ctx, [
    { id: 'e1', from: 'q0', to: 'q1', rules: [ctx.makeRulePDA('', 'A', 'push', 'B')] },
    { id: 'e2', from: 'q0', to: 'q2', rules: [ctx.makeRulePDA('a', 'A', 'none', '')] },
    { id: 'w1', from: 'q0', to: 'q1', rules: [ctx.makeRulePDA('b', '', 'push', 'C')] },
    { id: 'w2', from: 'q0', to: 'q2', rules: [ctx.makeRulePDA('b', 'A', 'none', '')] },
    { id: 'bad', from: 'q0', to: 'q2', rules: [ctx.makeRulePDA('c', 'A', 'pop', '', 'B')] },
  ], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: true },
    { id: 'q2', label: 'q2', isStart: false, isAccept: true },
  ]);
  const v = ctx.computeValidation();
  assert.equal(v.deterministic, null);
  assert.ok(v.ambiguities.length >= 2);
  assert.equal(v.ambiguities.some(x => /c/.test(x.sym)), false, 'כלל POP חסום אינו משפיע על בדיקת החפיפה');
});

test('structural review issues are recalculated rather than kept stale', () => {
  const ctx = loadClient();
  const model = pdaModel(ctx, [], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: true },
  ]);
  ctx.flagAiStructuralIssues();
  assert.ok(model.states.some(s => s.structuralIssues.length));
  model.transitions.push({ id: 't', from: 'q0', to: 'q1', rules: [ctx.makeRulePDA('a', '⊥', 'push', 'A')] });
  ctx.flagAiStructuralIssues();
  assert.deepEqual(Array.from(model.states[0].structuralIssues), []);
  assert.deepEqual(Array.from(model.states[1].structuralIssues), []);
});

test('scan evidence keeps inactive fields verbatim and editor data does not invent confidence', () => {
  const ctx = loadClient();
  const rule = ctx.aiRuleFromPayload(scannedRule({
    raw_label_text: 'a,A / ללא שינוי',
    zones: { left_text: 'a', middle_text: 'A', right_text: 'ללא שינוי' },
    read_input: { value: 'a' }, pop_value: { value: 'A' },
    stack_action: { type: 'NONE' },
    push_value: { value: 'B' }, pop_symbol: { value: 'C' },
    observed_fields: { read_input: 'a', stack_top: 'A', action: 'NONE', push_symbol: 'B', pop_symbol: 'C' },
  }));
  assert.equal(rule.scanEvidence.structured.push_symbol, 'B');
  assert.equal(rule.scanEvidence.structured.pop_symbol, 'C');
  assert.equal(rule.aiConfidence, null);

  const missingPop = ctx.makeRulePDA('a', 'A', 'pop', '', '');
  const editor = ctx.pdaRuleToAi(missingPop);
  assert.equal(editor.pop_symbol.value, '', 'חסר נשאר ריק לעריכה ואינו מוצג כ־ε');
  assert.equal(editor.pop_symbol.confidence, null);
});

test('out-of-range line boxes and a visible NONE suffix remain review-only in the client', () => {
  const ctx = loadClient();
  const badBox = ctx.aiRuleFromPayload(scannedRule({ line_bbox: { x: 0.9, y: 0.1, w: 0.3, h: 0.1 } }));
  assert.equal(badBox.scanIncomplete, true);

  const noneSuffix = ctx.aiRuleFromPayload(scannedRule({
    raw_label_text: 'a,A / ללא שינוי B',
    zones: { left_text: 'a', middle_text: 'A', right_text: 'ללא שינוי B' },
    stack_action: { type: 'NONE', confidence: 0.9 },
    push_value: { value: 'ε', confidence: 0.9 }, pop_symbol: { value: 'ε', confidence: 0.9 },
  }));
  assert.equal(noneSuffix.scanIncomplete, true);
  assert.match(noneSuffix.aiIssues.join(' | '), /משמעותו טרם הוגדרה/);
});

test('client-side scan parsing keeps Latin E as a literal input symbol', () => {
  const ctx = loadClient();
  const rule = ctx.aiRuleFromPayload(scannedRule({
    raw_label_text: 'E,A / B דחוף',
    zones: { left_text: 'E', middle_text: 'A', right_text: 'B דחוף' },
    read_input: { value: 'E', confidence: 0.9 },
  }));
  assert.equal(ctx.pdaRuleParts(rule).read, 'E');
});

test('spatial OCR never strips epsilon/separators or chooses a letter from alternatives', () => {
  const ctx = loadClient();
  for (const literal of ['bε', 'εa', 'a,b', 'a / ε', 'epsilon', ',', 'ε,']) {
    const rule = ctx.aiRuleFromPayload(scannedRule({
      raw_label_text: `${literal},A / B דחוף`,
      zones: { left_text: literal, middle_text: 'A', right_text: 'B דחוף' },
      read_input: { value: literal, confidence: 0.99 },
      source_state:{id:'q2',confidence:.99},target_state:{id:'q3',confidence:.99},
    }));
    assert.equal(ctx.pdaRuleParts(rule).read, '?', literal);
    assert.equal(rule.scanIncomplete, true, literal);
    assert.equal(rule.scanEvidence.structured.read_input, literal);
    assert.equal(rule.scanEvidence.zones.left_text, literal);
  }
  for (const literal of ['a', 'b', 'c', 'ε']) {
    const rule = ctx.aiRuleFromPayload(scannedRule({
      raw_label_text: `${literal},A / B דחוף`,
      zones: { left_text: literal, middle_text: 'A', right_text: 'B דחוף' },
      read_input: { value: literal, confidence: 0.99 },
      source_state:{id:'q2',confidence:.99},target_state:{id:'q3',confidence:.99},
    }));
    assert.equal(ctx.pdaRuleParts(rule).read, literal === 'ε' ? '' : literal);
    assert.equal(rule.scanIncomplete, false, `literal ${literal} remains valid`);
  }
});

test('ambiguous spatial evidence cannot validate a guessed letter or epsilon', () => {
  const ctx = loadClient();
  for (const structured of ['a', 'b', 'ε']) {
    const rule = ctx.aiRuleFromPayload(scannedRule({
      raw_label_text: `${structured},A / B דחוף`,
      zones: { left_text: `${structured} / b`, middle_text: 'A', right_text: 'B דחוף' },
      read_input: { value: structured, confidence: 0.99 },
      source_state:{id:'q2',confidence:.99},target_state:{id:'q3',confidence:.99},
    }));
    assert.equal(rule.scanIncomplete, true);
    pdaModel(ctx,[{id:'ambiguous',from:'q2',to:'q3',rules:[rule]}]);
    assert.equal(ctx.pdaApplicable('q2',0,['A','⊥'],structured==='ε'?'':structured).length,0);
    assert.match(ctx.transLabelLines({rules:[rule]})[0],/⚠/,'blocked visual evidence is also flagged on the canvas');
    assert.equal(rule.scanEvidence.structured.read_input, structured, 'conflicting evidence is not rewritten');
  }
});

test('scan zones must contain readable spatial symbols and strict bottom-marker evidence', () => {
  const ctx = loadClient();
  const missingLeft = ctx.aiRuleFromPayload(scannedRule({ zones: { left_text: '?', middle_text: 'A', right_text: 'B דחוף' } }));
  const missingMiddle = ctx.aiRuleFromPayload(scannedRule({ zones: { left_text: 'a', middle_text: '?', right_text: 'B דחוף' } }));
  const missingRightSymbol = ctx.aiRuleFromPayload(scannedRule({ zones: { left_text: 'a', middle_text: 'A', right_text: 'דחוף' } }));
  const epsilonTop = ctx.aiRuleFromPayload(scannedRule({
    raw_label_text: 'a,ε / B דחוף', zones: { left_text: 'a', middle_text: 'ε', right_text: 'B דחוף' },
    pop_value: { value: 'ε', confidence: 0.9 },
  }));
  const legacyLookalike = ctx.aiRuleFromPayload(scannedRule({
    raw_label_text: 'a,Z0 / B דחוף', zones: { left_text: 'a', middle_text: 'Z0', right_text: 'B דחוף' },
    pop_value: { value: 'Z0', confidence: 0.9 },
  }));
  for (const rule of [missingLeft, missingMiddle, missingRightSymbol, epsilonTop, legacyLookalike]) {
    assert.equal(rule.scanIncomplete, true);
  }
  assert.equal(ctx.pdaRuleParts(legacyLookalike).guard, '?', 'Z0 שנראה בתמונה אינו מתוקן בשקט ל-⊥');
  assert.deepEqual(Array.from(ctx.pdaTokens('AZ0B')), ['A', 'Z', '0', 'B'], 'כינוי legacy אינו משכתב תת-מחרוזת');
});

test('imported UNKNOWN rules become semantic review items after metadata refresh', () => {
  const ctx = loadClient();
  const model = pdaModel(ctx, [
    { id: 't', from: 'q2', to: 'q3', rules: [{ read: 'a', top: 'A', op: 'unknown', push: [] }] },
  ]);
  ctx.refreshPdaMetadata(model);
  assert.equal(model.transitions[0].semanticBlocked, true);
  assert.match(model.transitions[0].semanticIssues.join(' | '), /חסרה או אינה מזוהה/);
});

test('the client does not rewrite a scanned ε read into a guessed input letter', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 'q0', label: 'q0', isStart: true, isAccept: false },
    { id: 'q1', label: 'q1', isStart: false, isAccept: true },
  ]);
  // חץ עם קלט ממשי, כדי שיהיה "ניחוש" זמין אילו מנגנון כזה עדיין היה קיים
  ctx.addAiTransition({
    transition_id: 't0', source_state: { id: 'q0', confidence: 0.9 }, target_state: { id: 'q1', confidence: 0.9 },
    rules: [{ raw_label_text: 'a,A / A דחוף', read_input: { value: 'a', confidence: 0.9 },
      stack_action: { type: 'PUSH', confidence: 0.9 }, push_value: { value: 'A', confidence: 0.9 },
      pop_value: { value: 'A', confidence: 0.9 }, pop_symbol: { value: 'ε', confidence: 0.9 } }],
  });
  ctx.addAiTransition({
    transition_id: 't1', source_state: { id: 'q1', confidence: 0.9 }, target_state: { id: 'q0', confidence: 0.9 },
    rules: [{ raw_label_text: 'ε,S / A דחוף', read_input: { value: 'ε', confidence: 0.9 },
      stack_action: { type: 'PUSH', confidence: 0.9 }, push_value: { value: 'A', confidence: 0.9 },
      pop_value: { value: 'S', confidence: 0.9 }, pop_symbol: { value: 'ε', confidence: 0.9 } }],
  });
  const epsRule = ctx.__getCurrent().transitions.find(t => t.id !== ctx.__getCurrent().transitions[0].id).rules[0];
  assert.equal(ctx.pdaRuleParts(epsRule).read, '', 'ה-ε נשאר ε ולא הוחלף באות מנוחשת');
});

test('DFA/NFA and TM client paths still work', () => {
  const ctx = loadClient();
  // DFA
  ctx.__setCurrent({
    type: 'dfa', ndet: false,
    states: [{ id: 's0', label: 'q0', isStart: true, isAccept: false }, { id: 's1', label: 'q1', isStart: false, isAccept: true }],
    transitions: [
      { id: 'e0', from: 's0', to: 's1', symbols: ['a'] },
      { id: 'e1', from: 's1', to: 's1', symbols: ['a'] },
    ],
  });
  let sim = ctx.simInit('aa');
  ctx.simStepObj(sim); ctx.simStepObj(sim); ctx.simStepObj(sim);
  assert.equal(sim.status, 'accepted');

  // NFA
  ctx.__setCurrent({
    type: 'dfa', ndet: true,
    states: [{ id: 's0', label: 'q0', isStart: true, isAccept: false }, { id: 's1', label: 'q1', isStart: false, isAccept: true }],
    transitions: [{ id: 'e0', from: 's0', to: 's1', symbols: ['a'] }],
  });
  assert.equal(ctx.nfaAccepts('a'), true);
  assert.equal(ctx.nfaAccepts('b'), false);

  // TM
  ctx.__setCurrent({
    type: 'tm', ndet: false,
    states: [{ id: 's0', label: 'q0', isStart: true, isAccept: false }, { id: 's1', label: 'q1', isStart: false, isAccept: true }],
    transitions: [{ id: 'e0', from: 's0', to: 's1', rules: [{ read: '1', write: '0', move: 'R' }] }],
  });
  sim = ctx.simInit('1');
  ctx.simStepObj(sim);
  assert.equal(sim.status, 'accepted');
  assert.equal(sim.tape[0], '0', 'הסרט נכתב');
});

test('editing a scanned PDA rule keeps its scan identity and a rescan cannot leave a runnable ghost', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [], [
    { id: 's0', label: 'q0', isStart: true, isAccept: false },
    { id: 's1', label: 'q1', isStart: false, isAccept: true },
  ]);
  const first = scannedTransition('physical-arrow', 'q0', 'q1', [scannedRule({ ai_line_id: 'line-1' })], { __scanSessionId: 'scan-1' });
  const transitionId = ctx.addAiTransition(first);
  vm.runInContext('promptTransitionPDA=(...args)=>{ globalThis.__editOptions=args[4]; };', ctx);
  ctx.editPdaTransition(transitionId, 0);
  ctx.__editOptions.onSave(ctx.makeRulePDA('a', 'A', 'push', 'C', ''));

  let t = ctx.__getCurrent().transitions[0];
  assert.equal(t.rules[0].aiScanSession, 'scan-1', 'עריכה ידנית אינה מנתקת את observation מסשן הסריקה');
  assert.equal(ctx.pdaRuleParts(t.rules[0]).push.join(''), 'C');

  ctx.addAiTransition(scannedTransition('physical-arrow', 'q0', 'q1', [
    scannedRule({ ai_line_id: 'line-1', raw_label_text: 'a,A / D דחוף', zones: { left_text: 'a', middle_text: 'A', right_text: 'D דחוף' }, push_value: { value: 'D', confidence: 0.9 } }),
  ], { __scanSessionId: 'scan-2' }));
  t = ctx.__getCurrent().transitions[0];
  assert.equal(t.rules.length, 1, 'הכלל הערוך מן הסריקה הקודמת הועבר לארכיון ולא נשאר ככלל רפאים');
  assert.equal(ctx.pdaRuleParts(t.rules[0]).push.join(''), 'D');
  assert.ok(ctx.__getCurrent().scanEvidenceHistory.length >= 1);
});

test('correcting one uncertain endpoint clears only that endpoint and makes an otherwise approved PDA rule runnable', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [], [
    { id: 's0', label: 'q0', isStart: false, isAccept: false },
    { id: 's1', label: 'q1', isStart: false, isAccept: true },
    { id: 's2', label: 'q2', isStart: true, isAccept: false },
  ]);
  const id = ctx.addAiTransition(scannedTransition('endpoint-review', 'q0', 'q1', [scannedRule()], {
    __scanSessionId: 'scan-e', source_state: { id: 'q0', confidence: 0.2 }, target_state: { id: 'q1', confidence: 0.9 },
  }));
  let t = ctx.__getCurrent().transitions[0];
  assert.equal(t.rules[0].endpointReview.source, true);
  assert.equal(ctx.pdaApplicable('s0', 0, ['A', '⊥'], 'a').length, 0);

  ctx.setTransitionEndpoint(id, 'from', 's2');
  t = ctx.__getCurrent().transitions[0];
  assert.equal(t.endpointReview.source, false);
  assert.equal(t.rules[0].endpointReview.source, false);
  assert.equal(t.rules[0].scanIncomplete, false);
  assert.equal(t.rules[0].aiLow, false);
  assert.equal(ctx.pdaApplicable('s2', 0, ['A', '⊥'], 'a').length, 1);
});

test('a repeat scan records evidence but cannot overwrite manually reviewed start/accept flags', () => {
  const ctx = loadClient();
  const model = pdaModel(ctx, [], [
    { id: 's0', label: 'q0', isStart: true, isAccept: true, manuallyReviewed: true, aiObservationIds: ['obs-q0'] },
  ]);
  ctx.applyAiStates({ states: [{ observation_id: 'obs-q0', visible_label: 'q0', id: 'q0', is_start: false, is_accepting: false, confidence: 0.95 }] }, 'scan-new');
  assert.equal(model.states[0].isStart, true);
  assert.equal(model.states[0].isAccept, true);
  assert.equal(model.states[0].latestScanStateEvidence.is_start, false, 'הקריאה החדשה נשמרה כראיה ולא נזרקה');
});

test('parallel physical arrows stay separate, while the same transition id is moved and archived on rescan', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 's0', label: 'q0', isStart: true, isAccept: false },
    { id: 's1', label: 'q1', isStart: false, isAccept: true },
    { id: 's2', label: 'q2', isStart: false, isAccept: false },
  ]);
  ctx.addAiTransition(scannedTransition('arrow-A', 'q0', 'q1', [scannedRule()], { __scanSessionId: 'scan-1' }));
  ctx.addAiTransition(scannedTransition('arrow-B', 'q0', 'q1', [scannedRule()], { __scanSessionId: 'scan-1' }));
  assert.equal(ctx.__getCurrent().transitions.length, 2, 'transition_id שונה מייצג חץ פיזי מקביל נפרד');

  ctx.addAiTransition(scannedTransition('arrow-A', 'q0', 'q2', [scannedRule()], { __scanSessionId: 'scan-2' }));
  const current = ctx.__getCurrent();
  assert.equal(current.transitions.length, 2);
  const moved = current.transitions.find(t => t.aiTransitionId === 'arrow-A');
  assert.equal(moved.from, 's0');
  assert.equal(moved.to, 's2');
  assert.equal(moved.rules.length, 1);
  assert.ok(current.scanEvidenceHistory.some(h => h.transitionId === 'arrow-A' && h.from === 's0' && h.to === 's1'));
});

test('unresolved transitions are upserted across rescans and resolution preserves original endpoint evidence', async () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [], [
    { id: 's0', label: 'q0', isStart: true, isAccept: false },
    { id: 's1', label: 'q1', isStart: false, isAccept: true },
  ]);
  const unresolved = session => scannedTransition('unresolved-arrow', '', 'q1', [scannedRule()], {
    __scanSessionId: session,
    source_state: { observation_id: 'missing-circle', visible_label: '', id: '', confidence: 0.2 },
    target_state: { id: 'q1', confidence: 0.9 },
    original_endpoint_evidence: { source_state: { marker: `source-${session}` }, target_state: { marker: `target-${session}` } },
  });
  ctx.addAiTransition(unresolved('scan-1'));
  ctx.addAiTransition(unresolved('scan-2'));
  assert.equal(ctx.__getCurrent().unresolvedScanTransitions.length, 1);
  assert.equal(ctx.__getCurrent().unresolvedScanTransitionHistory.length, 1);

  const wrap = { innerHTML: '', querySelector: selector => ({ value: selector === '#unresolvedFrom' ? 's0' : 's1' }) };
  ctx.document.createElement = () => wrap;
  vm.runInContext('_buildDialog=o=>Promise.resolve(o.buttons[1].value);', ctx);
  ctx.resolveUnresolvedTransition(0);
  await Promise.resolve();
  await Promise.resolve();

  const model = ctx.__getCurrent();
  assert.equal(model.unresolvedScanTransitions.length, 0);
  assert.ok(model.unresolvedScanTransitionHistory.length >= 2);
  const rule = model.transitions.find(t => t.aiTransitionId === 'unresolved-arrow').rules[0];
  assert.equal(rule.scanEvidence.endpoint_evidence.source_state.marker, 'source-scan-2');
  assert.equal(rule.scanEvidence.endpoint_evidence.target_state.marker, 'target-scan-2');
});

test('blank and duplicate state observations remain review items and are upserted without silent merge', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], []);
  ctx.applyAiStates({ states: [
    { observation_id: 'circle-1', visible_label: 'q0', id: 'q0', is_start: true, is_accepting: false, confidence: 0.9 },
    { observation_id: 'circle-2', visible_label: 'q0', id: 'q0', is_start: false, is_accepting: true, confidence: 0.9 },
    { observation_id: 'circle-3', visible_label: '', id: '', is_start: false, is_accepting: false, confidence: 0.4, scan_incomplete: true },
  ] }, 'scan-1');
  let model = ctx.__getCurrent();
  assert.equal(model.states.length, 1, 'תווית כפולה אינה ממזגת שני עיגולים פיזיים');
  assert.deepEqual(Array.from(model.unresolvedStateObservations, x => x.observationId).sort(), ['circle-2', 'circle-3']);

  ctx.applyAiStates({ states: [
    { observation_id: 'circle-2', visible_label: 'q0', id: 'q0', is_start: false, is_accepting: true, confidence: 0.8 },
  ] }, 'scan-2');
  model = ctx.__getCurrent();
  assert.equal(model.unresolvedStateObservations.length, 2);
  assert.ok(model.unresolvedStateObservationHistory.some(x => x.observationId === 'circle-2'));
});

test('visible rule-line count is an independent execution gate and exact duplicate physical rows are preserved', () => {
  const ctx = loadClient();
  pdaModel(ctx, [], [
    { id: 's0', label: 'q0', isStart: true, isAccept: false },
    { id: 's1', label: 'q1', isStart: false, isAccept: true },
  ]);
  const duplicate = scannedRule({ ai_line_id: 'same-looking' });
  ctx.addAiTransition(scannedTransition('count-mismatch', 'q0', 'q1', [duplicate, Object.assign({}, duplicate, { ai_line_id: 'second-physical-row' })], {
    __scanSessionId: 'scan-count', visible_rule_line_count: 3,
  }));
  const t = ctx.__getCurrent().transitions[0];
  assert.equal(t.rules.length, 2, 'שתי שורות פיזיות זהות נשמרות כשני observations');
  assert.equal(t.transitionScanIncomplete, true);
  assert.equal(ctx.hasPendingAiExecutionReview(), true);
  assert.equal(ctx.pdaApplicable('s0', 0, ['A', '⊥'], 'a').length, 0);
});

test('scanned FA/NFA labels never invent epsilon and missing, malformed, or low-confidence reads cannot execute', () => {
  for (const ndet of [false, true]) {
    const ctx = loadClient();
    ctx.__setCurrent({
      type: 'dfa', ndet,
      states: [{ id: 's0', label: 'q0', isStart: true, isAccept: false }, { id: 's1', label: 'q1', isStart: false, isAccept: true }],
      transitions: [],
    });
    ctx.addAiTransition(scannedTransition(`fa-${ndet}`, 'q0', 'q1', [{ raw_label_text: '', read_input: { value: '', confidence: 0.9 } }], { __scanSessionId: 'scan-fa' }));
    let t = ctx.__getCurrent().transitions[0];
    assert.deepEqual(Array.from(t.symbols), [], 'חסר אינו מומצא כ-ε');
    assert.equal(t.scanIncomplete, true);
    assert.equal(ctx.simReady(), false);

    ctx.__setCurrent({
      type: 'dfa', ndet,
      states: [{ id: 's0', label: 'q0', isStart: true, isAccept: false }, { id: 's1', label: 'q1', isStart: false, isAccept: true }],
      transitions: [],
    });
    ctx.addAiTransition(scannedTransition(`fa-low-${ndet}`, 'q0', 'q1', [{ raw_label_text: 'a', read_input: { value: 'a', confidence: 0.2 } }], { __scanSessionId: 'scan-fa-low' }));
    t = ctx.__getCurrent().transitions[0];
    assert.deepEqual(Array.from(t.symbols), []);
    assert.equal(t.scanIncomplete, true);
  }
});

test('scanned TM labels preserve unknown fields and only a complete high-confidence rule can execute', () => {
  const ctx = loadClient();
  const states = [{ id: 's0', label: 'q0', isStart: true, isAccept: false }, { id: 's1', label: 'q1', isStart: false, isAccept: true }];
  ctx.__setCurrent({ type: 'tm', ndet: false, states, transitions: [] });
  ctx.addAiTransition(scannedTransition('tm-bad', 'q0', 'q1', [{ raw_label_text: 'unreadable', read_input: { value: '', confidence: 0.9 } }], { __scanSessionId: 'scan-tm-bad' }));
  let t = ctx.__getCurrent().transitions[0];
  assert.equal(t.rules[0].read, '?');
  assert.equal(t.rules[0].write, '?');
  assert.equal(t.rules[0].move, '?');
  let sim = ctx.simInit('1');
  ctx.tmStep(sim);
  assert.equal(sim.status, 'rejected', 'כלל סרוק חסר/פגום אינו רץ גם כשעוקפים את כפתור ההרצה');

  ctx.__setCurrent({ type: 'tm', ndet: false, states, transitions: [] });
  ctx.addAiTransition(scannedTransition('tm-good', 'q0', 'q1', [{
    raw_label_text: '1 -> 0, R', read_input: { value: '1', confidence: 0.9 },
    write_value: { value: '0', confidence: 0.9 }, head_direction: { value: 'R', confidence: 0.9 },
  }], { __scanSessionId: 'scan-tm-good' }));
  t = ctx.__getCurrent().transitions[0];
  assert.equal(t.rules[0].scanIncomplete, false);
  sim = ctx.simInit('1');
  ctx.tmStep(sim);
  assert.equal(sim.status, 'accepted');
  assert.equal(sim.tape[0], '0');
});

test('missing PDA field or endpoint confidence is review-only, never treated as implicit high confidence', () => {
  const ctx = loadClient();
  const missingFieldConfidence = ctx.aiRuleFromPayload(scannedRule({ read_input: { value: 'a' } }));
  assert.equal(missingFieldConfidence.scanIncomplete, true);
  assert.match(missingFieldConfidence.aiIssues.join(' | '), /חסר confidence/);

  silenceClientUi(ctx);
  pdaModel(ctx, [], [
    { id: 's0', label: 'q0', isStart: true, isAccept: false },
    { id: 's1', label: 'q1', isStart: false, isAccept: true },
  ]);
  const id = ctx.addAiTransition(scannedTransition('missing-endpoint-confidence', 'q0', 'q1', [scannedRule()], {
    __scanSessionId: 'scan-missing-confidence', source_state: { id: 'q0' }, target_state: { id: 'q1', confidence: 0.9 },
  }));
  let t = ctx.__getCurrent().transitions[0];
  assert.equal(t.endpointReview.source, true);
  assert.equal(t.rules[0].scanIncomplete, true);
  ctx.setTransitionEndpoint(id, 'from', 's0');
  t = ctx.__getCurrent().transitions[0];
  assert.equal(t.rules[0].scanIncomplete, false, 'אישור endpoint מפורש פותר רק את חסר הביטחון של ה-endpoint');
});

test('an explicit transition scan_incomplete flag blocks otherwise valid PDA, FA, and TM scans', () => {
  const cases = [
    {
      type: 'pda', rule: scannedRule(),
      inspect: t => t.rules[0],
    },
    {
      type: 'dfa', rule: { raw_label_text: 'a', read_input: { value: 'a', confidence: 0.9 } },
      inspect: t => t.scanRuleEvidence[0],
    },
    {
      type: 'tm', rule: {
        raw_label_text: '1 -> 0, R', read_input: { value: '1', confidence: 0.9 },
        write_value: { value: '0', confidence: 0.9 }, head_direction: { value: 'R', confidence: 0.9 },
      },
      inspect: t => t.rules[0],
    },
  ];
  for (const c of cases) {
    const ctx = loadClient();
    ctx.__setCurrent({
      type: c.type, ndet: false,
      states: [{ id: 's0', label: 'q0', isStart: true, isAccept: false }, { id: 's1', label: 'q1', isStart: false, isAccept: true }],
      transitions: [],
    });
    ctx.addAiTransition(scannedTransition(`incomplete-${c.type}`, 'q0', 'q1', [c.rule], {
      __scanSessionId: `scan-${c.type}`, scan_incomplete: true,
    }));
    const t = ctx.__getCurrent().transitions[0];
    assert.equal(t.transitionScanIncomplete, true, `${c.type}: transition flag נשמר`);
    assert.equal(t.scanIncomplete, true, `${c.type}: המעבר חסום`);
    assert.equal(ctx.hasPendingAiExecutionReview(), true);
    assert.ok(c.inspect(t), `${c.type}: ראיית הכלל נשמרה ולא נמחקה`);
  }
});

test('two-stage merge preserves two parallel physical arrows with the same endpoints', () => {
  const ctx = loadClient();
  const session = 'two-stage-parallel';
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1', { is_accepting: true })];
  const connectors = [
    topologyConnector('arrow-A', 'connector-A', 'state-0', 'state-1', ['line-A']),
    topologyConnector('arrow-B', 'connector-B', 'state-0', 'state-1', ['line-B'], {
      label_block_bbox: { x: 0.3, y: 0.42, w: 0.3, h: 0.08 },
      line_hints: [{ line_id: 'line-B', bbox: { x: 0.32, y: 0.43, w: 0.25, h: 0.055 } }],
    }),
  ];
  const passA = topologyPass(session, states, connectors);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  assert.equal(merged.transitions.length, 2);
  assert.ok(merged.states.every(s => !s.scan_incomplete), 'inner state-label crop תקין אינו warning מלאכותי');
  assert.ok(merged.transitions.every(t => !t.scan_incomplete && t.rules.every(r => !r.scan_incomplete)));
  assert.deepEqual(Array.from(merged.transitions, t => t.transition_id), ['arrow-A', 'arrow-B']);
  assert.deepEqual(Array.from(merged.transitions, t => t.connector_observation_id), ['connector-A', 'connector-B']);

  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session, sessionEvidence: merged.two_stage_evidence });
  const model = ctx.__getCurrent();
  assert.equal(model.transitions.length, 2);
  assert.equal(model.transitions[0].from, model.transitions[1].from);
  assert.equal(model.transitions[0].to, model.transitions[1].to);
});

test('narrow label blocks keep a bounded action-word margin without widening primary baselines', () => {
  const ctx=loadClient(),session='narrow-context';
  const connector=topologyConnector('t','c','s0','s1',['l'],{
    label_block_bbox:{x:.4,y:.2,w:.1,h:.06},line_hints:[{line_id:'l',bbox:{x:.4,y:.2,w:.1,h:.025}}]});
  const passA=topologyPass(session,[topologyState('s0','q0'),topologyState('s1','q1')],[connector]);
  const specs=ctx.buildTwoStageCropSpecs(passA,session).specs;
  const context=specs.find(c=>c.kind==='label_block'),line=specs.find(c=>c.kind==='line');
  assert.equal(context.padding.x,.04);
  const box=ctx.paddedScanBBox(context.source_bbox,context.padding).bbox;
  assert.ok(box.x+box.w>=.539,'right context retains a word beyond the Latin-prefix bbox');
  assert.equal(line.padding.x,.04,'the target zoom must retain the same complete action word as context');
  assert.ok(line.padding.y<=.015,'primary precision remains vertically bounded');
  assert.ok(context.padding.x<=.06,'never revert to a broad 10%-page margin');
});

test('context-read pixel provenance survives merge and rule import without moving the physical row', () => {
  const ctx=loadClient(),session='context-read';
  const states=[topologyState('s0','q0',{is_start:true}),topologyState('s1','q1',{is_accepting:true})];
  const passA=topologyPass(session,states,[topologyConnector('t1','c1','s0','s1',['line-1'])]);
  const crops=materializedCropManifest(ctx,passA,session),block=crops.find(c=>c.kind==='label_block'),line=crops.find(c=>c.kind==='line');
  const passB=labelsPass(session,passA.topology,crops);
  passB.label_reads[0].evidence_crop_id=block.crop_id;
  const merged=ctx.mergeTwoStageScan(passA,passB,crops,session),read=merged.transitions[0].rules[0];
  assert.equal(read.crop_id,line.crop_id);assert.equal(read.ai_line_id,'line-1');
  assert.equal(read.cropped_image_segment_url,block.image_url);
  assert.equal(read.pixel_provenance.row_image_url,line.image_url);
  assert.equal(read.pixel_provenance.evidence_valid,true);
  assert.equal(read.scan_incomplete,true,'context recovery remains reviewable, never silently approved');
  const rule=ctx.aiRuleFromPayload(read);
  assert.equal(rule.scanEvidence.pixel_provenance.evidence_crop_id,block.crop_id);
  passB.label_reads[0].bbox={x:-.1,y:.2,w:.4,h:.3};
  const malformed=ctx.mergeTwoStageScan(passA,passB,crops,session).transitions[0].rules[0];
  assert.equal(malformed.pixel_provenance.evidence_valid,false,'display-oriented bbox clamping must not validate OCR coordinates');
  assert.equal(malformed.pixel_provenance.original_bbox,null);
  passB.label_reads[0].evidence_crop_id=crops.find(c=>c.kind==='state_label').crop_id;
  const invalid=ctx.mergeTwoStageScan(passA,passB,crops,session).transitions[0].rules[0];
  assert.equal(invalid.pixel_provenance.evidence_valid,false);
  assert.equal(invalid.cropped_image_segment_url,line.image_url,'foreign image never presented as supporting this rule');
  assert.equal(invalid.scan_incomplete,true);
});

test('one physical arrow keeps three independently keyed rows, including identical visible rules', () => {
  const ctx = loadClient();
  const session = 'two-stage-three-lines';
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1', { is_accepting: true })];
  const connector = topologyConnector('arrow-3', 'connector-3', 'state-0', 'state-1', ['line-1', 'line-2', 'line-3']);
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops); // כל שלוש הקריאות זהות בכוונה
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  assert.equal(merged.transitions[0].rules.length, 3);
  assert.deepEqual(Array.from(merged.transitions[0].rules, r => r.ai_line_id), ['line-1', 'line-2', 'line-3']);
  assert.equal(new Set(merged.transitions[0].rules.map(r => r.raw_label_text)).size, 1);

  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session });
  assert.equal(ctx.__getCurrent().transitions.length, 1);
  assert.equal(ctx.__getCurrent().transitions[0].rules.length, 3, 'אין dedup לפי טקסט זהה');
});

test('missing, duplicate, and foreign label crops remain unresolved and cannot execute', () => {
  for (const mode of ['missing', 'duplicate', 'foreign', 'foreign-extra']) {
    const ctx = loadClient();
    const session = `two-stage-${mode}`;
    const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1', { is_accepting: true })];
    const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
    const passA = topologyPass(session, states, [connector]);
    const crops = materializedCropManifest(ctx, passA, session);
    const lineCrop = crops.find(c => c.kind === 'line');
    let reads = [];
    if (mode === 'duplicate') {
      const read = topologyLabelRead(lineCrop, { scan_session_id: session });
      reads = [read, Object.assign({}, read)];
    } else if (mode === 'foreign') {
      reads = [topologyLabelRead(Object.assign({}, lineCrop, { crop_id: 'foreign-crop' }), { scan_session_id: session })];
    } else if (mode === 'foreign-extra') {
      reads = [topologyLabelRead(lineCrop, { scan_session_id: session }),
        topologyLabelRead(Object.assign({}, lineCrop, { crop_id: 'foreign-crop' }), { scan_session_id: session })];
    }
    const passB = labelsPass(session, passA.topology, crops);
    passB.label_reads = reads;
    const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
    assert.ok(merged.unresolved_label_reads.length >= 1, `${mode}: נשמר unresolved audit`);
    assert.equal(merged.transitions[0].rules[0].scan_incomplete, true);

    silenceClientUi(ctx);
    pdaModel(ctx, [], []);
    ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session });
    const model = ctx.__getCurrent();
    assert.equal(ctx.pdaApplicable(model.states.find(s => s.label === 'q0').id, 0, ['A', '⊥'], 'a').length, 0, `${mode}: אין כלל runnable`);
    assert.equal(ctx.hasPendingAiExecutionReview(), true);
  }
});

test('line-count mismatch blocks every row without inventing the missing line', () => {
  const ctx = loadClient();
  const session = 'two-stage-count-mismatch';
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1', { is_accepting: true })];
  const connector = topologyConnector('arrow-count', 'connector-count', 'state-0', 'state-1', ['line-1', 'line-2'], { visible_line_count: 3 });
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const merged = ctx.mergeTwoStageScan(passA, labelsPass(session, passA.topology, crops), crops, session);
  assert.equal(merged.transitions[0].rules.length, 2, 'לא נוצרה שורה שלישית מומצאת');
  assert.ok(merged.transitions[0].rules.every(r => r.scan_incomplete));
  assert.equal(merged.transitions[0].scan_incomplete, true);
});

test('Pass B cannot overwrite topology endpoints and an attempted overwrite is review-only', () => {
  const ctx = loadClient();
  const session = 'two-stage-endpoint-authority';
  const states = [
    topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1'), topologyState('state-2', 'q2', { is_accepting: true }),
  ];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const alteredTopology = JSON.parse(JSON.stringify(passA.topology));
  alteredTopology.connectors[0].target_observation_id = 'state-2';
  const passB = labelsPass(session, alteredTopology, crops, crop => topologyLabelRead(crop, {
    scan_session_id: session, source_observation_id: 'state-2', target_observation_id: 'state-2',
  }));
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  assert.equal(merged.transitions[0].source_state.observation_id, 'state-0');
  assert.equal(merged.transitions[0].target_state.observation_id, 'state-1');
  assert.equal(merged.transitions[0].rules[0].scan_incomplete, true);
  assert.match(merged.scan_issues.join(' | '), /ניסה לשנות endpoints/);
});

test('unknown and duplicate state labels stay as physical unresolved observations', () => {
  const ctx = loadClient();
  const session = 'two-stage-state-labels';
  const states = [
    topologyState('state-0', '', { is_start: true }),
    topologyState('state-1', '', { is_accepting: true }),
    topologyState('state-2', ''),
  ];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  passB.state_label_reads = crops.filter(c => c.kind === 'state_label').map(crop => {
    if (crop.observation_id === 'state-0' || crop.observation_id === 'state-1') {
      return topologyStateLabelRead(crop, 'q0', { scan_session_id: session });
    }
    return topologyStateLabelRead(crop, '?', { scan_session_id: session, confidence: 0.35, scan_incomplete: true, issues: ['unreadable'] });
  });
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session });
  const model = ctx.__getCurrent();
  assert.equal(model.states.length, 3, 'כל עיגול פיזי נשאר מצב canvas נפרד');
  assert.deepEqual(Array.from(model.states, s => s.label).sort(), ['?', 'q0', 'q0']);
  assert.equal(new Set(model.states.map(s => s.id)).size, 3, 'תוויות זהות אינן זהות פנימית');
  assert.deepEqual(Array.from(model.unresolvedStateObservations, x => x.observationId).sort(), ['state-0', 'state-1', 'state-2']);
  assert.equal(model.transitions.length, 1, 'הטופולוגיה מצוירת לפי observation_id גם כשהתוויות דורשות ביקורת');
  const transition = model.transitions[0];
  assert.equal(model.states.find(s => s.id === transition.from).aiObservationIds[0], 'state-0');
  assert.equal(model.states.find(s => s.id === transition.to).aiObservationIds[0], 'state-1');
  assert.equal(transition.scanIncomplete, true, 'החץ מוצג אך אינו runnable עד פתרון התוויות');
  assert.equal((model.unresolvedScanTransitions || []).length, 0, 'endpoints הפיזיים אינם הולכים לאיבוד בגלל label כפול');
});

test('unreadable state labels still render separate physical circles and their connector by observation id', () => {
  const ctx = loadClient();
  const session = 'two-stage-unreadable-physical-topology';
  const states = [
    topologyState('circle-left', '', { bbox: { x: 0.08, y: 0.2, w: 0.16, h: 0.18 }, is_start: true }),
    topologyState('circle-right', '', { bbox: { x: 0.7, y: 0.2, w: 0.16, h: 0.18 }, is_accepting: true }),
  ];
  const connector = topologyConnector('physical-arrow', 'physical-connector', 'circle-left', 'circle-right', ['line']);
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  passB.state_label_reads = crops.filter(c => c.kind === 'state_label').map(crop =>
    topologyStateLabelRead(crop, '', { scan_session_id: session, confidence: 0.2, scan_incomplete: true, issues: ['unreadable'] }));
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session });
  const model = ctx.__getCurrent();
  assert.equal(model.states.length, 2);
  assert.deepEqual(Array.from(model.states, s => s.label), ['?', '?']);
  assert.equal(new Set(model.states.map(s => s.id)).size, 2);
  assert.deepEqual(Array.from(model.states, s => s.aiObservationIds[0]).sort(), ['circle-left', 'circle-right']);
  assert.equal(model.transitions.length, 1);
  assert.equal(model.states.find(s => s.id === model.transitions[0].from).aiObservationIds[0], 'circle-left');
  assert.equal(model.states.find(s => s.id === model.transitions[0].to).aiObservationIds[0], 'circle-right');
  assert.equal(model.transitions[0].selfLoop, false,
    'שתי תוויות לא־קריאות זהות אינן הופכות שני עיגולים פיזיים שונים ללולאה עצמית');
  assert.equal(ctx.hasPendingAiExecutionReview(), true);
});

test('stale persisted selfLoop flags never override distinct endpoint identities', () => {
  const ctx = loadClient();
  const model = { transitions: [
    { id: 'stale-non-loop', from: 'left', to: 'right', selfLoop: true },
    { id: 'stale-loop', from: 'same', to: 'same', selfLoop: false },
  ] };
  ctx.normalizeTransitionTopology(model);
  assert.equal(model.transitions[0].selfLoop, false);
  assert.equal(model.transitions[1].selfLoop, true);
  model.transitions[0].selfLoop = true;
  assert.equal(ctx.isSelfLoopTransition(model.transitions[0]), false,
    'runtime/render geometry ignores a stale serialized flag');
  assert.equal(ctx.isSelfLoopTransition(model.transitions[1]), true);
});

test('state observation resolver renames a placeholder or explicitly merges it without losing topology', async () => {
  const ctx = loadClient();
  const session = 'two-stage-state-resolver';
  const states = [topologyState('circle-left', '', { is_start: true }), topologyState('circle-right', '', { is_accepting: true })];
  const connector = topologyConnector('physical-arrow', 'physical-connector', 'circle-left', 'circle-right', ['line']);
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  passB.state_label_reads = crops.filter(c => c.kind === 'state_label').map(crop =>
    topologyStateLabelRead(crop, '?', { scan_session_id: session, confidence: 0.2, scan_incomplete: true }));
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session });
  const model = ctx.__getCurrent();
  const leftIndex = model.unresolvedStateObservations.findIndex(x => x.observationId === 'circle-left');
  let wrap = { innerHTML: '', querySelector: selector => ({ value: selector === '#unresolvedStateLabel' ? 'left' : '' }) };
  ctx.document.createElement = () => wrap;
  vm.runInContext('_buildDialog=o=>Promise.resolve(o.buttons[1].value);', ctx);
  ctx.resolveUnresolvedStateObservation(leftIndex);
  await Promise.resolve(); await Promise.resolve();
  const left = model.states.find(s => s.label === 'left');
  assert.ok(left && left.labelManuallyReviewed);
  assert.equal(model.states.length, 2);
  assert.equal(model.states.find(s => s.id === model.transitions[0].from).label, 'left');

  const rightIndex = model.unresolvedStateObservations.findIndex(x => x.observationId === 'circle-right');
  wrap = { innerHTML: '', querySelector: selector => ({ value: selector === '#unresolvedStateMerge' ? left.id : '' }) };
  ctx.document.createElement = () => wrap;
  ctx.resolveUnresolvedStateObservation(rightIndex);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(model.states.length, 1, 'מיזוג קורה רק בעקבות הבחירה המפורשת');
  assert.deepEqual(Array.from(model.states[0].aiObservationIds).sort(), ['circle-left', 'circle-right']);
  assert.equal(model.transitions[0].from, model.states[0].id);
  assert.equal(model.transitions[0].to, model.states[0].id);
  assert.equal(model.unresolvedStateObservations.length, 0);
});

test('state-label Pass B may set only visible_label and cannot overwrite Pass A state topology', () => {
  const ctx = loadClient();
  const session = 'two-stage-state-authority';
  const states = [
    topologyState('state-0', '', { bbox: { x: 0.08, y: 0.12, w: 0.2, h: 0.2 }, is_start: true, is_accepting: false }),
    topologyState('state-1', '', { bbox: { x: 0.7, y: 0.12, w: 0.2, h: 0.2 }, is_start: false, is_accepting: true }),
  ];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  passB.state_label_reads = crops.filter(c => c.kind === 'state_label').map(crop => topologyStateLabelRead(crop,
    crop.observation_id === 'state-0' ? 'q0' : 'q1', {
      scan_session_id: session, bbox: { x: 0, y: 0, w: 1, h: 1 }, is_start: false, is_accepting: true,
    }));
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  const q0 = merged.states.find(s => s.observation_id === 'state-0');
  const q1 = merged.states.find(s => s.observation_id === 'state-1');
  assert.equal(q0.visible_label, 'q0');
  assert.equal(q1.visible_label, 'q1');
  assert.deepEqual(JSON.parse(JSON.stringify(q0.bbox)), states[0].bbox);
  assert.equal(q0.is_start, true);
  assert.equal(q0.is_accepting, false);
  assert.equal(q1.is_start, false);
  assert.equal(q1.is_accepting, true);
  assert.equal(q0.scan_incomplete, true, 'ניסיון שינוי טופולוגיה נשמר לביקורת וחוסם');
  assert.match(q0.issues.join(' | '), /רק visible_label הותר/);
  assert.equal(merged.transitions[0].scan_incomplete, true);
});

test('state topology requires separate start and accepting confidences and does not rely on circle confidence', () => {
  const ctx = loadClient();
  const session = 'two-stage-state-field-confidence';
  const state = topologyState('state-0', '', { is_start: true, is_accepting: false });
  delete state.is_start_confidence;
  state.is_accepting_confidence = 0.4;
  const passA = topologyPass(session, [state], []);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  passB.state_label_reads = [topologyStateLabelRead(crops.find(c => c.kind === 'state_label'), 'q0', { scan_session_id: session })];
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  assert.equal(merged.states[0].confidence, 0.95, 'ביטחון העיגול עצמו גבוה');
  assert.equal(merged.states[0].scan_incomplete, true);
  assert.match(merged.states[0].issues.join(' | '), /is_start חסר או נמוך/);
  assert.match(merged.states[0].issues.join(' | '), /is_accepting חסר או נמוך/);
  assert.equal(merged.states[0].state_topology_evidence.is_start.confidence, null);
  assert.equal(merged.states[0].state_topology_evidence.is_accepting.confidence, 0.4);
});

test('state-label crop keeps the inner hint but captures the full circle with broad original-frame context', () => {
  const ctx = loadClient();
  const session = 'two-stage-state-inner-crop';
  const state = topologyState('state-0', '', { bbox: { x: 0.2, y: 0.3, w: 0.2, h: 0.25 } });
  const passA = topologyPass(session, [state], []);
  const crop = Array.from(ctx.buildTwoStageCropSpecs(passA, session).specs).find(c => c.kind === 'state_label');
  assert.equal(crop.derived_from_state_bbox, true);
  assert.equal(crop.state_bbox.x, state.bbox.x);
  assert.equal(crop.state_bbox.y, state.bbox.y);
  assert.ok(Math.abs(crop.state_bbox.w - state.bbox.w) < 1e-12);
  assert.ok(Math.abs(crop.state_bbox.h - state.bbox.h) < 1e-12);
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(crop.source_bbox[key] - state.bbox[key]) < 1e-12, `source_bbox.${key} נשמר`);
  }
  assert.ok(crop.inner_label_bbox.x > state.bbox.x && crop.inner_label_bbox.y > state.bbox.y);
  assert.ok(crop.inner_label_bbox.w < state.bbox.w && crop.inner_label_bbox.h < state.bbox.h);
  assert.equal(crop.padding, 0.025);
  const padded = ctx.paddedScanBBox(crop.source_bbox, crop.padding).bbox;
  assert.ok(padded.x < state.bbox.x && padded.y < state.bbox.y);
  assert.ok(padded.w > state.bbox.w && padded.h > state.bbox.h);
  assert.match(crop.crop_notes.join(' | '), /כל עיגול המצב/);
  assert.equal(crop.bbox_audit.issues.length, 0, 'גזירה תקינה היא audit note ולא שגיאה שחוסמת הרצה');
});

test('line crops use anisotropic baseline-safe padding and keep wider block context separately', () => {
  const ctx = loadClient();
  const session = 'two-stage-wide-line-crop';
  const states = [topologyState('state-0', ''), topologyState('state-1', '')];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
  const passA = topologyPass(session, states, [connector]);
  const specs = Array.from(ctx.buildTwoStageCropSpecs(passA, session).specs);
  const line = specs.find(c => c.kind === 'line');
  const context = specs.find(c => c.kind === 'label_block');
  assert.ok(line.padding.x >= 0.04 && line.padding.x <= 0.06);
  assert.ok(line.padding.y >= 0 && line.padding.y <= 0.015);
  const padded = ctx.paddedScanBBox(line.source_bbox, line.padding).bbox;
  assert.ok(padded.w > line.source_bbox.w);
  assert.ok(padded.h <= line.source_bbox.h + 0.031, 'primary crop אינו בולע שורות שכנות');
  assert.ok(context.target_line_bboxes_in_context.some(x => x.line_id === 'line' && x.bbox));
  const contextBox=ctx.paddedScanBBox(context.source_bbox,context.padding).bbox;
  assert.ok(contextBox.y<=context.source_bbox.y-.029,
    'context retains the top of tilted handwritten words');
  assert.ok(contextBox.y+contextBox.h>=context.source_bbox.y+context.source_bbox.h+.029,
    'context retains an operand or wrapped Hebrew word below the baseline');
  assert.equal(specs.filter(c=>c.kind==='line').length,1,
    'additional context is not an invented second rule');
  assert.equal(line.expanded_horizontally_from_line_bbox, true);
  assert.ok(line.source_bbox.x <= connector.label_block_bbox.x);
  assert.ok(line.source_bbox.x + line.source_bbox.w >= connector.label_block_bbox.x + connector.label_block_bbox.w,
    'primary row keeps the complete horizontal label block so a Hebrew ACTION is not clipped');
  assert.ok(line.target_line_bbox_in_crop && line.target_line_bbox_in_crop.w < 1,
    'the original localized baseline remains separately mapped inside the expanded crop');
  assert.match(line.crop_notes.join(' | '), /baseline/);
});

test('document framing detects a bright notebook band but safely keeps an already tight frame', () => {
  const ctx = loadClient();
  const image = (w, h, fill) => {
    const p = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { p[i * 4] = fill; p[i * 4 + 1] = fill; p[i * 4 + 2] = fill; p[i * 4 + 3] = 255; }
    return p;
  };
  const w = 200, h = 240, cluttered = image(w, h, 65);
  for (let y = 60; y < 205; y++) for (let x = 8; x < 194; x++) {
    const i = (y * w + x) * 4; cluttered[i] = 238; cluttered[i + 1] = 240; cluttered[i + 2] = 244;
  }
  const framed = ctx.detectDocumentCropFromPixels(cluttered, w, h);
  assert.equal(framed.applied, true);
  assert.ok(framed.bbox.y > 0.1 && framed.bbox.y < 0.3);
  assert.ok(framed.bbox.h < 0.8, 'irrelevant background above and below the page is removed');

  const alreadyTight = ctx.detectDocumentCropFromPixels(image(w, h, 245), w, h);
  assert.equal(alreadyTight.applied, false);
  assert.deepEqual(JSON.parse(JSON.stringify(alreadyTight.bbox)), { x: 0, y: 0, w: 1, h: 1 });
});

test('self-loop context retains the owning circle and displaced label without changing primary rows', () => {
  const ctx=loadClient(),session='loop-label-context';
  const state=topologyState('loop-state','',{bbox:{x:.76,y:.32,w:.08,h:.05}});
  const loop=topologyConnector('loop','loop-connector','loop-state','loop-state',['row'],{
    connector_bbox:{x:.80,y:.37,w:.08,h:.10},
    label_block_bbox:{x:.82,y:.43,w:.08,h:.047},
    line_hints:[{line_id:'row',bbox:{x:.82,y:.43,w:.08,h:.047}}],
  });
  const before=JSON.stringify(loop);
  const plan=ctx.buildTwoStageCropSpecs(topologyPass(session,[state],[loop]),session);
  const context=plan.specs.find(s=>s.kind==='label_block'),line=plan.specs.find(s=>s.kind==='line');
  assert.ok(context.source_bbox.y<=.32);
  assert.ok(context.source_bbox.y+context.source_bbox.h>=.477-1e-9);
  assert.match(context.crop_notes.join(' '),/LOCAL_LOOP_CONTEXT/);
  const near=(a,b)=>{for(const k of ['x','y','w','h'])assert.ok(Math.abs(a[k]-b[k])<1e-9,`bbox.${k}`);};
  near(context.label_block_bbox,loop.label_block_bbox);
  near(line.line_bbox,loop.line_hints[0].bbox);
  assert.equal(plan.specs.filter(s=>s.kind==='line').length,1,'context does not invent rules');
  assert.equal(JSON.stringify(loop),before,'source topology is immutable');
  const expected=ctx.scanBBoxRelativeToCrop(loop.line_hints[0].bbox,ctx.paddedScanBBox(context.source_bbox,context.padding).bbox);
  assert.deepEqual(JSON.parse(JSON.stringify(context.target_line_bboxes_in_context[0].bbox)),JSON.parse(JSON.stringify(expected)));
  const ordinary=Object.assign({},loop,{target_observation_id:'other'});
  near(ctx.scanLabelContextSource(ordinary,[state]).bbox,loop.label_block_bbox);
});

test('shaded page margins cannot be cropped automatically; framing requires explicit opt-in', async () => {
  const ctx = loadClient(), w=200, h=240;
  const pixels = new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    // One continuous page: its shaded left quarter is darker than the heuristic.
    const light=y>=40&&y<210 ? (x<55?160:235) : 60;
    pixels.set([light,light,light,255],(y*w+x)*4);
  }
  const unsafe = ctx.detectDocumentCropFromPixels(pixels,w,h);
  assert.equal(unsafe.applied,true);
  assert.ok(unsafe.bbox.x>.2,'reproduces the brightness heuristic losing real left-margin ink');
  let detections=0;
  ctx.detectDocumentCrop=()=>{detections++;return unsafe;};
  ctx.FileReader=class {readAsDataURL(){this.result='input';this.onload();}};
  ctx.Image=class {constructor(){this.width=w;this.height=h;}set src(v){this.onload();}};
  const draws=[];
  ctx.document.createElement=()=>({getContext:()=>({fillRect(){},drawImage(...args){draws.push(args.slice(1));},
    getImageData:()=>({data:new Uint8ClampedArray(pixels)}),putImageData(){}}),toDataURL:()=> 'data:image/png;base64,AA=='});
  const full=await ctx.downscaleImage({},2400,.92);
  assert.equal(detections,0,'no speculative cropping in the default path');
  assert.equal(full.normalization.applied,false);
  assert.deepEqual(JSON.parse(JSON.stringify(full.normalization.bbox)),{x:0,y:0,w:1,h:1});
  assert.ok(draws.every(args=>args[0]===0&&args[1]===0&&args[2]===w&&args[3]===h),
    'every topology/OCR/preview image includes all source margins');
  const proposed=await ctx.downscaleImage({},2400,.92,{enableDocumentCrop:true});
  assert.equal(detections,1);
  assert.equal(proposed.normalization.applied,true,'proposal remains available for explicit review');
  const disabled=await ctx.downscaleImage({},2400,.92,{enableDocumentCrop:true,disableDocumentCrop:true});
  assert.equal(disabled.normalization.applied,false,'explicit disable wins');
  assert.equal(detections,1);
});

test('stacked line crops do not overlap, while ambiguous state/foreign-line collisions are preserved as blocking issues', () => {
  const ctx = loadClient();
  const session = 'two-stage-line-collision-gate';
  const states = [
    topologyState('state-0', '', { bbox: { x: 0.08, y: 0.15, w: 0.12, h: 0.12 } }),
    topologyState('state-1', '', { bbox: { x: 0.8, y: 0.15, w: 0.12, h: 0.12 } }),
  ];
  const multi = topologyConnector('multi', 'connector-multi', 'state-0', 'state-1', ['row-1', 'row-2', 'row-3'], {
    line_hints: [
      { line_id: 'row-1', bbox: { x: 0.3, y: 0.20, w: 0.28, h: 0.018 } },
      { line_id: 'row-2', bbox: { x: 0.3, y: 0.244, w: 0.28, h: 0.018 } },
      { line_id: 'row-3', bbox: { x: 0.3, y: 0.289, w: 0.28, h: 0.018 } },
    ],
    label_block_bbox: { x: 0.28, y: 0.18, w: 0.34, h: 0.15 },
  });
  const foreign = topologyConnector('foreign', 'connector-foreign', 'state-0', 'state-1', ['foreign-row'], {
    line_hints: [{ line_id: 'foreign-row', bbox: { x: 0.31, y: 0.245, w: 0.27, h: 0.018 } }],
    label_block_bbox: { x: 0.29, y: 0.225, w: 0.32, h: 0.07 },
  });
  const passA = topologyPass(session, states, [multi, foreign]);
  const plan = ctx.buildTwoStageCropSpecs(passA, session);
  const rows = Array.from(plan.specs).filter(c => c.kind === 'line' && c.transition_id === 'multi');
  const padded = rows.map(r => ctx.paddedScanBBox(r.source_bbox, r.padding).bbox);
  assert.equal(ctx.scanBBoxOverlapRatio(padded[0], padded[1]), 0, 'baseline cap keeps row 1/2 apart');
  assert.equal(ctx.scanBBoxOverlapRatio(padded[1], padded[2]), 0, 'baseline cap keeps row 2/3 apart');
  assert.ok(rows.find(r => r.line_id === 'row-2').crop_geometry_issues.some(x => /שורת תווית פיזית אחרת/.test(x)), 'foreign overlapping line is not trusted');

  const crops = materializedCropManifest(ctx, passA, session);
  const merged = ctx.mergeTwoStageScan(passA, labelsPass(session, passA.topology, crops), crops, session);
  assert.equal(merged.transitions.find(t => t.transition_id === 'multi').rules.find(r => r.ai_line_id === 'row-2').scan_incomplete, true);
});

test('two-stage canvas positions come from Pass A circle centers and numeric labels do not trigger relayout', () => {
  const ctx = loadClient();
  const session = 'two-stage-state-geometry';
  const states = [
    topologyState('state-0', '', { bbox: { x: 0.78, y: 0.68, w: 0.14, h: 0.14 }, is_start: true }),
    topologyState('state-1', '', { bbox: { x: 0.08, y: 0.12, w: 0.14, h: 0.14 }, is_accepting: true }),
  ];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  passB.state_label_reads = crops.filter(c => c.kind === 'state_label').map(crop => topologyStateLabelRead(crop,
    crop.observation_id === 'state-0' ? 'q0' : 'q1', { scan_session_id: session }));
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session });
  const q0 = ctx.__getCurrent().states.find(s => s.label === 'q0');
  const q1 = ctx.__getCurrent().states.find(s => s.label === 'q1');
  assert.equal(q0.aiTopologyPosition, true);
  assert.equal(q1.aiTopologyPosition, true);
  assert.ok(q0.x > q1.x && q0.y > q1.y, 'סדר מרכזי העיגולים נשמר ולא הוחלף בפריסת q0→q1');
  const size = ctx.aiScanImageSize(merged, {}) || { width: 1000, height: 680 };
  const sourceRatio = (0.7 * size.width) / (0.56 * size.height);
  assert.ok(Math.abs((q0.x - q1.x) / (q0.y - q1.y) - sourceRatio) < 0.02, 'יחס הצירים של המקור נשמר');
  assert.equal(q0.scanPositionEvidence.bbox.x, states[0].bbox.x);
});

test('bbox normalization clamps the frame and handles inverse coordinates with an audit trail', () => {
  const ctx = loadClient();
  const inverse = ctx.normalizeScanBBox({ x1: 0.8, y1: 0.7, x2: 0.2, y2: 0.1 });
  assert.equal(inverse.valid, true);
  assert.equal(inverse.inverted, true);
  assert.deepEqual({ x: inverse.bbox.x, y: inverse.bbox.y, w: inverse.bbox.w, h: inverse.bbox.h }, { x: 0.2, y: 0.1, w: 0.6000000000000001, h: 0.6 });
  assert.match(inverse.issues.join(' | '), /הפוכות/);

  const clamped = ctx.normalizeScanBBox({ x: -0.2, y: 0.9, w: 0.7, h: 0.4 });
  assert.equal(clamped.valid, true);
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.bbox.x, 0);
  assert.equal(clamped.bbox.y + clamped.bbox.h, 1);
  assert.match(clamped.issues.join(' | '), /הודק/);
});

test('atomic two-stage rescan archives the whole prior scan and replaces moved endpoints without ghosts', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1'), topologyState('state-2', 'q2', { is_accepting: true })];
  const applySession = (session, connectors) => {
    const passA = topologyPass(session, states, connectors);
    const crops = materializedCropManifest(ctx, passA, session);
    const passB = labelsPass(session, passA.topology, crops);
    const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
    ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session, sessionEvidence: { scanSessionId: session, passA, passB, crops } });
  };
  applySession('atomic-1', [
    topologyConnector('stable-arrow', 'connector-stable', 'state-0', 'state-1', ['line-stable']),
    topologyConnector('old-only-arrow', 'connector-old', 'state-1', 'state-2', ['line-old']),
  ]);
  assert.equal(ctx.__getCurrent().transitions.length, 2);
  applySession('atomic-2', [topologyConnector('stable-arrow', 'connector-stable', 'state-0', 'state-2', ['line-stable'])]);
  const model = ctx.__getCurrent();
  assert.equal(model.transitions.length, 1, 'חץ שלא הופיע בסריקה החדשה אינו נשאר ghost');
  assert.equal(model.transitions[0].aiTransitionId, 'stable-arrow');
  assert.equal(model.transitions[0].to, model.states.find(s => s.label === 'q2').id);
  assert.ok(model.scanEvidenceHistory.some(h => h.transitionId === 'old-only-arrow'));
  assert.ok(model.scanEvidenceHistory.some(h => h.transitionId === 'stable-arrow' && h.to === model.states.find(s => s.label === 'q1').id));
  assert.deepEqual(Array.from(model.aiScanSessions, x => x.scanSessionId), ['atomic-1', 'atomic-2']);
});

test('atomic rescan removes disappeared scan-owned states but preserves reviewed states', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  const applyStates = (session, states) => {
    const passA = topologyPass(session, states, []);
    const crops = materializedCropManifest(ctx, passA, session);
    const merged = ctx.mergeTwoStageScan(passA, labelsPass(session, passA.topology, crops), crops, session);
    ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session });
  };
  applyStates('state-scan-1', [
    topologyState('state-0', 'q0', { is_start: true }),
    topologyState('state-1', 'q1'),
    topologyState('state-2', 'q2', { is_accepting: true }),
    topologyState('state-reviewed', 'manual-review'),
  ]);
  const model = ctx.__getCurrent();
  const reviewed = model.states.find(s => s.aiObservationIds.includes('state-reviewed'));
  reviewed.manuallyReviewed = true;
  const stableIds = new Map(model.states.map(s => [s.aiObservationIds[0], s.id]));

  applyStates('state-scan-2', [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1')]);
  assert.deepEqual(Array.from(model.states, s => s.aiObservationIds[0]).sort(), ['state-0', 'state-1', 'state-reviewed']);
  assert.equal(model.states.find(s => s.aiObservationIds.includes('state-0')).id, stableIds.get('state-0'));
  assert.equal(model.states.find(s => s.aiObservationIds.includes('state-1')).id, stableIds.get('state-1'));
  assert.equal(model.states.find(s => s.aiObservationIds.includes('state-reviewed')).id, reviewed.id);
  assert.ok(model.scanStateEvidenceHistory.some(h => h.observationIds.includes('state-2') && /disappeared/.test(h.reason)));
});

test('reused observation id archives an unreviewed label change and never overwrites a reviewed label silently', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  const applyOne = (session, label) => {
    const passA = topologyPass(session, [topologyState('same-circle', label, { is_start: true })], []);
    const crops = materializedCropManifest(ctx, passA, session);
    const merged = ctx.mergeTwoStageScan(passA, labelsPass(session, passA.topology, crops), crops, session);
    ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session });
  };
  applyOne('label-scan-1', 'q0');
  const model = ctx.__getCurrent();
  const internalId = model.states[0].id;
  applyOne('label-scan-2', 'q9');
  assert.equal(model.states.length, 1);
  assert.equal(model.states[0].id, internalId);
  assert.equal(model.states[0].label, 'q9');
  assert.ok(model.scanStateEvidenceHistory.some(h => h.label === 'q0' && /תווית אחרת/.test(h.reason)));

  model.states[0].manuallyReviewed = true;
  model.states[0].labelManuallyReviewed = true;
  applyOne('label-scan-3', 'q7');
  assert.equal(model.states[0].label, 'q9', 'reviewed label נשמר');
  const unresolved = model.unresolvedStateObservations.find(x => x.observationId === 'same-circle');
  assert.ok(unresolved);
  assert.match(unresolved.reason, /נשמרה התווית הידנית/);
  assert.equal(unresolved.canvasStateId, internalId);
  assert.equal(model.states[0].latestScanStateEvidence.visible_label, 'q7', 'הקריאה החדשה נשמרת כראיה ולא נעלמת');
});

test('clearGraphData clears graph plus all scan sessions, unresolved evidence, and archives', () => {
  const ctx = loadClient();
  const model = pdaModel(ctx, [{ id: 't', from: 'q2', to: 'q3', rules: [] }]);
  Object.assign(model, {
    aiScanIssues: ['issue'], unresolvedLabelReads: [{}], unresolvedScanTransitions: [{}], unresolvedStateObservations: [{}],
    scanEvidenceHistory: [{}], scanStateEvidenceHistory: [{}], unresolvedScanTransitionHistory: [{}], unresolvedStateObservationHistory: [{}],
    aiScanSessions: [{ scanSessionId: 'old' }], activeAiScanSessionId: 'old', aiReviewDismissed: true,
  });
  ctx.clearGraphData();
  for (const field of ['states', 'transitions', 'aiScanIssues', 'unresolvedLabelReads', 'unresolvedScanTransitions', 'unresolvedStateObservations',
    'scanEvidenceHistory', 'scanStateEvidenceHistory', 'unresolvedScanTransitionHistory', 'unresolvedStateObservationHistory', 'aiScanSessions']) {
    assert.deepEqual(Array.from(model[field]), [], `${field} נוקה`);
  }
  assert.equal(model.activeAiScanSessionId, '');
  assert.equal(model.aiReviewDismissed, false);
});

test('visible connector count 8 versus 7 observations/connectors creates an unresolved placeholder and blocks all arrows', () => {
  const ctx = loadClient();
  const session = 'two-stage-connector-count';
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1', { is_accepting: true })];
  const connectors = Array.from({ length: 7 }, (_, i) => topologyConnector(`arrow-${i}`, `connector-${i}`, 'state-0', 'state-1', [`line-${i}`]));
  const passA = topologyPass(session, states, connectors);
  passA.topology.visible_connector_count = 8;
  const crops = materializedCropManifest(ctx, passA, session);
  const merged = ctx.mergeTwoStageScan(passA, labelsPass(session, passA.topology, crops), crops, session);
  assert.equal(merged.transitions.length, 7, 'לא הומצא connector שמיני');
  assert.ok(merged.unresolved_label_reads.some(x => x.kind === 'missing_connector'));
  assert.ok(merged.transitions.every(t => t.rules.every(r => r.scan_incomplete)));
  assert.match(merged.scan_issues.join(' | '), /נספרו 8 connectors/);
});

test('four overlapping topology-audit tiles cover the full frame and preserve inverse coordinate mapping', () => {
  const ctx = loadClient();
  const specs = Array.from(ctx.buildTopologyAuditTileSpecs('tile-session').specs);
  assert.equal(specs.length, 4);
  assert.deepEqual(specs.map(s => s.tile_index), [0, 1, 2, 3]);
  assert.deepEqual(specs.map(s => JSON.parse(JSON.stringify(s.original_bbox))), [
    { x: 0, y: 0, w: 0.6, h: 0.6 }, { x: 0.4, y: 0, w: 0.6, h: 0.6 },
    { x: 0, y: 0.4, w: 0.6, h: 0.6 }, { x: 0.4, y: 0.4, w: 0.6, h: 0.6 },
  ]);
  assert.ok(ctx.scanBBoxOverlapRatio(specs[0].original_bbox, specs[1].original_bbox) > 0.3, 'left/right tiles overlap');
  assert.ok(ctx.scanBBoxOverlapRatio(specs[0].original_bbox, specs[2].original_bbox) > 0.3, 'top/bottom tiles overlap');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.topologyTileBBoxToOriginal(specs[3], { x: 0, y: 0, w: 0.5, h: 0.5 }))),
    { x: 0.4, y: 0.4, w: 0.3, h: 0.3 });
  for (const corner of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
    assert.ok(specs.some(s => corner[0] >= s.original_bbox.x && corner[0] <= s.original_bbox.x + s.original_bbox.w &&
      corner[1] >= s.original_bbox.y && corner[1] <= s.original_bbox.y + s.original_bbox.h), `frame point ${corner} covered`);
  }
});

test('topology audit adds close state neighbourhoods for faint self-loops and start markers', () => {
  const ctx = loadClient();
  const passA = { topology: { states: [
    { observation_id: 's0', bbox: { x: 0.1, y: 0.2, w: 0.08, h: 0.1 } },
    { observation_id: 's1', bbox: { x: 0.7, y: 0.6, w: 0.09, h: 0.11 } },
  ] } };
  const specs = Array.from(ctx.buildTopologyAuditTileSpecs('state-neighbourhoods', passA).specs);
  assert.equal(specs.length, 6);
  assert.deepEqual(specs.map(s => s.tile_index), [0, 1, 2, 3, 4, 5]);
  assert.ok(specs.slice(4).every(s => s.crop_id.includes('topology-state-neighbourhood') && s.image_role === 'ink_same_frame_crop'));
  assert.ok(specs[4].original_bbox.x < 0.1 && specs[4].original_bbox.y < 0.2);
});

test('one failed optional state-neighbourhood crop cannot cancel the four valid topology audit tiles', async () => {
  const ctx = loadClient();
  vm.runInContext(`materializeTwoStageCrops=async (_original,plan)=>plan.specs.map(s=>Object.assign({},s,{
    image_url:String(s.crop_id||'').includes('topology-state-neighbourhood')?'':'data:crop',
    crop_bbox:s.source_bbox,original_size:{width:1000,height:700},issues:[]
  }));`, ctx);
  const requests = [];
  const states = [topologyState('state-0', '', { is_start: true }), topologyState('state-1', '')];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.stage === 'topology') return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, states, [connector])) };
    if (body.stage === 'topology-audit') return { ok: true, text: async () => JSON.stringify(topologyAuditPass(body.scan_session_id, body.topology)) };
    return { ok: true, text: async () => JSON.stringify(labelsPass(body.scan_session_id, body.topology, body.crops)) };
  };
  const result = await ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink', 'original'] }, 'pda', fakeFetch);
  assert.deepEqual(requests.map(row => row.stage), ['topology', 'topology-audit', 'labels']);
  assert.equal(requests[1].crops.length, 4, 'only the four valid broad tiles are sent');
  assert.ok(requests[1].crops.every(row => String(row.crop_id).startsWith('topology-tile:') && row.image_url));
  assert.equal(result.topologyAuditTiles.length, 6, 'failed optional crops remain preserved as evidence');
});

test('topology audit retries the original frame when the ink-frame crops cannot be loaded', async () => {
  const ctx = loadClient();
  vm.runInContext(`materializeTwoStageCrops=async (original,plan)=>plan.specs.map(s=>Object.assign({},s,{
    image_url:original==='ink'?'':'data:original-crop',crop_bbox:s.source_bbox,original_size:{width:1000,height:700},
    issues:original==='ink'?['ink crop failed']:[]
  }));`, ctx);
  const requests = [];
  const states = [topologyState('state-0', '', { is_start: true }), topologyState('state-1', '')];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.stage === 'topology') return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, states, [connector])) };
    if (body.stage === 'topology-audit') return { ok: true, text: async () => JSON.stringify(topologyAuditPass(body.scan_session_id, body.topology)) };
    return { ok: true, text: async () => JSON.stringify(labelsPass(body.scan_session_id, body.topology, body.crops)) };
  };
  const result = await ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink', 'original'] }, 'pda', fakeFetch);
  assert.deepEqual(requests.map(row=>row.stage), ['topology', 'topology-audit', 'labels']);
  assert.ok(requests[1].crops.every(row=>row.image_url==='data:original-crop'&&row.image_role==='original_same_frame_crop'));
  assert.ok(result.topologyAuditTiles.every(row=>(row.crop_notes||[]).some(note=>note.includes('retried from original_same_frame'))));
});

test('topology audit corrections replace the label-crop topology but remain review-only until human approval', async () => {
  const ctx = loadClient();
  vm.runInContext(`materializeTwoStageCrops=async (original,plan)=>{ globalThis.__auditExactOriginal=original; return plan.specs.map(s=>Object.assign({},s,{image_url:'data:crop',image_role:'original_same_frame_crop',crop_bbox:s.source_bbox,original_size:{width:1200,height:800},issues:s.crop_geometry_issues||[]})); };`, ctx);
  const requests = [];
  const states = [topologyState('state-0', '', { is_start: true }), topologyState('state-1', ''), topologyState('state-2', '', { is_accepting: true })];
  const base = topologyConnector('base-arrow', 'base-connector', 'state-0', 'state-1', ['base-line']);
  const correctedConnectors = [
    base,
    topologyConnector('missing-self-loop', 'loop-connector', 'state-2', 'state-2', ['loop-line'], {
      label_block_bbox: { x: 0.68, y: 0.55, w: 0.2, h: 0.08 }, line_hints: [{ line_id: 'loop-line', bbox: { x: 0.69, y: 0.57, w: 0.18, h: 0.035 } }],
    }),
    topologyConnector('leftward-bottom', 'left-connector', 'state-2', 'state-1', ['left-line'], {
      label_block_bbox: { x: 0.38, y: 0.72, w: 0.25, h: 0.08 }, line_hints: [{ line_id: 'left-line', bbox: { x: 0.4, y: 0.74, w: 0.22, h: 0.035 } }],
    }),
  ];
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.stage === 'topology') return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, states, [base])) };
    if (body.stage === 'topology-audit') {
      const corrected = topologyPass(body.scan_session_id, states, correctedConnectors).topology;
      return { ok: true, text: async () => JSON.stringify(topologyAuditPass(body.scan_session_id, corrected, {
        topology_audit: { changed: true, failed: false },
      })) };
    }
    const response = labelsPass(body.scan_session_id, body.topology, body.crops);
    response.state_label_reads = body.crops.filter(c => c.kind === 'state_label').map(c => topologyStateLabelRead(c,
      c.observation_id === 'state-0' ? 'q0' : (c.observation_id === 'state-1' ? 'q1' : 'q2'), { scan_session_id: body.scan_session_id }));
    return { ok: true, text: async () => JSON.stringify(response) };
  };
  const result = await ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink', 'exact-original'] }, 'pda', fakeFetch);
  assert.deepEqual(requests.map(r => r.stage), ['topology', 'topology-audit', 'labels']);
  assert.equal(ctx.__auditExactOriginal, 'exact-original', 'label OCR preserves notebook-rule colour from the aligned original frame');
  assert.equal(requests[2].topology.connectors.length, 3, 'labels use audited topology');
  assert.ok(requests[2].topology.connectors.some(c => c.transition_id === 'missing-self-loop' && c.source_observation_id === c.target_observation_id));
  assert.ok(requests[2].topology.connectors.some(c => c.transition_id === 'leftward-bottom' && c.source_observation_id === 'state-2' && c.target_observation_id === 'state-1'));
  assert.equal(result.initialPassA.topology.connectors.length, 1);
  assert.equal(result.passA.topology.connectors.length, 3);
  assert.equal(result.passA.review_only, true);
  assert.equal(result.payload.transitions.length, 3);
  assert.ok(result.payload.transitions.every(t => t.scan_incomplete && t.rules.every(r => r.scan_incomplete)), 'audit-created topology cannot run silently');
  assert.equal(result.sessionEvidence.topologyAuditTiles.length, 7, 'four broad tiles plus one neighbourhood per state');
  assert.equal(result.sessionEvidence.topologyAuditResponse.topology_audit.changed, true);
});

test('topology-audit failure preserves initial topology and avoids paid label OCR on unreliable crops', async () => {
  const ctx = loadClient();
  vm.runInContext(`materializeTwoStageCrops=async (_original,plan)=>plan.specs.map(s=>Object.assign({},s,{image_url:'data:crop',crop_bbox:s.source_bbox,original_size:{width:1000,height:700},issues:[]}));`, ctx);
  const stages = [];
  const states = [topologyState('state-0', '', { is_start: true }), topologyState('state-1', '', { is_accepting: true })];
  const connector = topologyConnector('initial-arrow', 'initial-connector', 'state-0', 'state-1', ['initial-line']);
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body); stages.push(body.stage);
    if (body.stage === 'topology') return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, states, [connector])) };
    if (body.stage === 'topology-audit') throw new Error('audit unavailable');
    return { ok: true, text: async () => JSON.stringify(labelsPass(body.scan_session_id, body.topology, body.crops)) };
  };
  const result = await ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink', 'original'] }, 'pda', fakeFetch);
  assert.deepEqual(stages, ['topology', 'topology-audit']);
  assert.equal(result.passA.review_only, true);
  assert.equal(result.passA.topology.connectors[0].transition_id, 'initial-arrow');
  assert.equal(result.topologyAuditResponse.topology_audit.failed, true);
  assert.match(result.passA.issues.join(' | '), /audit unavailable/);
  assert.equal(result.payload.transitions.length, 1);
  assert.equal(result.payload.transitions[0].scan_incomplete, true);
  assert.equal(result.sessionEvidence.initialPassA.topology.connectors[0].transition_id, 'initial-arrow');
  assert.match(result.passB.stage_error, /קריאת התוויות לא הופעלה/);
  assert.equal(result.passB.label_reads.length, 0);
});

test('two-stage orchestrator uses all aligned frames, state-neighbourhood audit tiles, and original-colour label crops', async () => {
  const ctx = loadClient();
  vm.runInContext(`materializeTwoStageCrops=async (original,plan)=>{ globalThis.__cropOriginal=original; return plan.specs.map(s=>Object.assign({},s,{image_url:'data:crop',image_role:'original_same_frame_crop',crop_bbox:s.source_bbox,original_size:{width:1000,height:700},issues:[]})); };`, ctx);
  const requests = [];
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.stage === 'topology') {
      const states = [topologyState('state-0', '', { is_start: { value: true, confidence: 0.95 }, is_start_confidence: null,
        is_accepting: { value: false, confidence: 0.95 }, is_accepting_confidence: null }),
        topologyState('state-1', '', { is_start: { value: false, confidence: 0.95 }, is_start_confidence: null,
          is_accepting: { value: true, confidence: 0.95 }, is_accepting_confidence: null })];
      const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
      return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, states, [connector])) };
    }
    if (body.stage === 'topology-audit') {
      return { ok: true, text: async () => JSON.stringify(topologyAuditPass(body.scan_session_id, body.topology)) };
    }
    const lineCrop = body.crops.find(c => c.kind === 'line');
    const stateCrops = body.crops.filter(c => c.kind === 'state_label');
    return { ok: true, text: async () => JSON.stringify({
      stage: 'labels', scan_session_id: body.scan_session_id, topology: body.topology,
      crop_manifest: body.crops,
      label_reads: [topologyLabelRead(lineCrop, { scan_session_id: body.scan_session_id })],
      state_label_reads: stateCrops.map(crop => topologyStateLabelRead(crop, crop.observation_id === 'state-0' ? 'q0' : 'q1', { scan_session_id: body.scan_session_id })),
    }) };
  };
  const result = await ctx.runTwoStageDiagramScan({ images: ['enhanced-frame', 'ink-frame', 'original-frame'], label: 'label-frame', preview: 'preview-frame' }, 'pda', fakeFetch);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].stage, 'topology');
  assert.deepEqual(requests[0].images, ['enhanced-frame', 'ink-frame', 'original-frame']);
  assert.deepEqual(requests[0].image_roles, ['enhanced_same_frame', 'ink_same_frame', 'original_same_frame']);
  assert.equal(ctx.__cropOriginal, 'label-frame');
  assert.equal(requests[1].stage, 'topology-audit');
  assert.deepEqual(requests[1].images, ['original-frame']);
  assert.deepEqual(requests[1].image_roles, ['original_same_frame']);
  assert.equal(requests[1].crops.length, 6);
  assert.ok(requests[1].crops.every(c => c.kind === 'topology_tile' && c.image_url === 'data:crop'));
  assert.ok(requests[1].crops.every(c => c.source_bbox &&
    JSON.stringify(c.source_bbox) === JSON.stringify(c.original_bbox) &&
    JSON.stringify(c.source_bbox) === JSON.stringify(c.crop_bbox)),
  'topology-audit request preserves the exact same-frame source mapping required by targeted trace');
  assert.equal(requests[2].stage, 'labels');
  assert.ok(requests[2].crops.some(c => c.kind === 'label_block'));
  assert.ok(requests[2].crops.some(c => c.kind === 'line' && c.image_url === 'data:crop'));
  assert.equal(requests[2].crops.filter(c => c.kind === 'state_label').length, 2);
  assert.ok(requests[2].crops.filter(c => c.kind === 'state_label').every(c => c.derived_from_state_bbox && c.inner_label_bbox));
  assert.deepEqual(Array.from(result.payload.states, s => s.visible_label), ['q0', 'q1']);
  assert.equal(result.payload.transitions.length, 1);
});

test('legacy two-image scan keeps an explicit original fallback and uses it for colour-preserving labels', async () => {
  const ctx = loadClient();
  vm.runInContext(`materializeTwoStageCrops=async (original,plan)=>{ globalThis.__fallbackCropOriginal=original; return plan.specs.map(s=>Object.assign({},s,{image_url:'data:crop',image_role:'original_same_frame_crop',crop_bbox:s.source_bbox,issues:[]})); };`, ctx);
  const requests = [];
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.stage === 'topology') {
      return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, [topologyState('state-0', '', { is_start: true })], [])) };
    }
    if (body.stage === 'topology-audit') return { ok: true, text: async () => JSON.stringify(topologyAuditPass(body.scan_session_id, body.topology)) };
    const stateCrop = body.crops.find(c => c.kind === 'state_label');
    return { ok: true, text: async () => JSON.stringify({
      stage: 'labels', scan_session_id: body.scan_session_id, topology: body.topology, crop_manifest: body.crops, label_reads: [],
      state_label_reads: [topologyStateLabelRead(stateCrop, 'q0', { scan_session_id: body.scan_session_id })],
    }) };
  };
  await ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink'], preview: 'normalized-original-fallback' }, 'pda', fakeFetch);
  assert.equal(requests[0].images[2], 'normalized-original-fallback');
  assert.equal(requests[0].image_roles[2], 'original_same_frame');
  assert.equal(ctx.__fallbackCropOriginal, 'normalized-original-fallback');
});

test('a Stage B failure returns Pass A as blocked review evidence instead of discarding topology', async () => {
  const ctx = loadClient();
  vm.runInContext(`materializeTwoStageCrops=async (_original,plan)=>plan.specs.map(s=>Object.assign({},s,{image_url:'data:crop',crop_bbox:s.source_bbox,issues:[]}));`, ctx);
  let calls = 0;
  const fakeFetch = async (_url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    if (body.stage === 'topology') {
      const states = [topologyState('state-0', '', { is_start: true }), topologyState('state-1', '', { is_accepting: true })];
      const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
      return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, states, [connector])) };
    }
    if (body.stage === 'topology-audit') return { ok: true, text: async () => JSON.stringify(topologyAuditPass(body.scan_session_id, body.topology)) };
    throw new Error('label service unavailable');
  };
  const result = await ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink', 'original'], preview: 'preview' }, 'pda', fakeFetch);
  assert.equal(calls, 3);
  assert.equal(result.passA.stage, 'topology');
  assert.equal(result.passB.review_only, true);
  assert.match(result.passB.issues.join(' | '), /label service unavailable/);
  assert.equal(result.payload.states.length, 2, 'שתי תצפיות העיגולים נשמרו');
  assert.ok(result.payload.states.every(s => s.scan_incomplete));
  assert.equal(result.payload.transitions.length, 1);
  assert.ok(result.payload.transitions[0].rules.every(r => r.scan_incomplete));
  assert.equal(result.sessionEvidence.passA.stage, 'topology');
});

test('abort between topology and labels rejects without producing a late merge or model mutation', async () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [], [{ id: 'manual', label: 'manual', isStart: true, isAccept: false, x: 10, y: 20 }]);
  vm.runInContext(`materializeTwoStageCrops=async (_original,plan)=>plan.specs.map(s=>Object.assign({},s,{image_url:'data:crop',crop_bbox:s.source_bbox,issues:[]}));`, ctx);
  const controller = new AbortController();
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (opts.signal && opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const states = [topologyState('state-0', '', { is_start: true })];
    if (body.stage === 'topology-audit') return { ok: true, text: async () => JSON.stringify(topologyAuditPass(body.scan_session_id, body.topology)) };
    return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, states, [])) };
  };
  await assert.rejects(ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink', 'original'] }, 'pda', fakeFetch, {
    signal: controller.signal,
    onStage: stage => { if (stage === 'labels') controller.abort(); },
  }), error => error && error.name === 'AbortError');
  assert.deepEqual(Array.from(ctx.__getCurrent().states, s => s.label), ['manual']);
  assert.equal(ctx.__getCurrent().transitions.length, 0);
});

test('abort during topology-audit preserves initial Pass A evidence without mutating the model', async () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [], [{ id: 'manual', label: 'manual', isStart: true, isAccept: false, x: 10, y: 20 }]);
  vm.runInContext(`materializeTwoStageCrops=async (_original,plan)=>plan.specs.map(s=>Object.assign({},s,{image_url:'data:crop',crop_bbox:s.source_bbox,issues:[]}));`, ctx);
  const controller = new AbortController();
  const initialStates = [topologyState('state-0', '', { is_start: true })];
  const fakeFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.stage === 'topology') {
      return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, initialStates, [])) };
    }
    assert.equal(body.stage, 'topology-audit');
    assert.equal(opts.signal.aborted, true);
    const error = new Error('aborted during audit'); error.name = 'AbortError'; throw error;
  };
  let caught;
  try {
    await ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink', 'original'] }, 'pda', fakeFetch, {
      signal: controller.signal,
      onStage: stage => { if (stage === 'topology-audit') controller.abort(); },
    });
  } catch (error) { caught = error; }
  assert.equal(caught && caught.name, 'AbortError');
  assert.equal(caught.scanSessionEvidence.stage, 'topology-audit-aborted');
  assert.equal(caught.scanSessionEvidence.initialPassA.topology.states[0].observation_id, 'state-0');
  assert.equal(caught.scanSessionEvidence.topologyAuditTiles.length, 5);
  assert.deepEqual(Array.from(ctx.__getCurrent().states, s => s.label), ['manual']);
  assert.equal(ctx.__getCurrent().transitions.length, 0);
});

test('two-stage orchestrator preserves Pass A when no valid line crop can be produced', async () => {
  const ctx = loadClient();
  vm.runInContext(`materializeTwoStageCrops=async (_original,plan)=>plan.specs.map(s=>Object.assign({},s,{
    image_url:s.kind==='topology_tile'?'data:crop':'',crop_bbox:s.source_bbox,original_size:{width:1000,height:700},issues:s.kind==='topology_tile'?[]:['crop failed']
  }));`, ctx);
  let calls = 0;
  const fakeFetch = async (_url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    const states = [topologyState('state-0', '', { is_start: true, scan_incomplete: true })];
    const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-0', ['line']);
    if (body.stage === 'topology-audit') return { ok: true, text: async () => JSON.stringify(topologyAuditPass(body.scan_session_id, body.topology)) };
    return { ok: true, text: async () => JSON.stringify(topologyPass(body.scan_session_id, states, [connector])) };
  };
  const result = await ctx.runTwoStageDiagramScan({ images: ['enhanced', 'ink', 'original'], preview: 'preview' }, 'pda', fakeFetch);
  assert.equal(calls, 2, 'ביקורת הטופולוגיה מתבצעת, אך אין קריאת labels חסרת crops שהשרת היה דוחה');
  assert.equal(result.passA.stage, 'topology');
  assert.equal(result.passB.review_only, true);
  assert.equal(result.payload.transitions[0].rules[0].scan_incomplete, true);
  assert.match(result.payload.scan_issues.join(' | '), /state\/line crop/);
});

test('Pass B label-read count is derived from a 14-line manifest and never from a fixture constant', () => {
  const ctx = loadClient();
  const session = 'dynamic-fourteen';
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1', { is_accepting: true })];
  const lineIds = Array.from({ length: 14 }, (_, i) => `line-${i}`);
  const lineHints = lineIds.map((line_id, i) => ({ line_id, bbox: { x: 0.3, y: 0.08 + i * 0.045, w: 0.32, h: 0.025 } }));
  const connector = topologyConnector('arrow-14', 'connector-14', 'state-0', 'state-1', lineIds, {
    visible_line_count: 14,
    line_hints: lineHints,
    label_block_bbox: { x: 0.28, y: 0.06, w: 0.38, h: 0.64 },
    physical_line_fragments: Array.from({ length: 18 }, (_, i) => ({ fragment_id: `fragment-${i}` })),
    line_group_lineage: lineIds.map((line_id, i) => ({ line_id, source_fragment_ids: [`fragment-${i}`] })),
  });
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  passB.label_reads = passB.label_reads.slice(0, 12);
  passB.issues = ['Returned exactly 7 state_label_reads and exactly 12 label_reads, matching the manifest kind counts.'];

  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  assert.match(merged.scan_issues.join(' | '), /12 label_reads עבור 14 kind=line crops/);
  assert.match(merged.scan_issues.join(' | '), /טענת Pass B.*דווח 12.*התקבלו 12.*נדרשו 14/);
  assert.doesNotMatch(merged.scan_issues.join(' | '), /exactly 12 label_reads/i);
  assert.deepEqual(Array.from(merged.two_stage_evidence.raw_pass_b_issues), passB.issues,
    'טענת הספירה החופשית נשמרת כראיה גולמית אך אינה הופכת לעובדה נגזרת');
  assert.equal(merged.transitions[0].rules.length, 14, 'שורות חסרות הופכות placeholder ואינן נמחקות');
  const savedConnector = merged.two_stage_evidence.pass_a.topology.connectors[0];
  assert.equal(savedConnector.physical_line_fragments.length, 18, 'כל 18 המקטעים הפיזיים נשמרים בראיה');
  assert.equal(savedConnector.line_group_lineage.length, 14, 'lineage ל-14 השורות הלוגיות נשמר');
});

test('merge deduplicates derived issue lists while retaining the raw audit issue trail', () => {
  const ctx = loadClient();
  const session = 'issue-dedupe';
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1', { is_accepting: true })];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line']);
  const passA = topologyPass(session, states, [connector], { issues: [' repeated   blocker ', 'repeated blocker'], review_only: true });
  passA.topology.issues = ['repeated blocker'];
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops, crop => topologyLabelRead(crop, {
    scan_session_id: session,
    field_notes: [' local   issue ', 'local issue'],
    issues: ['local issue'],
  }));
  passB.issues = ['repeated blocker'];

  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  assert.equal(merged.scan_issues.filter(x => ctx.scanIssueKey(x) === 'repeated blocker').length, 1);
  const ruleNotes = merged.transitions[0].rules[0].field_notes;
  assert.equal(ruleNotes.filter(x => ctx.scanIssueKey(x) === 'local issue').length, 1);
  assert.equal(merged.transitions[0].rules[0].raw_audit_issues.field_notes.length, 2,
    'הערות השורה המקוריות נשמרות לפני dedupe');
  assert.ok(merged.two_stage_evidence.raw_merge_issues.length > merged.scan_issues.length,
    'הכפילויות נשארות בשובל הראיות הגולמי אף שאינן מוצגות שוב ושוב');
  assert.equal(merged.transitions[0].scan_incomplete, true, 'dedupe אינו משנה את gate הביקורת');
});

test('scan-wide failures block execution without being copied into every local transition editor', () => {
  const ctx = loadClient();
  const session = 'global-versus-local-issues';
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1')];
  const connector = topologyConnector('arrow-local', 'connector-local', 'state-0', 'state-1', ['line-local']);
  const passA = topologyPass(session, states, [connector], {
    issues: ['final topology transition trans_9 has no arrowhead match'], review_only: true,
  });
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops, crop => topologyLabelRead(crop, {
    scan_session_id: session, field_notes: ['local ACTION is unreadable'], issues: ['local ACTION is unreadable'],
  }));
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  const transition = merged.transitions[0], notes = transition.rules[0].field_notes.join(' | ');
  assert.equal(transition.scan_incomplete, true, 'global review still blocks execution');
  assert.match(merged.scan_issues.join(' | '), /trans_9/);
  assert.match(notes, /local ACTION is unreadable/);
  assert.doesNotMatch(notes, /trans_9/, 'an unrelated global connector id is not shown as a q0→q1-local problem');
  assert.match(notes, /אזהרות כלליות בסריקה/);
  assert.ok(transition.global_scan_issue_count > 0);
});

test('a local self-loop assertion cannot override different immutable endpoints', () => {
  const ctx = loadClient();
  const session = 'topology-contradiction';
  const states = [topologyState('state-0', 'q0', { is_start: true }), topologyState('state-1', 'q1', { is_accepting: true })];
  const connector = topologyConnector('arrow', 'connector', 'state-0', 'state-1', ['line'], { issues: ['self-loop'] });
  const passA = topologyPass(session, states, [connector]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);

  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  const transition = merged.transitions[0];
  assert.equal(transition.source_state.observation_id, 'state-0');
  assert.equal(transition.target_state.observation_id, 'state-1');
  assert.equal(transition.field_notes.includes('self-loop'), false, 'הטענה הסותרת אינה מוצגת כאמת טופולוגית');
  assert.match(transition.field_notes.join(' | '), /סתירה בראיית audit מקומית/);
  assert.deepEqual(Array.from(transition.topology_evidence.raw_local_issues.connector), ['self-loop']);
  assert.equal(transition.topology_evidence.local_issue_contradictions[0].code, 'LOCAL_SELF_LOOP_CONTRADICTS_ENDPOINTS');
  assert.equal(transition.scan_incomplete, true);
  assert.equal(transition.rules[0].scan_incomplete, true, 'הסתירה עדיין חוסמת עד ביקורת');
  const missingEndpoint = ctx.reconcileLocalTopologyIssues(['self-loop'], '', 'state-1');
  assert.equal(missingEndpoint.contradictions.length, 0, 'endpoint חסר אינו מספיק כדי להמציא סתירה');
  assert.deepEqual(Array.from(missingEndpoint.issues), ['self-loop']);
});

test('portrait photo keeps its aspect ratio so vertically stacked states do not collide on the canvas', () => {
  const ctx = loadClient();
  const session = 'portrait-layout';
  // מרכזי עיגולים כמו בצילום פורטרט 900×1600: q6 מתחת ל-q0 ו-q1 מימינו, בערך באותו מרחק
  const states = [
    topologyState('state-0', '', { bbox: { x: 0.054, y: 0.215, w: 0.08, h: 0.057 } }),
    topologyState('state-1', '', { bbox: { x: 0.068, y: 0.340, w: 0.08, h: 0.05 } }),
    topologyState('state-2', '', { bbox: { x: 0.275, y: 0.205, w: 0.08, h: 0.05 } }),
  ];
  const passA = topologyPass(session, states, [topologyConnector('arrow', 'connector', 'state-0', 'state-2', ['line'])]);
  const crops = materializedCropManifest(ctx, passA, session);
  const passB = labelsPass(session, passA.topology, crops);
  const labels = { 'state-0': 'q0', 'state-1': 'q6', 'state-2': 'q1' };
  passB.state_label_reads = crops.filter(c => c.kind === 'state_label').map(crop =>
    topologyStateLabelRead(crop, labels[crop.observation_id], { scan_session_id: session }));
  const merged = ctx.mergeTwoStageScan(passA, passB, crops, session);
  silenceClientUi(ctx);
  pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas(merged, { atomic: true, scanSessionId: session,
    sessionEvidence: { imageNormalization: { normalized_size: { width: 900, height: 1600 } } } });
  const byLabel = label => ctx.__getCurrent().states.find(s => s.label === label);
  const q0 = byLabel('q0'), q6 = byLabel('q6'), q1 = byLabel('q1');
  assert.ok(Math.hypot(q0.x - q6.x, q0.y - q6.y) >= 4 * 40 - 1, 'מצבים רחוקים בדף אינם מתנגשים על הקנבס');
  assert.ok(q6.y - q0.y > Math.abs(q6.x - q0.x), 'q6 נשאר מתחת ל-q0');
  const sourceRatio = ((0.275 + 0.04 - 0.054 - 0.04) * 900) / ((0.340 + 0.025 - 0.215 - 0.0285) * 1600);
  assert.ok(Math.abs((q1.x - q0.x) / (q6.y - q0.y) - sourceRatio) < 0.05,
    'המרחק האופקי q0→q1 והאנכי q0→q6 שומרים על היחס שבצילום (במיפוי הישן היחס היה ~2.7)');
  assert.equal(q0.scanPositionEvidence.layout, 'aspect-preserving');
});

test('review panel separates actionable items from technical diagnostics and names the specific state doubt', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const model = pdaModel(ctx, [], [
    { id: 'a', label: 'q0', isStart: false, isAccept: true, aiLow: true, aiImported: true,
      aiIssues: ['topology contract is review-only', 'is_start.confidence is below review threshold'],
      scanStateEvidence: { is_start_confidence: 0.48, is_accepting_confidence: 0.9 } },
    { id: 'b', label: 'q6', isStart: false, isAccept: false, aiLow: true, aiImported: true,
      aiIssues: ['topology contract is review-only', 'Possible second ring is faint'],
      scanStateEvidence: { is_start: { value: false, confidence: 0.9 }, is_accepting: { value: false, confidence: 0.4 } } },
    { id: 'c', label: 'q1', isStart: false, isAccept: false, aiLow: true, aiImported: true,
      aiIssues: ['topology contract is review-only'], scanStateEvidence: { is_start_confidence: 0.95, is_accepting_confidence: 0.93 } },
  ]);
  model.aiScanIssues = ['geometric inventory count 11 does not match 10', 'לא זוהה חץ התחלה; לא נבחר מצב התחלתי אוטומטית'];

  const items = Array.from(ctx.collectAiReviewItems());
  const start = items.find(x => x.kind === 'start');
  assert.ok(start && !start.diagnostic, 'היעדר מצב התחלתי הוא פריט פעולה ולא אבחון');
  assert.equal(items.filter(x => x.diagnostic).length, 1);
  const states = items.filter(x => x.kind === 'state');
  assert.deepEqual(states.map(x => x.title), ['q0', 'q6', 'q1'], 'מצבים עם ספק ספציפי מופיעים ראשונים');
  assert.deepEqual(Array.from(states[0].concerns), ['ייתכן שזה המצב ההתחלתי']);
  assert.deepEqual(Array.from(states[1].concerns), ['ייתכן שזה מצב מקבל (עיגול כפול?)']);
  assert.equal(states[2].concerns.length, 0);
  assert.doesNotMatch(states.map(x => x.sub).join(' '), /review-only|confidence is below/, 'הודעות שחוזרות על כל מצב אינן משוכפלות');
  assert.match(states[1].sub, /Possible second ring is faint/, 'ראיה חזותית ספציפית נשמרת');
  assert.equal(ctx.aiIssueCount(), 4);
  assert.equal(ctx.hasPendingAiExecutionReview(), true, 'ההצגה החדשה אינה משחררת את חסימת ההרצה');

  ctx.markStateReviewed('b');
  assert.equal(ctx.aiStateConcerns(model.states[1]).length, 0, 'אחרי אישור אנושי אין עוד ספק פתוח');
  assert.equal(Array.from(ctx.collectAiReviewItems()).some(x => x.kind === 'state' && x.title === 'q6'), false);
  ctx.toggleStart('a');
  assert.equal(Array.from(ctx.collectAiReviewItems()).some(x => x.kind === 'start'), false, 'בחירת מצב התחלתי סוגרת את הפריט');
});

test('review summary deduplicates repeated display warnings but preserves distinct physical blockers', () => {
  const ctx = loadClient();
  const model = pdaModel(ctx, [{
    id: 'arrow', from: 'q2', to: 'q3', rules: [ctx.makeRulePDA('a', 'A', 'push', 'B')],
    aiLow: true, semanticBlocked: false, aiIssues: [' Global   blocker ', 'local warning', 'local  warning'], semanticIssues: [],
  }]);
  model.aiScanIssues = ['Global blocker', ' Global   blocker '];
  const duplicate = { kind: 'label_line', transition_id: 'arrow', line_id: 'line-1', crop_id: 'crop-1', reason: 'missing read', issues: ['missing read'] };
  model.unresolvedLabelReads = [duplicate, JSON.parse(JSON.stringify(duplicate)),
    { kind: 'label_line', transition_id: 'arrow', line_id: 'line-2', crop_id: 'crop-2', reason: 'missing read', issues: ['missing read'] }];
  model.unresolvedStateObservations = [];
  model.unresolvedScanTransitions = [];

  const items = Array.from(ctx.collectAiReviewItems());
  assert.equal(items.filter(x => x.title === 'אזהרת סריקה').length, 1);
  assert.equal(items.filter(x => x.kind === 'label-read').length, 2,
    'כפילות זהה מאוחדת, אך שתי שורות פיזיות שונות נשארות שני blockers');
  const transitionItem = items.find(x => x.kind === 'transition');
  assert.ok(transitionItem);
  assert.doesNotMatch(transitionItem.sub, /Global blocker/i, 'אזהרה גלובלית אינה משוכפלת בכל מעבר');
  assert.equal((transitionItem.sub.match(/local warning/g) || []).length, 1);
  assert.equal(items.find(x => x.title === 'אזהרת סריקה').diagnostic, true, 'אזהרה גלובלית היא אבחון ואינה נספרת לאישור');
  assert.equal(ctx.aiIssueCount(), items.filter(x => !x.diagnostic).length);
  assert.equal(model.aiScanIssues.length, 2, 'הראיות הגולמיות במודל לא נמחקו');
  assert.equal(model.unresolvedLabelReads.length, 3, 'ה-unresolved evidence נשמר במלואו');
});

test('real two-stage import resolves missing rows by their session-qualified identity', () => {
  const ctx=loadClient();silenceClientUi(ctx);pdaModel(ctx,[],[]);
  const session='scan-import-identity';
  const passA=topologyPass(session,[topologyState('s0','q0',{is_start:true}),topologyState('s1','q1')],
    [topologyConnector('transition-1','connector-1','s0','s1',['line-1'])]);
  const crops=materializedCropManifest(ctx,passA,session),passB=labelsPass(session,passA.topology,crops);
  passB.label_reads=[];
  const merged=ctx.mergeTwoStageScan(passA,passB,crops,session);
  ctx.applyAiTransitionsToCanvas(merged,{atomic:true,scanSessionId:session});
  const model=ctx.__getCurrent(),unread=model.unresolvedLabelReads.find(x=>x.kind==='label_line');
  assert.ok(unread);
  const rule=model.transitions[0].rules[0];
  assert.equal(rule.aiLineId,`${session}:line-1`,'exercise the actual imported namespace');
  assert.equal(ctx.unresolvedLabelReadTarget(unread).ruleIndex,0);
  assert.equal(ctx.unresolvedLabelReadSettled(unread),false);
  rule.manuallyReviewed=true;
  assert.equal(ctx.unresolvedLabelReadSettled(unread),true,'reviewing the real placeholder settles its duplicate warning');
  const foreign={...unread,scan_session_id:'other-scan'};
  assert.equal(ctx.unresolvedLabelReadSettled(foreign),false,'another scan cannot settle this observation');
  model.transitions[0].rules.push({...rule});
  assert.equal(ctx.unresolvedLabelReadTarget(unread).ruleIndex,-1,'duplicate identities remain ambiguous');
});

test('an unread label line is settled by reviewing its "?" placeholder rule, not by a dead-end blocker', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const placeholder = Object.assign(ctx.makeRulePDA('?', '?', 'push', '?'), { aiLineId: 'line-1', aiLow: true, scanIncomplete: true });
  const model = pdaModel(ctx, [{ id: 'arrow', aiTransitionId: 'transition_1', from: 'q2', to: 'q3', rules: [placeholder], aiLow: true, scanIncomplete: true }]);
  model.unresolvedLabelReads = [{ kind: 'label_line', transition_id: 'transition_1', line_id: 'line-1', crop_id: 'crop-1', reason: 'קריאת label חסרה לשורה' }];
  model.unresolvedStateObservations = [];
  model.unresolvedScanTransitions = [];

  const item = Array.from(ctx.collectAiReviewItems()).find(x => x.kind === 'label-read');
  assert.ok(item && item.canFocus, 'the blocker points at the placeholder rule it duplicates');
  assert.match(item.title, /q2 → q3/);
  assert.equal(ctx.hasPendingAiExecutionReview(), true);

  // The human fixes the rule in the editor: the rule becomes reviewed and runnable.
  Object.assign(model.transitions[0].rules[0], ctx.makeRulePDA('b', 'A', 'none', ''), { aiLineId: 'line-1', aiLow: false, scanIncomplete: false, manuallyReviewed: true });
  Object.assign(model.transitions[0], { aiLow: false, scanIncomplete: false });
  assert.equal(Array.from(ctx.collectAiReviewItems()).some(x => x.kind === 'label-read'), false, 'the settled read leaves the review list');
  assert.equal(ctx.hasPendingAiExecutionReview(), false, 'running is no longer blocked forever');
  assert.equal(model.unresolvedLabelReads.length, 1, 'the evidence itself is kept');
});

test('reads without a canvas counterpart are closed by an explicit "checked" that archives the evidence', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const model = pdaModel(ctx, []);
  const missing = { kind: 'missing_connector', reason: 'נספר connector פיזי שלא הוחזר כאובייקט; לא הומצא חץ', issues: ['visible connector count mismatch'], placeholder_index: 0 };
  model.unresolvedLabelReads = [missing, JSON.parse(JSON.stringify(missing)),
    { kind: 'state_label', observation_id: 'state_9', crop_id: 'crop-s9', reason: 'unreadable', issues: ['unreadable'] }];
  model.unresolvedStateObservations = [];
  model.unresolvedScanTransitions = [];

  let items = Array.from(ctx.collectAiReviewItems()).filter(x => x.kind === 'label-read');
  assert.equal(items.length, 2, 'identical duplicates show as one card');
  const missingItem = items.find(x => x.title === 'ייתכן שחסר חץ');
  assert.ok(missingItem && !missingItem.canFocus);
  assert.equal(ctx.hasPendingAiExecutionReview(), true);

  ctx.acknowledgeUnresolvedLabelRead(Number(missingItem.id));
  assert.equal(model.unresolvedLabelReads.length, 1, 'both identical duplicates close together');
  assert.equal(model.resolvedLabelReadHistory.length, 2);
  assert.ok(model.resolvedLabelReadHistory.every(x => x.resolution === 'acknowledged' && x.acknowledged_at && x.kind === 'missing_connector'));
  assert.equal(ctx.hasPendingAiExecutionReview(), true, 'the unrelated state-label read still blocks');

  // A state with that physical observation, once its label is reviewed, settles the state-label read.
  model.states.push({ id: 'q9', label: 'q9', x: 0, y: 0, aiObservationIds: ['state_9'], labelManuallyReviewed: true });
  assert.equal(ctx.hasPendingAiExecutionReview(), false);
});

test('a minimized review list stays reachable and reopens by itself when a run is blocked', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const model = pdaModel(ctx, []);
  model.unresolvedLabelReads = [{ kind: 'missing_connector', reason: 'x', issues: ['x'], placeholder_index: 0 }];
  model.unresolvedStateObservations = [];
  model.unresolvedScanTransitions = [];
  ctx.dismissAiReview();
  assert.equal(model.aiReviewDismissed, true);
  assert.equal(ctx.simReady(), false, 'the pending read still blocks running');
  assert.equal(model.aiReviewDismissed, false, 'the blocked run brings the list back');
});

test('fit-to-view uses the largest canvas area not covered by floating panels, and falls back on a crowded screen', () => {
  const ctx = loadClient();
  const rect = (left, top, width, height) => ({ getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) });
  const panels = { controlPanel: rect(1160, 58, 264, 600), aiReviewPanel: rect(808, 64, 340, 378), tabBar: rect(0, 0, 1440, 50) };
  ctx.document.getElementById = id => panels[id] || null;
  ctx.getComputedStyle = () => ({ display: 'block' });
  const wrap = rect(0, 0, 1440, 900);
  assert.deepEqual({ ...ctx.canvasFreeRect(wrap, 1440, 900) }, { x: 0, y: 50, w: 808, h: 850 },
    'left of the review panel and below the tab bar');
  panels.controlPanel = rect(100, 0, 1300, 900);
  assert.deepEqual({ ...ctx.canvasFreeRect(wrap, 1440, 900) }, { x: 0, y: 0, w: 1440, h: 900 },
    'a sliver under 40% is useless, so the whole canvas is used');
});

test('a deterministic PDA with an ε-push loop is rejected quickly instead of exhausting memory', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [{ id: 'loop', from: 'q2', to: 'q2', rules: [ctx.makeRulePDA('', '⊥', 'push', 'A'), ctx.makeRulePDA('', 'A', 'push', 'A')] }]);
  const started = Date.now();
  assert.equal(ctx.pdaAccepts(''), false);
  assert.equal(ctx.pdaAccepts('ab'), false);
  assert.ok(Date.now() - started < 2000, 'the run ends instead of growing the stack 200000 times');
  const s = ctx.simInit('');
  let steps = 0;
  while (s.status === 'running' && steps++ < 10000) ctx.simStepObj(s);
  assert.equal(s.status, 'rejected', 'step-by-step agrees with the quick run');
  assert.match(s.reason, /לולאת ε/);
  assert.ok(steps < 50, 'the stepper detects the loop after a few steps');
});

test('the ε-loop test never rejects a legitimate run of ε-pops that empties a deep stack', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  pdaModel(ctx, [
    { id: 'push', from: 'q2', to: 'q2', rules: [ctx.makeRulePDA('a', '', 'push', 'A')] },
    { id: 'first-pop', from: 'q2', to: 'q4', rules: [ctx.makeRulePDA('b', 'A', 'pop', '', 'A')] },
    { id: 'drain', from: 'q4', to: 'q4', rules: [ctx.makeRulePDA('', 'A', 'pop', '', 'A')] },
    { id: 'done', from: 'q4', to: 'q3', rules: [ctx.makeRulePDA('', '⊥', 'none')] },
  ], [
    { id: 'q2', label: 'q2', isStart: true, isAccept: false },
    { id: 'q4', label: 'q4', isStart: false, isAccept: false },
    { id: 'q3', label: 'q3', isStart: false, isAccept: true },
  ]);
  for (const w of ['ab', 'aaaab', 'aaaaaaaaaaaaaaaaaaab']) {
    assert.equal(ctx.pdaAccepts(w), true, `${w} is accepted by the quick run`);
    const s = ctx.simInit(w);
    let steps = 0;
    while (s.status === 'running' && steps++ < 10000) ctx.simStepObj(s);
    assert.equal(s.status, 'accepted', `${w} is accepted step by step`);
  }
  assert.equal(ctx.pdaAccepts('b'), false);
});

test('the non-deterministic PDA stepper drops revisited configurations, also after stepping back', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const spinning = pdaModel(ctx, [{ id: 'spin', from: 'q2', to: 'q2', rules: [ctx.makeRulePDA('', '⊥', 'none')] }]);
  spinning.ndet = true;
  const s = ctx.simInit('a');
  let steps = 0;
  while (s.status === 'running' && steps++ < 10000) ctx.simStepObj(s);
  assert.equal(s.status, 'rejected', 'a path that only revisits itself ends instead of running 4000 steps');
  assert.match(s.reason, /חזרו לקונפיגורציות שכבר נבדקו/);
  assert.ok(steps < 10);
  assert.equal(ctx.npdaAccepts('a'), false);

  const accepting = pdaModel(ctx, [
    { id: 'push', from: 'q2', to: 'q2', rules: [ctx.makeRulePDA('a', '⊥', 'push', 'A'), ctx.makeRulePDA('', 'A', 'none')] },
    { id: 'pop', from: 'q2', to: 'q3', rules: [ctx.makeRulePDA('b', 'A', 'pop', '', 'A')] },
  ]);
  accepting.ndet = true;
  assert.equal(ctx.npdaAccepts('ab'), true, 'dropping revisits never loses an accepting path');
  vm.runInContext("SIM=simInit('ab'); while(SIM.status==='running')simStepObj(SIM); globalThis.__first=SIM.status;" +
    "simBack(); simBack(); while(SIM.status==='running')simStepObj(SIM); globalThis.__again=SIM.status;", ctx);
  assert.equal(ctx.__first, 'accepted');
  assert.equal(ctx.__again, 'accepted', 'after going back the seen-set is rebuilt and the verdict repeats');
});

test('new states land in free canvas space, at least three radii from every existing state', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const rect = (left, top, width, height) => ({ clientWidth: width, clientHeight: height,
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) });
  const nodes = { canvasArea: rect(0, 0, 1440, 900), controlPanel: rect(1160, 58, 264, 600), tabBar: rect(0, 0, 1440, 50),
    canvas: { setAttribute: () => {} } };
  ctx.document.getElementById = id => nodes[id] || null;
  ctx.getComputedStyle = () => ({ display: 'block' });
  vm.runInContext('view={x:0,y:0,w:1440,h:900}', ctx);
  const model = { type: 'dfa', states: [], transitions: [], tests: [] };
  ctx.__setCurrent(model);
  for (let i = 0; i < 8; i++) ctx.addStateCentered();
  const states = model.states;
  let min = Infinity;
  for (let i = 0; i < states.length; i++) for (let j = i + 1; j < states.length; j++)
    min = Math.min(min, Math.hypot(states[i].x - states[j].x, states[i].y - states[j].y));
  assert.ok(min >= 3 * 40 - 1, `states are at least 3R apart (was 34px before), got ${min}`);
  assert.ok(states.every(s => s.x < 1160 - 40 && s.y > 50 + 40), 'none lands under the control panel or the tab bar');
  assert.deepEqual(states.map(s => s.isStart), [true, false, false, false, false, false, false, false]);
});

test('importing a file without any valid model reports it instead of a success message', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const toasts = [];
  ctx.toast = (message, kind) => toasts.push([message, kind]);
  const before = vm.runInContext('DB.automata.length', ctx);
  ctx.importData({ automata: [{ name: 'broken' }] });
  assert.deepEqual(toasts[0], ['לא נמצאו בקובץ מודלים תקינים', 'danger']);
  assert.equal(vm.runInContext('DB.automata.length', ctx), before);
  ctx.importData({ automata: [{ name: 'ok', type: 'dfa', states: [], transitions: [] }] });
  assert.deepEqual(toasts[1], ['יובא מודל אחד', 'success']);
});

test('the built-in scan sample passes the real import and shows exactly its two intended doubts', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const model = pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas(vm.runInContext('AI_SAMPLE', ctx), { atomic: true, scanSessionId: 'sample' });
  const label = id => model.states.find(s => s.id === id).label;
  const flagged = model.transitions.filter(t => (t.rules || []).some(r => r.aiLow)).map(t => `${label(t.from)}→${label(t.to)}`);
  assert.deepEqual(flagged.sort(), ['q0→q1', 'q2→q2']);
  assert.equal(model.states.filter(s => s.aiLow).length, 0);
  assert.equal(model.states.find(s => s.isStart).label, 'q0');
  assert.deepEqual(model.states.filter(s => s.isAccept).map(s => s.label), ['q8']);
});

test('the folder path in the offline scan message keeps its backslashes', () => {
  const html = fs.readFileSync(path.join(__dirname, 'automata.html'), 'utf8');
  const B = String.fromCharCode(92);
  // Inside the template literal a single backslash is an escape: \U, \i, \D, \m rendered as plain letters.
  assert.ok(html.includes(['C:', 'Users', 'its', 'Documents', 'modeles'].join(B + B)), 'the template literal escapes every backslash');
  assert.ok(!html.includes(['C:', 'Users', 'its', 'Documents', 'modeles'].join(B)), 'no unescaped copy is left');
});

test('unreadable saved data is copied aside before the examples overwrite it', () => {
  const ctx = loadClient();
  const store = new Map([['automata_data_v1', '{"automata":[{"name":"important work"']]);
  ctx.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const realError = console.error;
  console.error = () => {};   // load() logs the expected parse error
  try { ctx.load(); } finally { console.error = realError; }
  const backupKey = vm.runInContext('LOAD_BACKUP_KEY', ctx);
  assert.match(backupKey, /^automata_data_v1_unreadable_\d+$/);
  assert.equal(store.get(backupKey), '{"automata":[{"name":"important work"', 'the raw text is kept exactly');
  assert.equal(vm.runInContext('DB.automata.length', ctx), 0);

  const healthy = loadClient();
  const good = new Map([['automata_data_v1', JSON.stringify({ automata: [{ name: 'ok', type: 'dfa', states: [], transitions: [] }] })]]);
  healthy.localStorage = { getItem: k => (good.has(k) ? good.get(k) : null), setItem: (k, v) => good.set(k, v), removeItem: () => {} };
  healthy.load();
  assert.equal(vm.runInContext('LOAD_BACKUP_KEY', healthy), '', 'readable data makes no backup');
  assert.equal(vm.runInContext('DB.automata.length', healthy), 1);
});

test('renaming a state to a name another state already has is refused', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const toasts = [];
  ctx.toast = (message, kind) => toasts.push([message, kind]);
  const model = { type: 'dfa', states: [{ id: 'a', label: 'q0' }, { id: 'b', label: 'q1' }], transitions: [], tests: [] };
  ctx.__setCurrent(model);
  ctx.renameState('b', 'q0');
  assert.equal(model.states[1].label, 'q1', 'a duplicate name would let label-based scan flows connect the wrong state');
  assert.deepEqual(toasts[0], ['כבר קיים מצב בשם «q0» — בחר שם אחר', 'danger']);
  ctx.renameState('b', '   ');
  assert.equal(model.states[1].label, 'q1', 'an empty name keeps the old one');
  ctx.renameState('b', 'סוף');
  assert.equal(model.states[1].label, 'סוף');
  ctx.renameState('b', 'סוף');
  assert.equal(toasts.length, 1, 'keeping the same name is not a conflict');
});

test('a single Turing-machine rule can be deleted without deleting the whole arrow', async () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  let answer = false;
  vm.runInContext('confirmDialog=()=>Promise.resolve(globalThis.__answer)', ctx);
  const model = { type: 'tm', states: [{ id: 'q0', label: 'q0', isStart: true }, { id: 'q1', label: 'q1', isAccept: true }],
    transitions: [{ id: 't', from: 'q0', to: 'q0', rules: [{ read: '0', write: '1', move: 'R' }, { read: '1', write: '0', move: 'R' }] }], tests: [] };
  ctx.__setCurrent(model);
  ctx.__answer = answer;
  ctx.deleteTmRule('t', 0); await new Promise(r => setTimeout(r, 0));
  assert.equal(model.transitions[0].rules.length, 2, 'cancelling keeps the rule');
  ctx.__answer = true;
  ctx.deleteTmRule('t', 0); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(model.transitions[0].rules.map(r => r.read), ['1'], 'only the chosen rule is removed');
  ctx.deleteTmRule('t', 0); await new Promise(r => setTimeout(r, 0));
  assert.equal(model.transitions.length, 0, 'deleting the last rule removes the empty arrow');
});

test('a blocked run says where the problem is: start state, duplicate transition, TM read, PDA ambiguity', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const toasts = [];
  ctx.toast = (message, kind) => toasts.push(message);
  const st = (id, extra) => Object.assign({ id, label: id, x: 0, y: 0, isStart: false, isAccept: false }, extra);
  const run = model => { ctx.__setCurrent(Object.assign({ tests: [], transitions: [] }, model)); toasts.length = 0; const ok = ctx.simReady(); return { ok, message: toasts[0] || '' }; };

  let r = run({ type: 'dfa', states: [st('q0'), st('q1')] });
  assert.equal(r.ok, false); assert.match(r.message, /אין מצב התחלתי/);
  r = run({ type: 'dfa', states: [st('q0', { isStart: true }), st('q1', { isStart: true })] });
  assert.match(r.message, /2 מצבים התחלתיים \(q0, q1\)/);
  r = run({ type: 'dfa', states: [st('q0', { isStart: true }), st('q1')],
    transitions: [{ id: 'x', from: 'q0', to: 'q0', symbols: ['a'] }, { id: 'y', from: 'q0', to: 'q1', symbols: ['a'] }] });
  assert.match(r.message, /מ-q0 יוצא יותר ממעבר אחד על 'a'/);
  r = run({ type: 'tm', states: [st('q0', { isStart: true }), st('q1')],
    transitions: [{ id: 'x', from: 'q0', to: 'q0', rules: [{ read: '1', write: '0', move: 'R' }] }, { id: 'y', from: 'q0', to: 'q1', rules: [{ read: '1', write: '1', move: 'L' }] }] });
  assert.match(r.message, /במצב q0 יש יותר מכלל אחד עבור הקריאה '1'/);
  r = run({ type: 'pda', ndet: false, states: [st('q0', { isStart: true }), st('q1')],
    transitions: [{ id: 'x', from: 'q0', to: 'q0', rules: [ctx.makeRulePDA('a', '⊥', 'push', 'A')] }, { id: 'y', from: 'q0', to: 'q1', rules: [ctx.makeRulePDA('a', '⊥', 'none')] }] });
  assert.match(r.message, /במצב q0 כמה כללים עשויים להתאים יחד/);
  r = run({ type: 'dfa', states: [st('q0', { isStart: true })], transitions: [{ id: 'x', from: 'q0', to: 'q0', symbols: ['a'] }] });
  assert.equal(r.ok, true, 'a valid machine still runs');
});

test('immediate deletions can be undone, and an undo never rolls back a later change', () => {
  const ctx = loadClient();
  // the real save() runs (the harness storage is a no-op), so the save sequence the undo checks really advances
  vm.runInContext('renderAll=()=>{}; renderGraph=()=>{}; renderInspector=()=>{}; renderTabs=()=>{}; toast=()=>{}; fitView=()=>{}; stopPlay=()=>{}', ctx);
  const model = { id: 'm1', name: 'עבודה', type: 'dfa', tests: [],
    states: [{ id: 'a', label: 'q0', isStart: true }, { id: 'b', label: 'q1', isAccept: true }],
    transitions: [{ id: 't', from: 'a', to: 'b', symbols: ['a'] }] };
  const db = vm.runInContext('DB', ctx);
  db.automata = [model];
  ctx.__setCurrent(model);

  ctx.deleteState('b');
  assert.equal(ctx.__getCurrent().states.length, 1);
  assert.equal(ctx.__getCurrent().transitions.length, 0, 'the state took its transitions with it');
  assert.equal(ctx.undoLast(), true);
  assert.deepEqual(Array.from(ctx.__getCurrent().states, s => s.label), ['q0', 'q1']);
  assert.equal(ctx.__getCurrent().transitions.length, 1, 'undo brings the transitions back too');

  ctx.resetBoard();
  assert.equal(ctx.__getCurrent().states.length, 0);
  assert.equal(ctx.undoLast(), true);
  assert.equal(ctx.__getCurrent().states.length, 2, 'clearing the board is undoable');

  ctx.deleteTransition('t');
  ctx.save();      // any later saved change
  assert.equal(ctx.undoLast(), false, 'a later change blocks the undo instead of being rolled back');
  assert.equal(ctx.__getCurrent().transitions.length, 0);

  const second = { id: 'm2', name: 'שני', type: 'dfa', tests: [], states: [], transitions: [] };
  db.automata.push(second);
  ctx.delAutomaton('m1');
  assert.deepEqual(Array.from(db.automata, a => a.id), ['m2']);
  assert.equal(ctx.undoLast(), true);
  assert.deepEqual(Array.from(db.automata, a => a.id), ['m1', 'm2'], 'the model returns to its place in the tab order');
  assert.equal(ctx.__getCurrent().id, 'm1');
  assert.equal(ctx.undoLast(), false, 'an undo is used once');
});

/* תיקון בצעד אחד של אות קלט שחוזרת: אותו סימן מפוקפק בכמה כללים נשאל פעם אחת. */
function glyphScan(ctx, rows) {
  // rows: [transitionId, from, to, [[read, conf, top], ...]]
  const transitions = rows.map(([id, from, to, rules]) => scannedTransition(id, from, to, rules.map(([read, conf, top]) => scannedRule({
    raw_label_text: `${read},${top} / A דחוף`,
    zones: { left_text: read, middle_text: top, right_text: 'A דחוף' },
    read_input: { value: read, confidence: conf },
    pop_value: { value: top, confidence: 0.9 },
    push_value: { value: 'A', confidence: 0.9 },
    scan_incomplete: true,   // like the real two-stage server: every scanned row is review-only
  }))));
  const model = pdaModel(ctx, [], []);
  ctx.applyAiTransitionsToCanvas({ states: [{ id: 'q0', is_start: true, confidence: 0.95 }, { id: 'q1', confidence: 0.95 }, { id: 'q2', confidence: 0.95 }], transitions },
    { atomic: true, scanSessionId: 'scan-glyph' });
  return model;
}
const ruleOf = (model, from, to, i) => {
  const label = id => model.states.find(s => s.id === id).label;
  return model.transitions.find(t => label(t.from) === from && label(t.to) === to).rules[i];
};

test('a repeated doubtful input glyph is asked once, and one answer fixes only the rules the human left checked', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const model = glyphScan(ctx, [
    ['t01', 'q0', 'q1', [['ε', 0.7, '⊥']]],
    ['t21', 'q2', 'q1', [['ε', 0.78, 'S'], ['ε', 0.7, 'A']]],
    ['t12', 'q1', 'q2', [['b', 0.93, 'A']]],
  ]);
  const groups = Array.from(ctx.inputGlyphGroups());
  assert.equal(groups.length, 1, 'only the repeated ε becomes a question; a single b does not');
  assert.equal(groups[0].symbol, 'ε');
  assert.equal(groups[0].members.length, 3);
  assert.deepEqual(Array.from(ctx.inputGlyphChoices(groups[0])), ['ε', 'b'], 'choices are ε and the letters read on this sheet; anything else is typed');

  const html = ctx.inputGlyphCardHtml(groups[0], 0);
  assert.match(html, /הקלט נקרא «<span dir="ltr">ε<\/span>» ב-3 כללים/);
  assert.equal((html.match(/data-glyph-member=/g) || []).length, 3, 'one checkable image per rule');

  // The q0→q1 glyph is really ε in this test: the human unchecks it and answers "a" for the other two.
  const pick = groups[0].members.map(m => model.transitions.find(x => x.id === m.transitionId).rules[m.ruleIndex] !== ruleOf(model, 'q0', 'q1', 0));
  assert.equal(ctx.applyInputGlyphReview(0, 'a', pick), true);

  for (const i of [0, 1]) {
    const r = ruleOf(model, 'q2', 'q1', i);
    assert.equal(r.read, 'a');
    assert.equal(r.inputReview.value, 'a');
    assert.equal(r.inputReview.original, 'ε');
    assert.equal(r.scanEvidence.structured.read_input, 'ε', 'the original evidence is kept as read');
    assert.match(r.raw_label_text, /^ε,/);
    assert.equal(r.scanIncomplete, true, 'the action word and the stack were not checked, so the rule stays locked');
    assert.equal(r.manuallyReviewed, undefined);
    assert.equal(r.aiIssues.some(x => /האזור השמאלי/.test(x)), false, 'the input doubt itself is closed');
    const ai = ctx.pdaRuleToAi(r);
    assert.equal(ai.read_input.value, 'a');
    assert.equal(ai.read_input.confidence, null, 'the editor no longer flags the human-checked input as low confidence');
    assert.equal(ai.stack_action.confidence, 0.9);
  }
  const untouched = ruleOf(model, 'q0', 'q1', 0);
  assert.equal(untouched.read, '', 'the unchecked image keeps its ε');
  assert.equal(untouched.inputReview, undefined);
  assert.equal(ctx.hasPendingAiExecutionReview(), true);
  assert.equal(Array.from(ctx.inputGlyphGroups()).length, 0, 'a lone remaining ε is no longer a repeated question');
  const t21 = Array.from(ctx.collectAiReviewItems()).find(x => x.kind === 'transition' && x.title === 'q2 → q1');
  assert.match(t21.sub, /קלט אושר בידי אדם \(a, a\)/);
});

test('the glyph question never guesses: confident letters, single reads and bad answers change nothing', () => {
  const ctx = loadClient();
  silenceClientUi(ctx);
  const model = glyphScan(ctx, [
    ['t01', 'q0', 'q1', [['b', 0.92, 'A'], ['b', 0.9, 'S']]],
    ['t12', 'q1', 'q2', [['c', 0.6, 'A']]],
    ['t21', 'q2', 'q1', [['ε', 0.95, 'S'], ['?', 0.2, 'A'], ['?', 0.2, 'S']]],
  ]);
  assert.equal(Array.from(ctx.inputGlyphGroups()).length, 0,
    'confident repeated b, a single doubtful c, a single ε and unreadable "?" are not grouped');

  const second = glyphScan(ctx, [
    ['t01', 'q0', 'q1', [['ε', 0.95, '⊥']]],
    ['t21', 'q2', 'q1', [['ε', 0.96, 'S']]],
  ]);
  assert.equal(Array.from(ctx.inputGlyphGroups()).length, 1, 'a repeated ε is asked even when the model was sure of it');
  const before = JSON.stringify(second.transitions);
  for (const bad of ['', '?', 'ab', '⊥', ',', ' ']) assert.equal(ctx.applyInputGlyphReview(0, bad, [true, true]), false, `answer «${bad}» is refused`);
  assert.equal(ctx.applyInputGlyphReview(0, 'a', [false, false]), false, 'nothing checked → nothing changes');
  assert.equal(ctx.applyInputGlyphReview(0, 'a'), false, 'without a readable selection nothing changes');
  assert.equal(JSON.stringify(second.transitions), before);

  assert.equal(ctx.applyInputGlyphReview(0, 'ε', [true, true]), true, 'confirming ε as read is an answer too');
  assert.ok(second.transitions.every(t => t.rules.every(r => r.read === '' && r.inputReview && r.inputReview.original === 'ε')));
  assert.ok(second.transitions.every(t => t.rules.every(r => r.scanIncomplete)), 'still locked until each rule is confirmed');
  assert.ok(model);
});

test('a glyph answer can be undone, and the final confirmation in the editor keeps its record', () => {
  const ctx = loadClient();
  vm.runInContext('renderAll=()=>{}; renderGraph=()=>{}; renderInspector=()=>{}; renderTabs=()=>{}; toast=()=>{}; fitView=()=>{}; stopPlay=()=>{}', ctx);
  const model = glyphScan(ctx, [['t21', 'q2', 'q1', [['ε', 0.78, 'S'], ['ε', 0.7, 'A']]]]);
  model.id = 'm-glyph';
  vm.runInContext('DB', ctx).automata = [model];

  assert.equal(ctx.applyInputGlyphReview(0, 'a', [true, true]), true);
  assert.equal(ruleOf(ctx.__getCurrent(), 'q2', 'q1', 0).read, 'a');
  assert.equal(ctx.undoLast(), true);
  assert.equal(ruleOf(ctx.__getCurrent(), 'q2', 'q1', 0).read, '', 'undo restores the scanned ε');
  assert.equal(ruleOf(ctx.__getCurrent(), 'q2', 'q1', 0).inputReview, undefined);

  assert.equal(ctx.applyInputGlyphReview(0, 'a', [true, true]), true);
  vm.runInContext('promptTransitionPDA=(f,t,ai,d,opts)=>{ globalThis.__glyphAi=ai; globalThis.__glyphOpts=opts; }', ctx);
  const t = ctx.__getCurrent().transitions[0];
  ctx.editPdaTransition(t.id, 0);
  assert.equal(ctx.__glyphAi.read_input.value, 'a');
  assert.equal(ctx.__glyphAi.inputReview.original, 'ε');
  ctx.__glyphOpts.onSave(ctx.makeRulePDA('a', 'S', 'push', 'A'));
  const saved = ctx.__getCurrent().transitions[0].rules[0];
  assert.equal(saved.manuallyReviewed, true);
  assert.equal(saved.inputReview.value, 'a', 'the group answer stays on record after the full rule is confirmed');
  assert.equal(saved.scanEvidence.structured.read_input, 'ε');
});
