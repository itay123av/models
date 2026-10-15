const {test}=require('node:test');
const assert=require('node:assert/strict');
const {rulingContrastView}=require('./scripts/ruling-view.cjs');
test('ruling view is aligned auxiliary evidence and never mutates original pixels',()=>{
  const original=new Uint8ClampedArray([70,90,190,255,40,40,40,255,0,0,0,255,255,255,255,100]);
  const before=original.slice(),view=rulingContrastView(original);
  assert.deepEqual(original,before);
  assert.deepEqual(Array.from(view),[190,190,190,255,40,40,40,255,0,0,0,255,255,255,255,100]);
  assert.equal(view.length,original.length);
  assert.throws(()=>rulingContrastView([1,2,3]));
});
