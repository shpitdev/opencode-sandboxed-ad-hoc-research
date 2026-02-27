type BuildRunCommandInput = {
  resolveOpencodeBinCommand: string;
  workingDir: string;
  prompt: string;
  model: string;
  variant?: string;
  forwardedEnvEntries?: Array<[string, string]>;
};

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildInstallOpencodeCommand(): string {
  return [
    "if command -v bun >/dev/null 2>&1; then",
    '  echo "[bootstrap] Attempting OpenCode install via bun..."',
    "  if bun add -g opencode-ai@latest; then exit 0; fi",
    '  echo "[bootstrap] bun install failed; falling back to npm..." >&2',
    "fi",
    'npm install -g opencode-ai@latest --prefix "$HOME/.local" --no-audit --no-fund',
  ].join("\n");
}

export function buildOpencodeRunCommand(input: BuildRunCommandInput): string {
  const modelArg = ` --model ${shellEscape(input.model)}`;
  const variantArg = input.variant ? ` --variant ${shellEscape(input.variant)}` : "";
  const forwardedEnvArgs = (input.forwardedEnvEntries ?? [])
    .map(([name, value]) => `${name}=${shellEscape(value)}`)
    .join(" ");

  return (
    `OPENCODE_BIN="$(${input.resolveOpencodeBinCommand})"; ` +
    `cd ${shellEscape(input.workingDir)} && ` +
    `${forwardedEnvArgs ? `env ${forwardedEnvArgs} ` : ""}` +
    `"${"$"}OPENCODE_BIN" run --print-logs${modelArg}${variantArg} ${shellEscape(input.prompt)}`
  );
}
