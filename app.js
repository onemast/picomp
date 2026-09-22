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

// Lossy PNG: palette reduction with libimagequant, then OxiPNG. Dither stays on: without it
// photos band visibly in flat areas, even though the numbers look better.
// Palette size is searched between MIN and MAX for the smallest one whose PSNR against the source clears the target
// 48 dB is where palette banding stops being visible on photographic content
const PNG_COLORS_MIN = 16;
const PNG_COLORS_MAX = 256;
const PNG_PSNR_TARGET = 48;
const PNG_DITHER = 0.5;

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

// Binary search the palette size (to within 4 colours) for the smallest one that still meets the PSNR target
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

async function encodeJpg(pixels, options, onStep) {
  const graphic = colourCount(pixels) < JPG_GRAPHIC_COLOURS;
  const small = !graphic && pixels.width * pixels.height <= JPG_SMALL_PIXELS;
  let base = options;
  if (graphic) base = { ...options, quality: JPG_GRAPHIC_QUALITY };
  else if (small) base = { ...options, quality: JPG_SMALL_QUALITY };
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
      const r = await encodeJpg(pixels, f.options, s => { meta.textContent = 'Encoding (' + s + ')...'; });
      buf = r.buf;
      detail = ' ' + r.chroma + (r.quality !== FORMATS.jpg.options.quality ? ' q' + r.quality : '');
    } else if (format === 'avif') {
      meta.textContent = 'Encoding AVIF...';
      buf = await encodeAvif(pixels, f.options);
    } else if (format === 'jxl') {
      meta.textContent = 'Encoding JXL...';
      buf = await encodeJxl(pixels, f.options);
      if (shrunk) detail = ', shrunk to fit';
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
