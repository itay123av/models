// Diagnostic-only handwriting adaptation. References must be separately reviewed
// photographs, not target answers or previous model predictions.
const { prepare, prepareBlocks } = require('./probe-gemini-ocr.cjs');

function prepareWriterReferences(files, counts, references) {
  if (!Array.isArray(references) || references.length < 1 || references.length > 3)
    throw new Error('Supply 1–3 reviewed writer references');
  const prepared = prepareBlocks(files, counts);
  const referenceImages = prepare(references.map(reference => reference.file));
  const targetHashes = new Set(prepared.images.map(image => image.sha256));
  if (referenceImages.images.some(image => targetHashes.has(image.sha256)))
    throw new Error('A target image cannot also be its own reference');
  const content = [];
  const referenceEvidence = references.map((reference, index) => {
    if (!reference.source_id || !reference.review_note || !Array.isArray(reference.rows) ||
        !reference.rows.length || reference.rows.length > 4 || reference.rows.some(row =>
          ['input','stack_top','action_text','action_symbol'].some(field => typeof row[field] !== 'string')))
      throw new Error('References require reviewed literal rows and source provenance');
    const rows = reference.rows.map(({ input, stack_top, action_text, action_symbol }) =>
      ({ input, stack_top, action_text, action_symbol }));
    content.push({ type: 'text', text: `WRITER REFERENCE ${index + 1}, not a target IMAGE. Reviewed literal rows, top to bottom: ${JSON.stringify(rows)}. Learn only handwriting shapes. Do not copy its rule values to any target. State names and connector directions in a reference are irrelevant.` },
      referenceImages.request.input[2 + index * 2]);
    return { ...referenceImages.images[index], source_id: reference.source_id,
      review_note: reference.review_note, rows };
  });
  const images = [...prepared.images, ...referenceImages.images];
  if (images.reduce((sum,image)=>sum+image.bytes,0) > 4*1024*1024)
    throw new Error('Combined writer-reference image budget exceeded');
  prepared.request.input = [prepared.request.input[0], ...content,
    { type: 'text', text: 'END OF REFERENCES. Read only the following target IMAGEs in your response. Reference letters are NOT an allowed alphabet or template; transcribe each target from its own ink. Never infer matching transitions or expected semantics.' },
    ...prepared.request.input.slice(1)];
  prepared.request.model = 'gemini-3.6-flash';
  prepared.request.generation_config = { max_output_tokens:1600, thinking_level:'minimal', thinking_summaries:'none' };
  prepared.profile = 'reviewed-separate-photo-writer-references-v1';
  prepared.writer_references = referenceEvidence;
  return prepared;
}
module.exports = { prepareWriterReferences };
