/** Unit tests for colour estimation and preference validation. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IDENTITY_GAINS,
  IDENTITY_MATRIX,
  averageChannelMeans,
  colorFilterParameters,
  computeWhiteBalanceGains,
  scanFilterParameters,
  sepiaMatrix,
  sharpenKernel,
} from "../src/core/color.js";
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_RULES,
  coercePreference,
  normalizePreferences,
} from "../src/core/library.js";

describe("white balance estimate", () => {
  it("leaves a neutral page alone", () => {
    const gains = computeWhiteBalanceGains({ r: 128, g: 128, b: 128 });
    assert.ok(Math.abs(gains.r - 1) < 1e-9);
    assert.ok(Math.abs(gains.g - 1) < 1e-9);
    assert.ok(Math.abs(gains.b - 1) < 1e-9);
  });

  it("pulls a colour cast back toward neutral", () => {
    const gains = computeWhiteBalanceGains({ r: 180, g: 120, b: 100 });
    assert.ok(gains.r < 1, "a strong red cast is reduced");
    assert.ok(gains.g > 1);
    assert.ok(gains.b > 1);
  });

  it("does nothing at zero sensitivity", () => {
    const gains = computeWhiteBalanceGains({ r: 200, g: 100, b: 50 }, 0);
    assert.deepEqual(gains, IDENTITY_GAINS);
  });

  it("applies half the correction at half sensitivity", () => {
    const full = computeWhiteBalanceGains({ r: 180, g: 120, b: 100 }, 1);
    const half = computeWhiteBalanceGains({ r: 180, g: 120, b: 100 }, 0.5);
    assert.ok(Math.abs(half.r - (1 + (full.r - 1) * 0.5)) < 1e-12);
  });

  it("bounds an extreme cast", () => {
    const gains = computeWhiteBalanceGains({ r: 255, g: 255, b: 1 });
    assert.ok(gains.b <= 2 && gains.b >= 0.5);
    assert.ok(gains.r <= 2 && gains.r >= 0.5);
  });

  it("refuses to guess from unusable input", () => {
    assert.deepEqual(computeWhiteBalanceGains(null), IDENTITY_GAINS);
    assert.deepEqual(computeWhiteBalanceGains({ r: 100, g: 0, b: 100 }), IDENTITY_GAINS);
    assert.deepEqual(computeWhiteBalanceGains({ r: 100, g: Number.NaN, b: 100 }), IDENTITY_GAINS);
  });

  it("clamps sensitivity outside its range", () => {
    const over = computeWhiteBalanceGains({ r: 180, g: 120, b: 100 }, 5);
    const normal = computeWhiteBalanceGains({ r: 180, g: 120, b: 100 }, 1);
    assert.deepEqual(over, normal);
  });
});

describe("channel averages", () => {
  it("averages opaque pixels only", () => {
    const pixels = new Uint8ClampedArray([
      10, 20, 30, 255, 20, 40, 60, 255, 0, 0, 0, 0,
    ]);
    assert.deepEqual(averageChannelMeans(pixels), { r: 15, g: 30, b: 45 });
  });

  it("reports nothing for an empty or fully transparent sample", () => {
    assert.equal(averageChannelMeans(new Uint8ClampedArray([])), null);
    assert.equal(averageChannelMeans(new Uint8ClampedArray([1, 2, 3, 0])), null);
  });
});

describe("colour filter parameters", () => {
  it("is bypassed when colour handling is off", () => {
    const parameters = colorFilterParameters({ colorMode: "off", vibrance: 1, gamma: 2 }, { r: 0.5, g: 1, b: 2 });
    assert.equal(parameters.active, false);
    assert.equal(parameters.r, 1);
    assert.equal(parameters.saturation, 1);
    assert.equal(parameters.exponent, 1);
  });

  it("passes the gains and manual settings through when active", () => {
    const parameters = colorFilterParameters(
      { colorMode: "manual", vibrance: 0.5, gamma: 1.4 },
      { r: 0.9, g: 1, b: 1.1 },
    );
    assert.equal(parameters.active, true);
    assert.equal(parameters.r, 0.9);
    assert.equal(parameters.exponent, 1.4);
    assert.ok(Math.abs(parameters.saturation - 1.5) < 1e-9);
  });

  it("bounds vibrance", () => {
    assert.equal(colorFilterParameters({ colorMode: "manual", vibrance: 9 }).saturation, 2);
    assert.equal(colorFilterParameters({ colorMode: "manual", vibrance: -9 }).saturation, 1);
  });
});

describe("scan enhancement", () => {
  it("is inactive at neutral settings", () => {
    const parameters = scanFilterParameters({});
    assert.equal(parameters.active, false);
    assert.equal(parameters.slope, 1);
    assert.equal(parameters.intercept, 0);
    assert.equal(parameters.saturation, 1);
    assert.equal(parameters.sepia, 0);
    assert.equal(parameters.sharpen, false);
  });

  it("folds brightness and contrast into one linear stage", () => {
    const parameters = scanFilterParameters({ brightness: 1.2, contrast: 1.5 });
    assert.ok(Math.abs(parameters.slope - 1.8) < 1e-12, `slope was ${parameters.slope}`);
    assert.equal(parameters.intercept, 0.5 * (1 - 1.5));
  });

  it("turns grayscale into a saturation reduction", () => {
    assert.equal(scanFilterParameters({ grayscale: 1 }).saturation, 0);
    assert.equal(scanFilterParameters({ grayscale: 0.25 }).saturation, 0.75);
  });

  it("clamps out-of-range values", () => {
    const parameters = scanFilterParameters({ brightness: 99, contrast: -5, grayscale: 9, sepia: -2 });
    assert.equal(parameters.slope, 2 * 0.5);
    assert.equal(parameters.saturation, 0);
    assert.equal(parameters.sepia, 0);
  });

  it("reports activity for any single non-neutral control", () => {
    assert.equal(scanFilterParameters({ brightness: 1.1 }).active, true);
    assert.equal(scanFilterParameters({ sepia: 0.1 }).active, true);
    assert.equal(scanFilterParameters({ sharpen: true }).active, true);
  });
});

describe("sepia blend", () => {
  it("is the identity at zero strength", () => {
    assert.deepEqual(sepiaMatrix(0), IDENTITY_MATRIX);
  });

  it("is the classic matrix at full strength", () => {
    const full = sepiaMatrix(1);
    assert.ok(Math.abs(full[0] - 0.393) < 1e-9);
    assert.ok(Math.abs(full[6] - 0.686) < 1e-9);
    assert.equal(full[18], 1, "alpha is untouched");
  });

  it("blends linearly between the two", () => {
    const half = sepiaMatrix(0.5);
    assert.ok(Math.abs(half[0] - (1 + (0.393 - 1) * 0.5)) < 1e-9);
    assert.equal(half.length, 20, "a 4x5 matrix, as feColorMatrix expects");
  });
});

describe("sharpen kernel", () => {
  it("is the identity kernel at zero strength", () => {
    assert.deepEqual(sharpenKernel(0), [0, 0, 0, 0, 1, 0, 0, 0, 0]);
  });

  it("preserves total luminance at any strength", () => {
    for (const amount of [0.2, 0.5, 1]) {
      const kernel = sharpenKernel(amount);
      const total = kernel.reduce((sum, value) => sum + value, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `kernel sums to ${total} at ${amount}`);
    }
  });

  it("puts the neighbour weight on the four orthogonal cells only", () => {
    const kernel = sharpenKernel(0.4);
    assert.equal(kernel[0], 0);
    assert.equal(kernel[2], 0);
    assert.equal(kernel[6], 0);
    assert.equal(kernel[8], 0);
    assert.equal(kernel[1], -0.4);
    assert.ok(Math.abs(kernel[4] - 2.6) < 1e-9);
  });
});

describe("preference validation", () => {  it("has a rule for every default", () => {
    for (const key of Object.keys(DEFAULT_PREFERENCES)) {
      assert.ok(PREFERENCE_RULES[key] !== undefined, `missing rule for ${key}`);
    }
    assert.deepEqual(
      Object.keys(PREFERENCE_RULES).sort(),
      Object.keys(DEFAULT_PREFERENCES).sort(),
    );
  });

  it("clamps numbers into range", () => {
    assert.equal(coercePreference("gamma", 99), 3);
    assert.equal(coercePreference("gamma", 0), 0.3);
    assert.equal(coercePreference("colorSensitivity", 0.42), 0.42);
  });

  it("rounds integer preferences", () => {
    assert.equal(coercePreference("prefetchPages", 4.6), 5);
  });

  it("rejects values of the wrong type or shape", () => {
    assert.equal(coercePreference("gamma", "1.2"), undefined);
    assert.equal(coercePreference("gamma", Number.NaN), undefined);
    assert.equal(coercePreference("resumeLastPage", "yes"), undefined);
    assert.equal(coercePreference("resampling", "bicubic"), undefined);
    assert.equal(coercePreference("unknownKey", 1), undefined);
  });

  it("fills in defaults around partial or damaged settings", () => {
    assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
    const merged = normalizePreferences({ gamma: 99, resampling: "nonsense", showThumbnails: true });
    assert.equal(merged.gamma, 3);
    assert.equal(merged.resampling, DEFAULT_PREFERENCES.resampling);
    assert.equal(merged.showThumbnails, true);
    assert.equal(merged.resumeLastPage, true);
  });
});
