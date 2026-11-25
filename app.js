// Picomp: resize images down to a max width (never upscales) and export as JPG, PNG or WebP
const MAX_WIDTH = 2000;
const UNSHARP_AMOUNT = 35;
const UNSHARP_RADIUS = 0.6;
// JPG and WebP each use one fixed quality, tuned on a test set of photos and graphics.
// quant_table 3 is MozJPEG's own table, which beats the 1992 standard table by about 1 dB per byte.
const FORMATS = {
  jpg:  { label: 'JPG', mime: 'image/jpeg', alpha: false, options: { quality: 65, quant_table: 3, auto_subsample: false, chroma_subsample: 1 } },
  png:  { label: 'PNG', mime: 'image/png',  alpha: true,  options: { level: 4 } },
  webp: { label: 'WebP', mime: 'image/webp', alpha: true,  options: { quality: 70, method: 6, use_sharp_yuv: 0, autofilter: 1 } },
  avif: { label: 'AVIF', mime: 'image/avif', alpha: true,  options: { quality: 50, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0, speed: 6, subsample: 1, chromaDeltaQ: false, sharpness: 0, enableSharpYUV: false, tune: 0, bitDepth: 8 } },
  jxl:  { label: 'JXL', mime: 'image/jxl', alpha: true,  options: { quality: 80, effort: 7, progressive: false, epf: -1, lossyPalette: false, decodingSpeedTier: 0, photonNoiseIso: 0, lossyModular: false, lossless: false } },
};

// JPG chroma: half-resolution colour saves 20 to 30% but smears saturated colour edges on some images,
// so both modes get encoded and half colour is kept only when it costs less than this much PSNR.
const JPG_CHROMA_MAX_LOSS = 1.0;

// A few hard photos fall well short at the fixed quality, so quality steps up until the result clears this floor
const JPG_PSNR_FLOOR = 33;
const JPG_Q_STEP = 5;
const JPG_Q_CEILING = 80;

// Small images cost so little that a higher quality is worth it.
// They also keep full colour: small files are often graphics, where half colour frays text and sharp edges
// by more than the numbers suggest.
const JPG_SMALL_PIXELS = 1e6;
const JPG_SMALL_QUALITY = 80;

// Graphics show JPEG ringing and blotching far more than photos, so they get a high quality and full colour.
// A low count of distinct colours is what separates them: photos here run 5600 and up, graphics well under.
const JPG_GRAPHIC_COLOURS = 4000;
const JPG_GRAPHIC_QUALITY = 85;

// A source that was not already a JPEG (PNG, WebP, HEIC and the like) carries real fine texture, such as
// skin pores and freckles, which quality 65 smears into blotches. A JPEG source has lost that texture once
// already, so its fine detail is mostly old compression noise and 65 stays right for it.
const JPG_CLEAN_SOURCE_QUALITY = 80;

// WebP has the same problem with photos from a clean source, and needs 85 to keep the texture JPG keeps at 80.
// Graphics stay at the default: they have no fine texture to lose, and 70 was settled for them in testing.
const WEBP_CLEAN_SOURCE_QUALITY = 85;

// Lossy PNG: palette reduction with libimagequant, then OxiPNG. Dither stays on: without it
// photos band visibly in flat areas, even though the numbers look better.
// Palette size is searched between MIN and MAX for the smallest one whose PSNR against the source clears the target
// 48 dB is where palette banding stops being visible on photographic content
const PNG_COLORS_MIN = 16;
const PNG_COLORS_MAX = 256;
const PNG_PSNR_TARGET = 48;
const PNG_DITHER = 0.5;

// A small area of strong colour, such as gold jewellery in a portrait, can lose every palette slot to the
// skin and background around it and come back washed out. A second pass re-runs the palette with those
// badly matched pixels counted extra, so they claim colours of their own.
// ERROR is the OKLab distance past which a pixel counts as badly matched, just beyond a visible difference.
// SHARE is the weight those pixels get in the second pass, as a fraction of the image.
// The second pass is kept only when its PSNR stays within TOLERANCE dB of the first.
const PNG_REWEIGHT_ERROR = 0.02;
const PNG_REWEIGHT_SHARE = 0.04;
const PNG_REWEIGHT_TOLERANCE = 0.1;

const drop = document.getElementById('drop');
const pick = document.getElementById('pick');
const results = document.getElementById('results');
const table = document.getElementById('table');
const maxw = document.getElementById('maxw');
const maxwNum = document.getElementById('maxwNum');
const scale = document.getElementById('scale');
const marker = document.getElementById('marker');
const resizeOn = document.getElementById('resizeOn');
const widthBox = document.getElementById('width');
const convertOn = document.getElementById('convertOn');
const formatBox = document.getElementById('formats');
const metaOn = document.getElementById('metaOn');
const resizer = pica({ features: ['js'] });

function fmt(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>';

// HEIC and HEIF: only Safari decodes these natively, so fall back to libheif (loaded on first use)
let heif = null;
function loadHeif() {
  if (!heif) heif = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/libheif.js';
    s.onload = () => fetch('vendor/libheif.wasm').then(r => r.arrayBuffer()).then(wasmBinary => resolve(libheif({ wasmBinary }))).catch(reject);
    s.onerror = () => reject(new Error('HEIC decoder failed to load'));
    document.head.appendChild(s);
  });
  return heif;
}

// No browser reads JXL yet, so dropping one in needs our own decoder, loaded on first use
let jxlDec = null;
function looksLikeJxl(file) {
  const t = (file.type || '').toLowerCase();
  return t === 'image/jxl' || /\.jxl$/i.test(file.name);
}

async function decodeJxl(file) {
  if (!jxlDec) jxlDec = import('./vendor/jxl_dec.js').then(m => m.default());
  const mod = await jxlDec;
  const out = mod.decode(new Uint8Array(await file.arrayBuffer()));
  if (!out) throw new Error('JXL decode failed');
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
  return canvas;
}

function looksLikeHeif(file) {
  const t = (file.type || '').toLowerCase();
  const ext = (file.name.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  return t.includes('hei') || ext === 'heic' || ext === 'heif' || ext === 'hif';
}

// Decode a HEIC into a canvas, which pica and the rest of the pipeline accept like any other source
async function decodeHeif(file) {
  const mod = await loadHeif();
  const images = new mod.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  if (!images || !images.length) throw new Error('no image in file');
  const image = images[0];
  const w = image.get_width(), h = image.get_height();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(w, h);
  await new Promise((resolve, reject) => {
    image.display(data, out => out ? resolve() : reject(new Error('HEIC decode failed')));
  });
  ctx.putImageData(data, 0, 0);
  if (image.free) image.free();
  return canvas;
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    if (looksLikeHeif(file)) return await decodeHeif(file);
    if (looksLikeJxl(file)) return await decodeJxl(file);
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
}

async function resize(src, maxWidth, keepAlpha) {
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height;
  if (!w || !h) throw new Error('no size');
  const outW = Math.min(maxWidth, w);
  const outH = Math.max(1, Math.round(h * outW / w));

  const scaled = document.createElement('canvas');
  scaled.width = outW;
  scaled.height = outH;
  if (w > outW) {
    // Lanczos downscale plus light sharpening, same idea as Photoshop's Bicubic Sharper
    await resizer.resize(src, scaled, { filter: 'lanczos3', unsharpAmount: UNSHARP_AMOUNT, unsharpRadius: UNSHARP_RADIUS, unsharpThreshold: 0 });
  } else {
    scaled.getContext('2d').drawImage(src, 0, 0);
  }
  if (keepAlpha) return scaled.getContext('2d').getImageData(0, 0, outW, outH);

  // Flatten onto white, JPG has no transparency
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(scaled, 0, 0);
  return ctx.getImageData(0, 0, outW, outH);
}

// AVIF: aom via WASM, loaded on first use because it is 3.5 MB. Quality 50 matches our WebP output's
// fidelity at roughly 60% of the size. No browser exposes an AVIF encoder, so this is the only route.
// The encoder writes "unspecified" colour primaries and transfer, which leaves each viewer to guess and
// makes the image look washed out in some of them. Name the colour space in the nclx box instead,
// BT.709 primaries and the sRGB transfer, which is what well-formed AVIF files carry.
function tagAvifColour(bytes) {
  for (let i = 0; i + 15 < bytes.length; i++) {
    if (bytes[i] === 0x63 && bytes[i + 1] === 0x6F && bytes[i + 2] === 0x6C && bytes[i + 3] === 0x72 &&
        bytes[i + 4] === 0x6E && bytes[i + 5] === 0x63 && bytes[i + 6] === 0x6C && bytes[i + 7] === 0x78) {
      bytes[i + 8] = 0; bytes[i + 9] = 1;   // colour primaries: BT.709
      bytes[i + 10] = 0; bytes[i + 11] = 13; // transfer characteristics: sRGB
      return true;
    }
  }
  return false;
}

// Encoded at 10 bits: it costs nothing in size or speed, and some Windows
// decoders render 8-bit full-range AV1 with shifted colours, which 10 bits avoids.
let avifMod = null;
async function encodeAvif(pixels, options) {
  if (!avifMod) avifMod = import('./vendor/avif_enc.js').then(m => m.default());
  const mod = await avifMod;
  const src = pixels.data;
  const wide = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) { const v = src[i]; wide[i] = (v << 2) | (v >> 6); }
  const buf = mod.encode(new Uint8Array(wide.buffer), pixels.width, pixels.height, { ...options, bitDepth: 10 });
  if (!buf) throw new Error('AVIF encode failed');
  const bytes = new Uint8Array(buf);
  tagAvifColour(bytes);
  return bytes.buffer;
}

// The encoder exhausts the browser's 2 GB memory ceiling somewhere above 20 megapixels, so anything
// larger is scaled down to fit and the row says so. Raising the encoder's own cap does not help:
// the limit is the browser's, not the build's.
const JXL_MAX_PIXELS = 18e6;

// JXL via WASM, loaded on first use. Quality 80 with the default effort; effort 9 saves about 8% but takes
// four times as long. Note most browsers cannot display JXL yet, so these files are for storage or Safari.
let jxlMod = null;
async function encodeJxl(pixels, options) {
  if (!jxlMod) jxlMod = import('./vendor/jxl_enc.js').then(m => m.default());
  const mod = await jxlMod;
  let buf;
  try {
    buf = mod.encode(pixels.data, pixels.width, pixels.height, options);
  } catch (e) {
    // The encoder runs out of memory on very large images and cannot be reused afterwards,
    // so drop it and let the next conversion start a fresh one
    jxlMod = null;
    throw new Error('too large for JXL, try a smaller width');
  }
  if (!buf) throw new Error('JXL encode failed');
  return buf.buffer;
}

// Metadata: the pipeline works on raw pixels, so EXIF never survives the decode. When the switch is on
// the original block is lifted out of the source file and spliced into the output instead.
// Only JPG and PNG can carry it here; the other containers would need rewriting.
function sourceExif(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (i, s) => String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]) === s;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let i = 2;
    while (i + 4 < bytes.length && bytes[i] === 0xFF) {
      const marker = bytes[i + 1], len = dv.getUint16(i + 2);
      if (marker === 0xDA || marker === 0xD9) break;
      if (marker === 0xE1 && tag(i + 4, 'Exif')) return bytes.slice(i + 10, i + 2 + len);
      i += 2 + len;
    }
    return null;
  }
  if (bytes[0] === 0x89 && tag(1, 'PNG\r')) {
    let i = 8;
    while (i + 8 <= bytes.length) {
      const len = dv.getUint32(i);
      if (tag(i + 4, 'eXIf')) return bytes.slice(i + 8, i + 8 + len);
      if (tag(i + 4, 'IEND')) break;
      i += 12 + len;
    }
    return null;
  }
  if (tag(0, 'RIFF') && tag(8, 'WEBP')) {
    let i = 12;
    while (i + 8 <= bytes.length) {
      const len = dv.getUint32(i + 4, true);
      if (tag(i, 'EXIF')) {
        let s = i + 8;
        if (tag(s, 'Exif')) s += 6;
        return bytes.slice(s, i + 8 + len);
      }
      i += 8 + len + (len & 1);
    }
  }
  return null;
}

// Rotation is already applied to the pixels, so the tag has to say "normal" or viewers turn it twice
function resetOrientation(tiff) {
  if (tiff.length < 12) return tiff;
  const le = tiff[0] === 0x49;
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = dv.getUint32(4, le);
  if (ifd + 2 > tiff.length) return tiff;
  const n = dv.getUint16(ifd, le);
  for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= tiff.length; k++) {
    const e = ifd + 2 + k * 12;
    if (dv.getUint16(e, le) === 0x0112) { dv.setUint16(e + 8, 1, le); break; }
  }
  return tiff;
}

function jpegWithExif(out, tiff) {
  const payload = 8 + tiff.length;
  if (payload > 0xFFFF) return out;
  const o = new Uint8Array(out);
  const res = new Uint8Array(o.length + 4 + 6 + tiff.length);
  res.set(o.subarray(0, 2), 0);
  res[2] = 0xFF; res[3] = 0xE1;
  res[4] = payload >> 8; res[5] = payload & 0xFF;
  res.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  res.set(tiff, 12);
  res.set(o.subarray(2), 12 + tiff.length);
  return res.buffer;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Minimal ZIP writer. Entries are stored rather than deflated, because every file going in is
// already a compressed image and deflating it again would cost time for roughly nothing
function zipStore(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  const parts = [], central = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.bytes;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

function pngWithExif(out, tiff) {
  const o = new Uint8Array(out);
  const dv = new DataView(o.buffer, o.byteOffset, o.byteLength);
  let i = 8, iend = -1;
  while (i + 8 <= o.length) {
    const len = dv.getUint32(i);
    if (String.fromCharCode(o[i + 4], o[i + 5], o[i + 6], o[i + 7]) === 'IEND') { iend = i; break; }
    i += 12 + len;
  }
  if (iend < 0) return out;
  const chunk = new Uint8Array(12 + tiff.length);
  const cd = new DataView(chunk.buffer);
  cd.setUint32(0, tiff.length);
  chunk.set([0x65, 0x58, 0x49, 0x66], 4);
  chunk.set(tiff, 8);
  cd.setUint32(8 + tiff.length, crc32(chunk.subarray(4, 8 + tiff.length)));
  const res = new Uint8Array(o.length + chunk.length);
  res.set(o.subarray(0, iend), 0);
  res.set(chunk, iend);
  res.set(o.subarray(iend), iend + chunk.length);
  return res.buffer;
}

// Lossy PNG: reduce to a palette with libimagequant (loaded on first use), then OxiPNG packs it as indexed PNG
let quantizer = null;
function loadQuantizer() {
  if (!quantizer) quantizer = import('./vendor/imagequant.js').then(m => m.default()).then(mod => mod.ready ? mod.ready.then(() => mod) : mod);
  return quantizer;
}

// Premultiply alpha so fully transparent pixels compare equal whatever colour the palette gave them
function premultiplied(data, width, height) {
  const d = new Uint8ClampedArray(data);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a < 255) { d[i] = d[i] * a / 255; d[i + 1] = d[i + 1] * a / 255; d[i + 2] = d[i + 2] * a / 255; }
  }
  return { data: d, width, height };
}

// PSNR over RGB, skipping pixels that are fully transparent in both images
function psnr(a, b) {
  let sq = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0 && b[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; sq += d * d; n++; }
  }
  return n && sq ? 10 * Math.log10(255 * 255 / (sq / n)) : Infinity;
}

// sRGB to linear light, used by the perceptual colour check
const SRGB_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// Convert one pixel to OKLab, a colour space where equal distances look equally different
function toOklab(d, i, out) {
  const r = SRGB_LINEAR[d[i]], g = SRGB_LINEAR[d[i + 1]], b = SRGB_LINEAR[d[i + 2]];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

// Second palette pass: find pixels the first palette matched badly and quantise again with copies of them
// in extra rows below the image, which weights the palette toward them. The extra rows are cut off again.
// Returns null when every pixel already matches well.
function reweightPalette(mod, pixels, ref, n, first) {
  const w = pixels.width, h = pixels.height, src = pixels.data, size = w * h;
  const out = premultiplied(first, w, h).data;
  const A = new Float64Array(3), B = new Float64Array(3);
  const limit = PNG_REWEIGHT_ERROR * PNG_REWEIGHT_ERROR;
  const bad = new Uint8Array(size);
  let count = 0;
  for (let p = 0, i = 0; p < size; p++, i += 4) {
    if (src[i + 3] === 0) continue;
    toOklab(ref, i, A);
    toOklab(out, i, B);
    const dl = A[0] - B[0], da = A[1] - B[1], db = A[2] - B[2];
    if (dl * dl + da * da + db * db > limit) { bad[p] = 1; count++; }
  }
  if (!count) return null;
  const where = new Uint32Array(count);
  for (let p = 0, k = 0; p < size; p++) if (bad[p]) where[k++] = p;

  // Copies are spread evenly across every badly matched pixel, so no one part of the image dominates
  const rows = Math.max(1, Math.ceil(h * PNG_REWEIGHT_SHARE));
  const extra = rows * w;
  const aug = new Uint8ClampedArray((size + extra) * 4);
  aug.set(src);
  for (let k = 0, o = size * 4; k < extra; k++, o += 4) {
    const s = where[Math.floor(k * count / extra)] * 4;
    aug[o] = src[s]; aug[o + 1] = src[s + 1]; aug[o + 2] = src[s + 2]; aug[o + 3] = src[s + 3];
  }
  return new Uint8ClampedArray(mod.quantize(aug, w, h + rows, n, PNG_DITHER).subarray(0, size * 4));
}

// Binary search the palette size (to within 4 colours) for the smallest one that still meets the PSNR target,
// then give small, strongly coloured areas a second chance at palette slots
async function quantizeAdaptive(pixels, onStep) {
  const mod = await loadQuantizer();
  const w = pixels.width, h = pixels.height;
  const ref = premultiplied(pixels.data, w, h);
  const run = n => mod.quantize(pixels.data, w, h, n, PNG_DITHER);
  let lo = PNG_COLORS_MIN, hi = PNG_COLORS_MAX, best = null;
  while (hi - lo > 4) {
    const n = Math.round((lo + hi) / 2);
    if (onStep) onStep(n);
    const data = run(n);
    if (psnr(ref.data, premultiplied(data, w, h).data) >= PNG_PSNR_TARGET) { best = { data, n }; hi = n; }
    else lo = n;
  }
  if (!best) best = { data: run(PNG_COLORS_MAX), n: PNG_COLORS_MAX };

  const second = reweightPalette(mod, pixels, ref.data, best.n, best.data);
  if (second) {
    const before = psnr(ref.data, premultiplied(best.data, w, h).data);
    const after = psnr(ref.data, premultiplied(second, w, h).data);
    if (after >= before - PNG_REWEIGHT_TOLERANCE) best.data = second;
  }
  return { pixels: new ImageData(new Uint8ClampedArray(best.data), w, h), colors: best.n };
}

// Decode a JPG back to pixels so a candidate can be scored against the source
async function decodeJpg(buf, w, h) {
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

async function scoreJpg(pixels, options) {
  const buf = await PicompCodecs.jpg(pixels, options);
  const out = await decodeJpg(buf, pixels.width, pixels.height);
  return { buf, score: psnr(pixels.data, out.data) };
}

// Encode both chroma modes and keep half colour unless it costs too much fidelity, varying it per image.
// Then raise quality a step at a time for the few photos that still land under the floor.
// Count distinct colours at 6 bits per channel over a quarter of the pixels, enough to tell a graphic from a photo
function colourCount(pixels) {
  const d = pixels.data, w = pixels.width, h = pixels.height;
  const seen = new Set();
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      seen.add((d[i] >> 2 << 12) | (d[i + 1] >> 2 << 6) | (d[i + 2] >> 2));
    }
  }
  return seen.size;
}

async function encodeJpg(pixels, options, onStep, cleanSource) {
  const graphic = colourCount(pixels) < JPG_GRAPHIC_COLOURS;
  const small = !graphic && pixels.width * pixels.height <= JPG_SMALL_PIXELS;
  let base = options;
  if (graphic) base = { ...options, quality: JPG_GRAPHIC_QUALITY };
  else if (small) base = { ...options, quality: JPG_SMALL_QUALITY };
  else if (cleanSource) base = { ...options, quality: JPG_CLEAN_SOURCE_QUALITY };
  const single = graphic || small;
  if (onStep) onStep(single ? 'encoding' : 'full colour');
  const full = await scoreJpg(pixels, { ...base, chroma_subsample: 1 });
  let half = null;
  if (!single) {
    if (onStep) onStep('half colour');
    half = await scoreJpg(pixels, { ...base, chroma_subsample: 2 });
  }
  const useHalf = half !== null && full.score - half.score <= JPG_CHROMA_MAX_LOSS;
  let best = useHalf ? half : full;
  const sub = useHalf ? 2 : 1;
  let quality = base.quality;
  while (best.score < JPG_PSNR_FLOOR && quality < JPG_Q_CEILING) {
    quality = Math.min(JPG_Q_CEILING, quality + JPG_Q_STEP);
    if (onStep) onStep('quality ' + quality);
    best = await scoreJpg(pixels, { ...base, quality, chroma_subsample: sub });
  }
  return { buf: best.buf, chroma: useHalf ? '4:2:0' : '4:4:4', quality };
}

// Map a dropped file to one of our output formats by MIME type, then by extension; null when we can't write it
function sourceFormat(file) {
  const t = (file.type || '').toLowerCase();
  const ext = (file.name.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  if (t === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (t === 'image/png' || ext === 'png') return 'png';
  if (t === 'image/webp' || ext === 'webp') return 'webp';
  if (t === 'image/avif' || ext === 'avif') return 'avif';
  if (t === 'image/jxl' || ext === 'jxl') return 'jxl';
  return null;
}

async function convert(file, format, maxWidth) {
  const li = el('li', 'row busy');
  const thumb = el('div', 'thumb');
  const info = el('div', 'info');
  const bars = el('div', 'bars');
  const barOrig = el('div', 'bar orig');
  const barNew = el('div', 'bar new');
  const fillOrig = el('i');
  const fillNew = el('i');
  const labNew = el('span');
  fillOrig.style.width = '100%';
  fillNew.style.width = '100%';
  barOrig.append(fillOrig, el('span', '', fmt(file.size)));
  barNew.append(fillNew, labNew);
  bars.append(barOrig, barNew);
  const meta = el('div', 'meta', 'Converting...');
  info.append(el('div', 'name', file.name), bars, meta);
  li.append(thumb, info);
  results.prepend(li);

  try {
    if (looksLikeHeif(file)) meta.textContent = 'Decoding HEIC...';
    const src = await decode(file);
    let note = '';
    if (!format) {
      // Keep the source format; anything we can't write falls back to WebP, the closest we have in
      // efficiency to AVIF and HEIC, so the file does not grow. It also keeps any transparency.
      format = sourceFormat(file);
      if (!format) {
        format = 'webp';
        note = ', from ' + (file.name.match(/\.([^.]+)$/) || ['', 'other'])[1].toUpperCase();
      }
    }
    const f = FORMATS[format];
    // JXL cannot handle very large images in a browser, so cap the width to fit and say so afterwards
    let width = maxWidth, shrunk = false;
    if (format === 'jxl') {
      const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
      const outW = Math.min(width, sw);
      if (outW * Math.round(sh * outW / sw) > JXL_MAX_PIXELS) {
        width = Math.floor(Math.sqrt(JXL_MAX_PIXELS * sw / sh));
        shrunk = true;
      }
    }
    const pixels = await resize(src, width, f.alpha);
    if (src.close) src.close();
    let buf, detail = '';
    if (format === 'png') {
      const r = await quantizeAdaptive(pixels, n => { meta.textContent = 'Reducing colours (' + n + ')...'; });
      meta.textContent = 'Packing...';
      buf = await PicompCodecs.png(r.pixels, f.options);
      detail = ', ' + r.colors + ' colours';
    } else if (format === 'jpg') {
      const r = await encodeJpg(pixels, f.options, s => { meta.textContent = 'Encoding (' + s + ')...'; }, sourceFormat(file) !== 'jpg');
      buf = r.buf;
      detail = ' ' + r.chroma + (r.quality !== FORMATS.jpg.options.quality ? ' q' + r.quality : '');
    } else if (format === 'avif') {
      meta.textContent = 'Encoding AVIF...';
      buf = await encodeAvif(pixels, f.options);
    } else if (format === 'jxl') {
      meta.textContent = 'Encoding JXL...';
      buf = await encodeJxl(pixels, f.options);
      if (shrunk) detail = ', shrunk to fit';
    } else if (format === 'webp') {
      const photo = sourceFormat(file) !== 'jpg' && colourCount(pixels) >= JPG_GRAPHIC_COLOURS;
      const quality = photo ? WEBP_CLEAN_SOURCE_QUALITY : f.options.quality;
      buf = await PicompCodecs.webp(pixels, { ...f.options, quality });
      if (photo) detail = ' q' + quality;
    } else {
      buf = await PicompCodecs[format](pixels, f.options);
    }
    if (metaOn.checked) {
      if (format === 'jpg' || format === 'png') {
        const tiff = sourceExif(new Uint8Array(await file.arrayBuffer()));
        if (tiff) {
          resetOrientation(tiff);
          buf = format === 'jpg' ? jpegWithExif(buf, tiff) : pngWithExif(buf, tiff);
        } else {
          detail += ', no metadata found';
        }
      } else {
        detail += ', metadata dropped';
      }
    }
    const blob = new Blob([buf], { type: f.mime });
    const outName = file.name.replace(/\.[^.]+$/, '') + '.' + format;
    const url = URL.createObjectURL(blob);

    // Thumbnail is drawn from the resized pixels, not the output file, so it works for formats
    // the browser cannot display yet, such as JXL
    const thumbW = 176;
    const tc = document.createElement('canvas');
    tc.width = Math.min(thumbW, pixels.width);
    tc.height = Math.max(1, Math.round(pixels.height * tc.width / pixels.width));
    const full = document.createElement('canvas');
    full.width = pixels.width;
    full.height = pixels.height;
    full.getContext('2d').putImageData(pixels, 0, 0);
    const tctx = tc.getContext('2d');
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(full, 0, 0, tc.width, tc.height);
    const img = new Image();
    img.alt = '';
    img.src = tc.toDataURL('image/jpeg', 0.8);
    thumb.append(img);

    const max = Math.max(file.size, blob.size);
    li.classList.remove('busy');
    fillOrig.style.width = (file.size / max * 100) + '%';
    fillNew.style.width = (blob.size / max * 100) + '%';
    labNew.textContent = fmt(blob.size);

    const saved = Math.round((1 - blob.size / file.size) * 100);
    meta.textContent = f.label + detail + note + ', ' + pixels.width + 'x' + pixels.height;
    if (saved > 0) {
      meta.append(', ');
      meta.append(el('b', '', saved + '% smaller'));
    }

    const link = el('a', 'dl');
    link.href = url;
    link.download = outName;
    link.innerHTML = DL_ICON + 'Download';
    li.append(link);

    done.push({ name: outName, bytes: buf instanceof Uint8Array ? buf : new Uint8Array(buf) });
    updateBulk();
  } catch (e) {
    li.classList.remove('busy');
    li.classList.add('failed');
    thumb.textContent = '!';
    bars.remove();
    meta.className = 'err';
    // Encoders raise their own messages, such as an image being too large; only fall back for decode failures
    meta.textContent = /too large|failed/i.test(e.message)
      ? e.message.charAt(0).toUpperCase() + e.message.slice(1)
      : "Couldn't read this file. It may not be an image, or this browser can't open the format.";
  }
}

// Every finished output, kept so they can be zipped together
const done = [];
const bulk = document.getElementById('bulk');
const dlAll = document.getElementById('dlAll');

function updateBulk() {
  bulk.hidden = done.length < 2;
  dlAll.innerHTML = DL_ICON + 'Download all ' + done.length + ' files';
}

// Two sources can produce the same output name, so make each one unique before zipping
function uniqueNames(entries) {
  const seen = new Map();
  return entries.map(e => {
    const n = seen.get(e.name) || 0;
    seen.set(e.name, n + 1);
    if (!n) return e;
    return { bytes: e.bytes, name: e.name.replace(/(\.[^.]+)$/, '-' + n + '$1') };
  });
}

dlAll.addEventListener('click', () => {
  if (done.length < 2) return;
  dlAll.disabled = true;
  const label = dlAll.innerHTML;
  dlAll.innerHTML = DL_ICON + 'Zipping...';
  // Let the button repaint before the zip blocks the main thread
  setTimeout(() => {
    try {
      const blob = zipStore(uniqueNames(done));
      const url = URL.createObjectURL(blob);
      const a = el('a');
      a.href = url;
      a.download = 'picomp.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } finally {
      dlAll.innerHTML = label;
      dlAll.disabled = false;
    }
  }, 30);
});

let queue = Promise.resolve();
function addFiles(files) {
  // Convert off: null means keep each file's own format, only compress
  const format = convertOn.checked ? document.querySelector('input[name="format"]:checked').value : null;
  // Resize off: keep the source width, only compress
  const maxWidth = resizeOn.checked ? clampWidth(maxwNum.value) : Infinity;
  for (const f of files) queue = queue.then(() => convert(f, format, maxWidth));
}

// Width control: slider and exact number box stay in sync
const MIN_WIDTH = 100;
function clampWidth(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n)) : MAX_WIDTH;
}
function updateWidth(w, syncBox) {
  maxw.value = w;
  if (syncBox) maxwNum.value = w;
  // Marker line on the ruler follows the exact value, even between slider steps
  marker.style.left = ((Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)) - MIN_WIDTH) / (MAX_WIDTH - MIN_WIDTH) * 100) + '%';
}

// Toggles: grey out the format pills and the width controls while their switch is off
function updateResizeState() {
  const on = resizeOn.checked;
  widthBox.classList.toggle('off', !on);
  maxw.disabled = !on;
  maxwNum.disabled = !on;
}
function updateConvertState() {
  const on = convertOn.checked;
  formatBox.classList.toggle('off', !on);
  document.querySelectorAll('input[name="format"]').forEach(r => { r.disabled = !on || !!r.dataset.soon; });
}
resizeOn.addEventListener('change', updateResizeState);
convertOn.addEventListener('change', updateConvertState);
maxw.addEventListener('input', () => updateWidth(Number(maxw.value), true));
maxwNum.addEventListener('input', () => { if (maxwNum.value !== '') updateWidth(clampWidth(maxwNum.value), false); });
maxwNum.addEventListener('change', () => updateWidth(clampWidth(maxwNum.value), true));

// Ruler scale behind the slider: a tick every 50px (taller every 100), a label every 200
const pct = v => ((v - MIN_WIDTH) / (MAX_WIDTH - MIN_WIDTH) * 100) + '%';
for (let v = MIN_WIDTH; v <= MAX_WIDTH; v += 50) {
  const t = document.createElement('i');
  t.className = v % 100 === 0 ? 'major' : '';
  t.style.left = pct(v);
  scale.appendChild(t);
  if (v % 200 === 0) {
    const l = document.createElement('span');
    l.style.left = pct(v);
    l.textContent = v;
    scale.appendChild(l);
  }
}
updateWidth(Number(maxw.value), true);
updateResizeState();
updateConvertState();
drop.addEventListener('click', () => pick.click());
pick.addEventListener('change', () => { addFiles(pick.files); pick.value = ''; });
['dragenter', 'dragover'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); table.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); table.classList.remove('over'); }));
window.addEventListener('drop', e => addFiles(e.dataTransfer.files));

// About panel. Native dialogs already close on Esc and the close button;
// this adds closing on a click on the dimmed backdrop outside the panel
for (const [btnId, dlgId] of [['aboutBtn', 'aboutDlg']]) {
  const dlg = document.getElementById(dlgId);
  document.getElementById(btnId).addEventListener('click', () => dlg.showModal());
  dlg.addEventListener('click', e => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}
