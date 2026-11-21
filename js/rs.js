// Reed–Solomon over GF(256), primitive polynomial 0x11d, fcr = 0.
// Supports error and erasure correction (Berlekamp–Massey + Forney).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => {
  if (b === 0) throw new Error('div by zero');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const pow = (x, p) => EXP[(((LOG[x] * p) % 255) + 255) % 255];
const inv = (x) => EXP[255 - LOG[x]];

function polyScale(p, x) {
  return p.map((c) => mul(c, x));
}
function polyAdd(p, q) {
  const n = Math.max(p.length, q.length);
  const r = new Array(n).fill(0);
  for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
  return r;
}
function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    if (q[j] === 0) continue;
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}
function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}
function polyDivRemainder(dividend, divisor) {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < divisor.length; j++) {
      if (divisor[j] !== 0) out[i + j] ^= mul(divisor[j], coef);
    }
  }
  return out.slice(out.length - (divisor.length - 1));
}

const genCache = new Map();
function generator(nsym) {
  if (genCache.has(nsym)) return genCache.get(nsym);
  let g = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
  genCache.set(nsym, g);
  return g;
}

/** Returns Uint8Array(msg.length + nsym): message followed by parity. */
export function rsEncode(msg, nsym) {
  if (msg.length + nsym > 255) throw new Error('codeword too long');
  const gen = generator(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(msg);
  return out;
}

function syndromes(msg, nsym) {
  const s = new Array(nsym + 1).fill(0);
  for (let i = 0; i < nsym; i++) s[i + 1] = polyEval(msg, pow(2, i));
  return s;
}

function errataLocator(coefPos) {
  let loc = [1];
  for (const p of coefPos) loc = polyMul(loc, polyAdd([1], [pow(2, p), 0]));
  return loc;
}

function errorEvaluator(synd, errLoc, nsym) {
  const divisor = [1, ...new Array(nsym + 1).fill(0)];
  return polyDivRemainder(polyMul(synd, errLoc), divisor);
}

function correctErrata(msg, synd, errPos) {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = errorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).reverse();
  const X = coefPos.map((cp) => pow(2, -(255 - cp)));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xiInv = inv(X[i]);
    let prime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) prime = mul(prime, 1 ^ mul(xiInv, X[j]));
    }
    if (prime === 0) throw new Error('forney failed');
    let y = polyEval(errEval.slice().reverse(), xiInv);
    y = mul(X[i], y);
    E[errPos[i]] = div(y, prime);
  }
  return polyAdd(msg, E);
}

function findErrorLocator(synd, nsym, eraseCount) {
  let errLoc = [1];
  let oldLoc = [1];
  const shift = synd.length - nsym;
  for (let i = 0; i < nsym - eraseCount; i++) {
    // Forney syndromes already remove the erasures, so no extra offset here.
    const K = i + shift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = [...oldLoc, 0];
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if ((errs - eraseCount) * 2 + eraseCount > nsym) throw new Error('too many errors');
  return errLoc;
}

function findErrors(errLocRev, nmess) {
  const errs = errLocRev.length - 1;
  const pos = [];
  for (let i = 0; i < nmess; i++) {
    if (polyEval(errLocRev, pow(2, i)) === 0) pos.push(nmess - 1 - i);
  }
  if (pos.length !== errs) throw new Error('error locations not found');
  return pos;
}

function forneySyndromes(synd, erasePos, nmess) {
  const rev = erasePos.map((p) => nmess - 1 - p);
  const f = synd.slice(1);
  for (const r of rev) {
    const x = pow(2, r);
    for (let j = 0; j < f.length - 1; j++) f[j] = mul(f[j], x) ^ f[j + 1];
  }
  return f;
}

/**
 * Decodes a codeword. Returns the corrected message (without parity) as a
 * Uint8Array, or null if it cannot be corrected.
 */
export function rsDecode(codeword, nsym, erasePos = []) {
  try {
    let msg = Array.from(codeword);
    if (erasePos.length > nsym) return null;
    for (const e of erasePos) msg[e] = 0;
    let synd = syndromes(msg, nsym);
    if (Math.max(...synd) !== 0) {
      const fsynd = forneySyndromes(synd, erasePos, msg.length);
      const errLoc = findErrorLocator(fsynd, nsym, erasePos.length);
      const errPos = findErrors(errLoc.slice().reverse(), msg.length);
      msg = correctErrata(msg, synd, [...erasePos, ...errPos]);
      synd = syndromes(msg, nsym);
      if (Math.max(...synd) !== 0) return null;
    }
    return Uint8Array.from(msg.slice(0, msg.length - nsym));
  } catch {
    return null;
  }
}
