/** Unit tests for colour estimation and preference validation. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IDENTITY_GAINS,
  averageChannelMeans,
  colorFilterParameters,
  computeWhiteBalanceGains,
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

describe("preference validation", () => {
  it("has a rule for every default", () => {
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
