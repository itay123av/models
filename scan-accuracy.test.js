const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluateScan}=require('./scan-accuracy');
const truth=require('./test-fixtures/handwriting/pda-q0-q6-ground-truth.json');
const field=value=>({value,confidence:.99});
function referencePayload(){
  return {states:truth.states.map(visible_label=>({visible_label,is_start:false,is_accepting:visible_label==='q6'})),
    transitions:truth.transitions.map(t=>({source_state:{visible_label:t.from},target_state:{visible_label:t.to},
      rules:t.rules.map(r=>({read_input:field(r.input),pop_value:field(r.stack_top),stack_action:{type:r.action},
        push_value:field(r.action==='PUSH'?r.symbol:'ε'),pop_symbol:field(r.action==='POP'?r.symbol:'ε')}))}))};
}
test('accuracy evaluator accepts exact fields independent of visual ordering',()=>{
  const p=referencePayload();p.transitions.reverse();p.transitions.forEach(t=>t.rules.reverse());
  const r=evaluateScan(p,truth);assert.equal(r.exact,true);assert.equal(r.rulesExact,14);assert.equal(r.fieldsCorrect,56);
});
test('a plausible-looking graph with unknown labels cannot pass the visual benchmark',()=>{
  const p=referencePayload();p.transitions.forEach(t=>t.rules.forEach(r=>{r.read_input=field('?');}));
  const r=evaluateScan(p,truth);assert.equal(r.topologyCorrect,true);assert.equal(r.exact,false);assert.equal(r.rulesExact,0);
});
test('every single wrong rule field is detected, including action direction',()=>{
  referencePayload().transitions.forEach((t,i)=>t.rules.forEach((r,j)=>{
    for(const f of ['read_input','pop_value','stack_action',...(r.stack_action.type==='PUSH'?['push_value']:r.stack_action.type==='POP'?['pop_symbol']:[])]){
      const p=referencePayload();p.transitions[i].rules[j][f]=f==='stack_action'?{type:'UNKNOWN'}:field('?');
      assert.equal(evaluateScan(p,truth).exact,false,`${i}/${j}/${f}`);
    }
  }));
});
test('duplicate or missing physical rules and connectors do not disappear during evaluation',()=>{
  for(const change of [p=>p.transitions.pop(),p=>p.transitions.push(p.transitions[0]),
    p=>p.transitions[3].rules.pop(),p=>p.transitions[3].rules.push(p.transitions[3].rules[0])]){
    const p=referencePayload();change(p);assert.equal(evaluateScan(p,truth).exact,false);
  }
});
test('accepting and initial markers are evaluated against visual evidence, not q numbering',()=>{
  const p=referencePayload();p.states[3].is_accepting=true;assert.equal(evaluateScan(p,truth).acceptingCorrect,false);
  const q=referencePayload();q.states[0].is_start=true;assert.equal(evaluateScan(q,truth).startCorrect,false);
});
