/**
 * Dependency-free PNG decoding for evidence recorders that compare rendered
 * frames pixel by pixel.
 *
 * The decoder is deliberately narrow: it accepts exactly the shapes a headless
 * or headed browser screenshot produces (8-bit truecolour, with or without an
 * alpha channel, non-interlaced) and throws on anything else rather than
 * guessing. Comparing the bytes a recorder already committed as a screenshot
 * means the pixels an evidence record claims to have compared are the pixels a
 * reader can decode from the record itself.
 */

import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel for the truecolour colour types this decoder accepts. */
const CHANNELS_BY_COLOUR_TYPE = new Map([
  [2, 3],
  [6, 4],
]);

/**
 * @typedef {object} DecodedPng
 * @property {number} width Pixel width.
 * @property {number} height Pixel height.
 * @property {number} channels Samples per pixel: 3 for RGB, 4 for RGBA.
 * @property {Uint8Array} data Row-major samples, `width * height * channels` long.
 */

/**
 * Decode an 8-bit non-interlaced truecolour PNG.
 *
 * @param {Buffer} buffer Complete PNG file bytes.
 * @returns {DecodedPng}
 */
export function decodePng(buffer) {
  if (buffer.length < SIGNATURE.length || !buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  let offset = SIGNATURE.length;
  /** @type {{width: number, height: number, channels: number} | undefined} */
  let header;
  /** @type {Buffer[]} */
  const data = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = readHeader(body);
    } else if (type === "IDAT") {
      data.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
  }
  if (header === undefined) throw new Error("PNG has no IHDR chunk");
  if (data.length === 0) throw new Error("PNG has no IDAT chunk");
  return {
    ...header,
    data: unfilter(inflateSync(Buffer.concat(data)), header),
  };
}

/**
 * @param {Buffer} body IHDR chunk body.
 * @returns {{width: number, height: number, channels: number}}
 */
function readHeader(body) {
  if (body.length < 13) throw new Error("PNG IHDR chunk is truncated");
  const width = body.readUInt32BE(0);
  const height = body.readUInt32BE(4);
  const bitDepth = body.readUInt8(8);
  const colourType = body.readUInt8(9);
  const interlace = body.readUInt8(12);
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}, expected 8`);
  if (interlace !== 0) throw new Error("unsupported interlaced PNG");
  const channels = CHANNELS_BY_COLOUR_TYPE.get(colourType);
  if (channels === undefined) {
    throw new Error(`unsupported PNG colour type ${colourType}, expected 2 or 6`);
  }
  if (width === 0 || height === 0) throw new Error("PNG declares an empty image");
  return { width, height, channels };
}

/**
 * Reverse the per-scanline filters PNG applies before compression.
 *
 * @param {Buffer} raw Inflated scanlines, each prefixed by its filter type.
 * @param {{width: number, height: number, channels: number}} header
 * @returns {Uint8Array}
 */
function unfilter(raw, header) {
  const { width, height, channels } = header;
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length !== expected) {
    throw new Error(`PNG payload is ${raw.length} bytes, expected ${expected}`);
  }
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x] ?? 0;
      const left = x >= channels ? (out[row + x - channels] ?? 0) : 0;
      const up = y > 0 ? (out[previous + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (out[previous + x - channels] ?? 0) : 0;
      out[row + x] = (value + reconstruct(filter, left, up, upLeft)) & 0xff;
    }
  }
  return out;
}

/**
 * @param {number} filter PNG filter type 0-4.
 * @param {number} left Reconstructed sample to the left.
 * @param {number} up Reconstructed sample above.
 * @param {number} upLeft Reconstructed sample above and to the left.
 * @returns {number}
 */
function reconstruct(filter, left, up, upLeft) {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      throw new Error(`unsupported PNG filter type ${filter}`);
  }
}

/**
 * @param {number} a Sample to the left.
 * @param {number} b Sample above.
 * @param {number} c Sample above and to the left.
 * @returns {number}
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * The most frequent opaque colour in a frame, as a `#rrggbb` string with the
 * share of pixels holding it. A Studio frame clears to one flat colour, so the
 * mode identifies the background exactly; the share is reported so a reader can
 * see when that assumption stops holding.
 *
 * @param {DecodedPng} image
 * @returns {{colour: string, share: number}}
 */
export function modalColour(image) {
  const { data, channels, width, height } = image;
  const counts = new Map();
  const pixels = width * height;
  for (let i = 0; i < pixels; i += 1) {
    const base = i * channels;
    const key = ((data[base] ?? 0) << 16) | ((data[base + 1] ?? 0) << 8) | (data[base + 2] ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return {
    colour: `#${best.toString(16).padStart(6, "0")}`,
    share: bestCount / pixels,
  };
}

/**
 * @typedef {object} PixelWindow
 * @property {number} x0 Inclusive left edge, in pixels.
 * @property {number} y0 Inclusive top edge, in pixels.
 * @property {number} x1 Exclusive right edge, in pixels.
 * @property {number} y1 Exclusive bottom edge, in pixels.
 */

/**
 * Resolve a window given as fractions of the frame into whole pixels.
 *
 * @param {DecodedPng} image
 * @param {{x0: number, y0: number, x1: number, y1: number}} fractions
 * @returns {PixelWindow}
 */
export function resolveWindow(image, fractions) {
  const x0 = Math.round(fractions.x0 * image.width);
  const x1 = Math.round(fractions.x1 * image.width);
  const y0 = Math.round(fractions.y0 * image.height);
  const y1 = Math.round(fractions.y1 * image.height);
  if (x0 < 0 || y0 < 0 || x1 > image.width || y1 > image.height || x1 <= x0 || y1 <= y0) {
    throw new Error(`window ${JSON.stringify(fractions)} does not lie inside the frame`);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Test whether a pixel departs from the frame's background colour.
 *
 * @param {DecodedPng} image
 * @param {number} backgroundKey Packed 24-bit background colour.
 * @param {number} tolerance
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function covers(image, backgroundKey, tolerance, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
  const base = (y * image.width + x) * image.channels;
  const red = (backgroundKey >> 16) & 0xff;
  const green = (backgroundKey >> 8) & 0xff;
  const blue = backgroundKey & 0xff;
  const delta = Math.max(
    Math.abs((image.data[base] ?? 0) - red),
    Math.abs((image.data[base + 1] ?? 0) - green),
    Math.abs((image.data[base + 2] ?? 0) - blue),
  );
  return delta > tolerance;
}

/**
 * @typedef {object} GeometryCoverage
 * @property {string} backgroundColour Mode of the frame.
 * @property {number} backgroundShare Share of the frame holding it.
 * @property {number} pixels Pixels inside the window that depart from it.
 * @property {?{minX: number, maxX: number, minY: number, maxY: number}} bounds
 */

/**
 * Measure what a frame draws inside a window, against its own background.
 *
 * @param {DecodedPng} image
 * @param {PixelWindow} window
 * @param {number} tolerance
 * @returns {GeometryCoverage}
 */
export function geometryCoverage(image, window, tolerance) {
  const background = modalColour(image);
  const backgroundKey = Number.parseInt(background.colour.slice(1), 16);
  let pixels = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = window.y0; y < window.y1; y += 1) {
    for (let x = window.x0; x < window.x1; x += 1) {
      if (!covers(image, backgroundKey, tolerance, x, y)) continue;
      pixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    backgroundColour: background.colour,
    backgroundShare: background.share,
    pixels,
    bounds: pixels === 0 ? null : { minX, maxX, minY, maxY },
  };
}

/**
 * Lay a lattice over a bounding box and keep the points that sit on drawn
 * pixels away from a silhouette edge, so a pick at that point lands on a part
 * rather than on the seam between a part and the background.
 *
 * @param {DecodedPng} image The frame the points are derived from.
 * @param {{minX: number, maxX: number, minY: number, maxY: number}} bounds
 * @param {number} steps Lattice resolution along each axis.
 * @param {number} tolerance
 * @returns {{x: number, y: number}[]} Points in pixels, row-major.
 */
export function latticePoints(image, bounds, steps, tolerance) {
  const background = modalColour(image);
  const backgroundKey = Number.parseInt(background.colour.slice(1), 16);
  const points = [];
  for (let row = 0; row < steps; row += 1) {
    for (let column = 0; column < steps; column += 1) {
      const x = Math.round(bounds.minX + ((bounds.maxX - bounds.minX) * column) / (steps - 1));
      const y = Math.round(bounds.minY + ((bounds.maxY - bounds.minY) * row) / (steps - 1));
      const interior =
        covers(image, backgroundKey, tolerance, x, y) &&
        covers(image, backgroundKey, tolerance, x - 1, y) &&
        covers(image, backgroundKey, tolerance, x + 1, y) &&
        covers(image, backgroundKey, tolerance, x, y - 1) &&
        covers(image, backgroundKey, tolerance, x, y + 1);
      if (interior) points.push({ x, y });
    }
  }
  return points;
}

/**
 * @typedef {object} AgreementTier
 * @property {number} pixels Pixels the tier covers.
 * @property {number} differingPixels Pixels differing by more than the tolerance.
 * @property {number} agreementRatio Share that agrees.
 */

/**
 * @typedef {object} FrameComparison
 * @property {number} channelTolerance
 * @property {string} backgroundColour
 * @property {number} backgroundShare
 * @property {AgreementTier} frame Every pixel of the capture.
 * @property {AgreementTier & PixelWindow} window The declared analysis window.
 * @property {AgreementTier & {bounds: ?object}} geometry Drawn pixels inside it.
 * @property {number} maximumChannelDelta
 */

/**
 * Compare two frames at three tiers: the whole capture, a declared analysis
 * window, and the pixels the reference draws inside that window. The window
 * exists because a capture of the viewport composites the Studio's own chrome
 * over the canvas, and chrome pixels are identical in both arms; counting them
 * as geometry would flatter every ratio.
 *
 * @param {DecodedPng} reference
 * @param {DecodedPng} candidate
 * @param {{tolerance: number, window: PixelWindow}} options
 * @returns {FrameComparison}
 */
export function compareFrames(reference, candidate, options) {
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `frames differ in size: ${reference.width}x${reference.height} and ${candidate.width}x${candidate.height}`,
    );
  }
  const { tolerance, window } = options;
  const background = modalColour(reference);
  const backgroundKey = Number.parseInt(background.colour.slice(1), 16);
  let framePixels = 0;
  let frameDiffering = 0;
  let windowPixels = 0;
  let windowDiffering = 0;
  let geometryPixels = 0;
  let geometryDiffering = 0;
  let maximumChannelDelta = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < reference.height; y += 1) {
    for (let x = 0; x < reference.width; x += 1) {
      const referenceBase = (y * reference.width + x) * reference.channels;
      const candidateBase = (y * candidate.width + x) * candidate.channels;
      let delta = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(
          (reference.data[referenceBase + channel] ?? 0) - (candidate.data[candidateBase + channel] ?? 0),
        );
        if (difference > delta) delta = difference;
      }
      if (delta > maximumChannelDelta) maximumChannelDelta = delta;
      const differs = delta > tolerance;
      framePixels += 1;
      if (differs) frameDiffering += 1;
      if (x < window.x0 || x >= window.x1 || y < window.y0 || y >= window.y1) continue;
      windowPixels += 1;
      if (differs) windowDiffering += 1;
      if (!covers(reference, backgroundKey, tolerance, x, y)) continue;
      geometryPixels += 1;
      if (differs) geometryDiffering += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const ratio = (differing, total) => (total === 0 ? 1 : Number(((total - differing) / total).toFixed(6)));
  return {
    channelTolerance: tolerance,
    backgroundColour: background.colour,
    backgroundShare: background.share,
    frame: { pixels: framePixels, differingPixels: frameDiffering, agreementRatio: ratio(frameDiffering, framePixels) },
    window: {
      ...window,
      pixels: windowPixels,
      differingPixels: windowDiffering,
      agreementRatio: ratio(windowDiffering, windowPixels),
    },
    geometry: {
      pixels: geometryPixels,
      differingPixels: geometryDiffering,
      agreementRatio: ratio(geometryDiffering, geometryPixels),
      bounds: geometryPixels === 0 ? null : { minX, maxX, minY, maxY },
    },
    maximumChannelDelta,
  };
}
