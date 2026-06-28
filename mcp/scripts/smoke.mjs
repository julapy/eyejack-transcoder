// Live smoke test: drives the configured transcoder URL with one input and
// asserts a real output came back. Run after `npm run build`.
//   node scripts/smoke.mjs <file-or-url> [--alpha]
import { withPage, closeBrowser, TRANSCODER_URL } from '../dist/browser.js';
import { resolveInput, runTranscode } from '../dist/driver.js';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/smoke.mjs <file-or-url> [--alpha]');
  process.exit(2);
}
const expectAlpha = process.argv.includes('--alpha');

let code = 0;
try {
  console.error(`[smoke] driving ${TRANSCODER_URL}\n[smoke] input: ${input}`);
  const desc = await resolveInput(input);
  const result = await withPage((p) => runTranscode(p, { inputs: [desc], opts: { type: 'auto' }, sequence: false }));
  const v = (result.streams || []).find((s) => s.codec_type === 'video');
  const alpha = !!(v && v.width === v.height * 2);
  const out = join(tmpdir(), `smoke.${result.ext}`);
  if (result.b64) await writeFile(out, Buffer.from(result.b64, 'base64'));
  console.error('[smoke] result:', JSON.stringify({ kind: result.kind, bytes: result.bytes, width: v?.width, height: v?.height, codec: v?.codec, alpha, out }, null, 2));

  const problems = [];
  if (!result.bytes || result.bytes <= 0) problems.push('no output bytes');
  if (!v) problems.push('no video stream');
  if (expectAlpha && !alpha) problems.push('expected alpha output (width === 2 × height)');
  if (problems.length) { console.error('[smoke] FAIL:', problems.join('; ')); code = 1; }
  else console.error('[smoke] PASS');
} catch (e) {
  console.error('[smoke] ERROR:', e?.stack || String(e));
  code = 1;
}
await closeBrowser();
process.exit(code);
