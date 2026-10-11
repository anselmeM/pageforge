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
