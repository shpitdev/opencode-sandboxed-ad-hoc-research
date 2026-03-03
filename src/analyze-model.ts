import process from "node:process";

export type AnalyzeModelInput = {
  model?: string;
  variant?: string;
  vision?: boolean;
};

export type ResolvedAnalyzeModel = {
  model: string;
  variant?: string;
};

export function resolveAnalyzeModel(input: AnalyzeModelInput): ResolvedAnalyzeModel {
  const modelOverride = input.model ?? process.env.OPENCODE_ANALYZE_MODEL;
  const defaultModel = input.vision
    ? (process.env.OPENCODE_ANALYZE_VISION_MODEL ?? "zai-coding-plan/glm-4.6v")
    : "openai/gpt-5.3-codex";
  const model = modelOverride ?? defaultModel;
  const defaultVariant = !input.vision && !modelOverride ? "high" : undefined;
  const variant = input.variant ?? process.env.OPENCODE_ANALYZE_VARIANT ?? defaultVariant;

  return {
    model,
    variant,
  };
}
