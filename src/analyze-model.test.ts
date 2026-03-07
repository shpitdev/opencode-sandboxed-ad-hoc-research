import { afterEach, describe, expect, test } from "bun:test";
import { resolveAnalyzeModel } from "./analyze-model.js";

const originalCi = process.env.CI;
const originalModel = process.env.OPENCODE_ANALYZE_MODEL;
const originalVariant = process.env.OPENCODE_ANALYZE_VARIANT;
const originalVisionModel = process.env.OPENCODE_ANALYZE_VISION_MODEL;

afterEach(() => {
  process.env.CI = originalCi;
  process.env.OPENCODE_ANALYZE_MODEL = originalModel;
  process.env.OPENCODE_ANALYZE_VARIANT = originalVariant;
  process.env.OPENCODE_ANALYZE_VISION_MODEL = originalVisionModel;
});

describe("resolveAnalyzeModel", () => {
  test("uses default non-vision model", () => {
    delete process.env.OPENCODE_ANALYZE_MODEL;
    delete process.env.OPENCODE_ANALYZE_VARIANT;
    delete process.env.OPENCODE_ANALYZE_VISION_MODEL;

    const resolved = resolveAnalyzeModel({});
    expect(resolved.model).toBe("opencode-go/glm-5");
    expect(resolved.variant).toBeUndefined();
  });

  test("uses vision default when requested", () => {
    delete process.env.OPENCODE_ANALYZE_MODEL;
    delete process.env.OPENCODE_ANALYZE_VARIANT;
    delete process.env.OPENCODE_ANALYZE_VISION_MODEL;

    const resolved = resolveAnalyzeModel({ vision: true });
    expect(resolved.model).toBe("zai-coding-plan/glm-4.6v");
    expect(resolved.variant).toBeUndefined();
  });

  test("does not force default variant when model is overridden by env", () => {
    process.env.OPENCODE_ANALYZE_MODEL = "opencode-go/glm-5";
    delete process.env.OPENCODE_ANALYZE_VARIANT;

    const resolved = resolveAnalyzeModel({});
    expect(resolved.model).toBe("opencode-go/glm-5");
    expect(resolved.variant).toBeUndefined();
  });

  test("respects env overrides", () => {
    process.env.OPENCODE_ANALYZE_MODEL = "opencode-go/kimi-k2.5";
    process.env.OPENCODE_ANALYZE_VARIANT = "fast";

    const resolved = resolveAnalyzeModel({});
    expect(resolved.model).toBe("opencode-go/kimi-k2.5");
    expect(resolved.variant).toBe("fast");
  });

  test("cli args override env", () => {
    process.env.OPENCODE_ANALYZE_MODEL = "opencode-go/glm-5";
    process.env.OPENCODE_ANALYZE_VARIANT = "low";

    const resolved = resolveAnalyzeModel({
      model: "anthropic/claude-sonnet-4-6",
      variant: "high",
    });

    expect(resolved.model).toBe("anthropic/claude-sonnet-4-6");
    expect(resolved.variant).toBe("high");
  });

  test("uses env vision override", () => {
    delete process.env.OPENCODE_ANALYZE_MODEL;
    process.env.OPENCODE_ANALYZE_VISION_MODEL = "zhipuai-coding-plan/glm-4.6v-flash";
    const resolved = resolveAnalyzeModel({ vision: true });
    expect(resolved.model).toBe("zhipuai-coding-plan/glm-4.6v-flash");
  });
});
