# Picomp

**Live at [picomp.app](https://picomp.app)**

Image compressor and converter that runs entirely in the browser. Nothing is uploaded: every image is
decoded, resized and encoded on the visitor's own machine, so the server only ever serves static files.

## What it does

- Compresses and converts between **JPG, PNG, WebP, AVIF and JXL**
- Reads **HEIC** and **JXL** as well, formats most browsers cannot open on their own
- Optional resize to a chosen width, never upscaling
- Optional **EXIF** copying, off by default so location data is not published by accident
- Picks encoder settings per image rather than using one fixed quality

## Deploying

Copy the whole folder to a web server. There is no build step and no dependencies to install.

It must be served over HTTP rather than opened from disk, because the encoders are loaded as modules.
Each encoder downloads only when a visitor first picks that format, so a plain JPG conversion never
fetches the 3.5 MB AVIF encoder.

Deployed on Cloudflare Pages, which serves WebAssembly with the right content type without any
configuration. The tool is public and indexable.

## How settings are chosen

Rather than one quality for everything, each format adapts:

- **JPG** encodes both colour modes and keeps reduced colour only when it costs little, raises quality
  for small images and for graphics, and steps quality up if a photo lands below a fidelity floor
- **PNG** searches for the smallest palette that still clears a quality target
- **AVIF** is written at 10 bits with an explicit colour tag, which some decoders need to show it correctly
- **JXL** scales images over 18 megapixels down to fit, because the encoder exhausts browser memory above that

The reasoning behind each number is in the comments at the top of `app.js`.

## Third-party encoders

`vendor/` holds WebAssembly builds of MozJPEG, libimagequant, OxiPNG, libwebp, libaom and libjxl, plus
pica for resizing and libheif for reading HEIC. Each carries its own licence, and libimagequant is GPL.
