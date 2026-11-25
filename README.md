# Picomp

**Live at [picomp.app](https://picomp.app)**

Image compressor and converter that runs entirely in the browser. Every image is decoded, resized and
encoded on the visitor's own device, and the server only delivers the static files.

## What it does

- Compresses and converts between **JPG, PNG, WebP, AVIF and JXL**
- Reads **HEIC** and **JXL** as well
- Optional resize to a chosen width
- Optional **EXIF** copying, off by default so location data is not published by accident
- Picks encoder settings per image rather than using one fixed quality

## Deploying

Copy the whole folder to a web server. There is no build step and no dependencies to install.

It must be served from a web server rather than opened from disk, because the encoders load as modules.
Each encoder downloads the first time a visitor picks that format, so a JPG conversion skips the
3.5 MB AVIF encoder.

## How settings are chosen

Each format adapts its settings to the image.

- **JPG** encodes both colour modes and keeps reduced colour only when it costs little, raises quality
  for small images, graphics and sources that were not already JPEG,
  and steps quality up if a photo lands below a fidelity floor
- **PNG** searches for the smallest palette that still clears a quality target, then gives small, strongly
  coloured areas such as jewellery a second chance at palette colours
- **WebP** raises quality for photos from sources that were not already JPEG, so fine texture such as
  skin survives
- **AVIF** is written at 10 bits with an explicit colour tag, which some decoders need to show it correctly
- **JXL** scales images over 18 megapixels down to fit, because the encoder exhausts browser memory above that

The reasoning behind each number is in the comments at the top of `app.js`.

## Third-party encoders

`vendor/` holds WebAssembly builds of MozJPEG, libimagequant, OxiPNG, libwebp, libaom and libjxl, plus
pica for resizing and libheif for reading HEIC. Each carries its own licence, and libimagequant is GPL.
