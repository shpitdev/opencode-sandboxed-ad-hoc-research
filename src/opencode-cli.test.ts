import { describe, expect, test } from "bun:test";
import {
  buildInstallOpencodeCommand,
  buildOpencodeModelsCommand,
  buildOpencodeRunCommand,
} from "./opencode-cli.js";

describe("buildInstallOpencodeCommand", () => {
  test("tries bun first and falls back to npm", () => {
    const command = buildInstallOpencodeCommand();

    expect(command).toContain("if command -v bun >/dev/null 2>&1; then");
    expect(command).toContain("bun add -g opencode-ai@latest");
    expect(command).toContain("falling back to npm");
    expect(command).toContain('npm install -g opencode-ai@latest --prefix "$HOME/.local"');
  });
});

describe("buildOpencodeRunCommand", () => {
  test("builds run command with cwd switch and provider env forwarding", () => {
    const command = buildOpencodeRunCommand({
      resolveOpencodeBinCommand: "command -v opencode",
      workingDir: "/home/daytona/audit/repo",
      prompt: "Reply with exactly one word: ready",
      model: "zai-coding-plan/glm-4.7-flash",
      variant: "high",
      forwardedEnvEntries: [
        ["OPENAI_API_KEY", "sk-test"],
        ["ZHIPU_API_KEY", "z-test"],
      ],
    });

    expect(command).toContain('OPENCODE_BIN="$(command -v opencode)"');
    expect(command).toContain("cd '/home/daytona/audit/repo'");
    expect(command).toContain("env OPENAI_API_KEY='sk-test' ZHIPU_API_KEY='z-test'");
    expect(command).toContain("--model 'zai-coding-plan/glm-4.7-flash'");
    expect(command).toContain("--variant 'high'");
    expect(command).not.toContain("--dir");
  });
});

describe("buildOpencodeModelsCommand", () => {
  test("builds provider model-list command with forwarded env", () => {
    const command = buildOpencodeModelsCommand({
      resolveOpencodeBinCommand: "command -v opencode",
      provider: "anthropic",
      forwardedEnvEntries: [["OPENROUTER_API_KEY", "or-key"]],
    });

    expect(command).toContain('OPENCODE_BIN="$(command -v opencode)"');
    expect(command).toContain("env OPENROUTER_API_KEY='or-key'");
    expect(command).toContain("\"$OPENCODE_BIN\" models 'anthropic'");
  });
});
