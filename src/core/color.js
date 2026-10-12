/**
 * Colour handling.
 *
 * The arithmetic lives here so it can be tested without a window: estimating a
 * white balance from a page's channel averages, and turning the chosen settings
 * into the parameters an SVG filter uses.
 *
 * The filter is declarative (`feComponentTransfer` plus `feColorMatrix`) rather
 * than a WebGL pass, so it applies equally to page images and to PDF canvases
 * and costs nothing to re-apply when the settings change.
 */

/** Per-channel gains that leave a page untouched. */
export const IDENTITY_GAINS = { r: 1, g: 1, b: 1 };

/** Gains are clamped so a nearly monochrome page cannot be pushed to nonsense. */
const MIN_GAIN = 0.5;
const MAX_GAIN = 2;

/**
 * Grey-world white balance: make the channel averages match, on the assumption
 * that a page of artwork averages out to neutral. `sensitivity` blends between
 * no correction (0) and the full estimate (1).
 *
 * A channel that is absent or zero cannot be estimated, so the page is left
 * alone rather than divided by nothing.
 */
export const computeWhiteBalanceGains = (means, sensitivity = 1) => {
  const channels = ["r", "g", "b"];
  const channelMeans = channels.map((channel) => means?.[channel]);
  if (channelMeans.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    return { ...IDENTITY_GAINS };
  }
  const [red, green, blue] = channelMeans;
  const target = (red + green + blue) / 3;
  const strength = Math.min(1, Math.max(0, Number.isFinite(sensitivity) ? sensitivity : 1));
  const gains = {};
  channels.forEach((channel, index) => {
    const raw = target / channelMeans[index];
    const bounded = Math.min(MAX_GAIN, Math.max(MIN_GAIN, raw));
    gains[channel] = 1 + (bounded - 1) * strength;
  });
  return gains;
};

/**
 * Filter parameters for the chosen settings.
 *
 * `saturation` is a plain saturation matrix: it stands in for perceptual
 * vibrance, which a linear colour matrix cannot express. It is documented as an
 * approximation rather than presented as the same control.
 */
export const colorFilterParameters = (preferences, gains = IDENTITY_GAINS) => {
  const mode = preferences?.colorMode ?? "off";
  const active = mode !== "off";
  const vibrance = active ? (preferences?.vibrance ?? 0) : 0;
  return {
    active,
    r: active ? gains.r : 1,
    g: active ? gains.g : 1,
    b: active ? gains.b : 1,
    exponent: active ? (preferences?.gamma ?? 1) : 1,
    saturation: 1 + Math.min(1, Math.max(0, vibrance)),
  };
};

/** Mean colour of raw RGBA pixels, as 0..255 channel averages. */
export const averageChannelMeans = (pixels) => {
  if (!pixels || pixels.length < 4) return null;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue;
    red += pixels[index];
    green += pixels[index + 1];
    blue += pixels[index + 2];
    count += 1;
  }
  if (count === 0) return null;
  return { r: red / count, g: green / count, b: blue / count };
};

const clamp = (value, low, high, fallback) => {
  const number = Number.isFinite(value) ? value : fallback;
  return Math.min(high, Math.max(low, number));
};

/**
 * Scan-enhancement parameters: brightness, contrast, grayscale, sepia and
 * sharpening. These are independent of colour correction — they are about
 * making a poor scan readable, not about neutralising a cast.
 *
 * Brightness and contrast fold into one linear stage, which is the standard
 * `value * (brightness * contrast) + 0.5 * (1 - contrast)` curve.
 */
export const scanFilterParameters = (preferences) => {
  const brightness = clamp(preferences?.brightness, 0.5, 2, 1);
  const contrast = clamp(preferences?.contrast, 0.5, 2, 1);
  const grayscale = clamp(preferences?.grayscale, 0, 1, 0);
  const sepia = clamp(preferences?.sepia, 0, 1, 0);
  const sharpen = preferences?.sharpen === true;
  return {
    active: brightness !== 1 || contrast !== 1 || grayscale > 0 || sepia > 0 || sharpen,
    slope: brightness * contrast,
    intercept: 0.5 * (1 - contrast),
    /** Saturation matrix value that removes `grayscale` of the colour. */
    saturation: 1 - grayscale,
    sepia,
    sharpen,
    sharpenAmount: clamp(preferences?.sharpenAmount, 0, 1, 0.35),
  };
};

/** Identity 4x5 colour matrix, in feColorMatrix's `values` order. */
export const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

/** The classic sepia matrix, applied at full strength. */
const SEPIA_MATRIX = [
  0.393, 0.769, 0.189, 0, 0,
  0.349, 0.686, 0.168, 0, 0,
  0.272, 0.534, 0.131, 0, 0,
  0, 0, 0, 1, 0,
];

/**
 * Sepia blended between no effect and full sepia, as one matrix.
 *
 * Interpolating the matrix rather than chaining a partial-opacity node keeps the
 * whole chain a single pass, and makes the blend a pure function of the amount.
 */
export const sepiaMatrix = (amount) => {
  const strength = clamp(amount, 0, 1, 0);
  return IDENTITY_MATRIX.map(
    (value, index) => value + (SEPIA_MATRIX[index] - value) * strength,
  );
};

/**
 * A 3x3 unsharp kernel scaled by `amount`: the centre gains the neighbour
 * weights, so total luminance is preserved and only edge contrast changes.
 */
export const sharpenKernel = (amount) => {
  const strength = clamp(amount, 0, 1, 0);
  // settle: -0 is not 0 to a strict comparison, and an identity kernel should
  // read as plain zeros.
  const negative = strength === 0 ? 0 : -strength;
  return [
    0, negative, 0,
    negative, 1 + 4 * strength, negative,
    0, negative, 0,
  ];
};
