// Image shrinking and byte compression helpers (browser only).

export function canDeflate() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export const deflate = (bytes) => pipe(bytes, new CompressionStream('deflate-raw'));
export const inflate = (bytes) => pipe(bytes, new DecompressionStream('deflate-raw'));

/** Deflates when it helps. Returns { bytes, deflated }. */
export async function maybeDeflate(bytes) {
  if (!canDeflate() || bytes.length < 24) return { bytes, deflated: false };
  try {
    const d = await deflate(bytes);
    if (d.length < bytes.length * 0.95) return { bytes: d, deflated: true };
  } catch { /* fall through */ }
  return { bytes, deflated: false };
}

export async function loadImage(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let webpOk;
export async function supportsWebp() {
  if (webpOk === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    const b = await new Promise((r) => c.toBlob(r, 'image/webp', 0.5));
    webpOk = !!b && b.type === 'image/webp';
  }
  return webpOk;
}

/** Shrinks and re-encodes an image. Returns { blob, bytes, width, height, mime }. */
export async function shrinkImage(img, { maxDim, quality, format, gray }) {
  const w0 = img.width;
  const h0 = img.height;
  const scale = Math.min(1, maxDim / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  if (gray) {
    const d = ctx.getImageData(0, 0, w, h);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const y = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
      p[i] = p[i + 1] = p[i + 2] = y;
    }
    ctx.putImageData(d, 0, 0);
  }
  let mime = format === 'webp' && (await supportsWebp()) ? 'image/webp' : 'image/jpeg';
  let blob = await new Promise((r) => c.toBlob(r, mime, quality));
  if (!blob) throw new Error('encode failed');
  mime = blob.type || mime;
  return { blob, bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h, mime };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ك.ب`;
  return `${(n / 1024 / 1024).toFixed(2)} م.ب`;
}

export function formatDuration(sec) {
  if (!isFinite(sec)) return '∞';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} ث`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m} د ${s ? s + ' ث' : ''}`.trim();
  return `${Math.floor(m / 60)} س ${m % 60} د`;
}
