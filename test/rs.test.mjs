import { rsEncode, rsDecode } from '../js/rs.js';
import assert from 'node:assert/strict';

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const rint = (n) => Math.floor(rnd() * n);

function pickPositions(count, n) {
  const s = new Set();
  while (s.size < count) s.add(rint(n));
  return [...s];
}

let ok = 0;
for (const [n, nsym] of [[96, 32], [160, 32], [200, 40], [255, 32]]) {
  const k = n - nsym;
  for (let trial = 0; trial < 200; trial++) {
    const msg = Uint8Array.from({ length: k }, () => rint(256));
    const cw = rsEncode(msg, nsym);
    assert.equal(cw.length, n);
    // errors only, up to capacity
    const nerr = rint(nsym / 2 + 1);
    const bad = cw.slice();
    for (const p of pickPositions(nerr, n)) bad[p] ^= 1 + rint(255);
    assert.deepEqual(rsDecode(bad, nsym), msg, `errors n=${n} e=${nerr}`);
    // mixed erasures + errors: 2e + f <= nsym
    const f = rint(nsym + 1);
    const e = rint(Math.floor((nsym - f) / 2) + 1);
    const pos = pickPositions(f + e, n);
    const bad2 = cw.slice();
    for (const p of pos) bad2[p] ^= 1 + rint(255);
    assert.deepEqual(rsDecode(bad2, nsym, pos.slice(0, f)), msg, `mixed n=${n} f=${f} e=${e}`);
    ok += 2;
  }
  // beyond capacity must not return the original silently as "correct" too often; just ensure no throw
  const msg = Uint8Array.from({ length: k }, () => rint(256));
  const bad = rsEncode(msg, nsym);
  for (const p of pickPositions(nsym, n)) bad[p] ^= 1 + rint(255);
  rsDecode(bad, nsym);
}
console.log(`rs: ${ok} decode checks passed`);
