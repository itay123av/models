// Diagnostic auxiliary view only. The original remains mandatory evidence.
// This cannot distinguish blue ink from ruling and must never replace it.
function rulingContrastView(rgba) {
  if (!rgba || rgba.length % 4) throw new Error('Expected RGBA pixels');
  const out = new Uint8ClampedArray(rgba.length);
  for (let i=0;i<rgba.length;i+=4) {
    // A blue ruling reflects more blue light than red. The brightest-channel
    // view reduces that contrast without painting over or inventing strokes.
    const v=Math.max(rgba[i],rgba[i+1],rgba[i+2]);
    out[i]=out[i+1]=out[i+2]=v;out[i+3]=rgba[i+3];
  }
  return out;
}
module.exports={rulingContrastView};
