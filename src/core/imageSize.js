/**
 * Read the pixel dimensions of an image from its header bytes.
 *
 * Spread layout needs to know which pages are wider than they are tall, and
 * doing that by decoding every page would be far more expensive than reading a
 * few header bytes. Each parser returns null when the supplied prefix is too
 * short or malformed, so callers must treat "unknown size" as a real outcome.
 */

const ascii = (bytes, offset, length) =>
  bytes.toString("latin1", offset, Math.min(offset + length, bytes.length));

/** Image container identified by signature bytes. */
export const sniffImageFormat = (bytes) => {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  return null;
};

const pngSize = (bytes) => {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const gifSize = (bytes) => {
  if (bytes.length < 10) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
};

const bmpSize = (bytes) => {
  if (bytes.length < 26) return null;
  return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
};

const webpSize = (bytes) => {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const width = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    const height = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
    return { width: width + 1, height: height + 1 };
  }
  return null;
};

/** JPEG scan: SOF0..SOF15 carry the frame size, excluding DHT/JPG/DAC. */
const jpegSize = (bytes) => {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 9 > bytes.length) return null;
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
};

/**
 * Dimensions and container format for an image header prefix.
 * Returns null when the format is unknown or the prefix does not carry the size.
 */
export const imageSize = (bytes) => {
  const format = sniffImageFormat(bytes);
  if (format === null) return null;
  const size =
    format === "png"
      ? pngSize(bytes)
      : format === "jpeg"
        ? jpegSize(bytes)
        : format === "gif"
          ? gifSize(bytes)
          : format === "bmp"
            ? bmpSize(bytes)
            : webpSize(bytes);
  if (size === null || size.width <= 0 || size.height <= 0) return null;
  return { format, width: size.width, height: size.height };
};

/** HTTP content type for a sniffed format. */
export const mimeForFormat = (format) =>
  ({
    png: "image/png",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
  })[format] ?? "application/octet-stream";
