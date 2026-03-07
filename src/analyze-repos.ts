import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { resolveAnalyzeModel } from "./analyze-model.js";
import { catalogAnalysisResult } from "./obsidian-catalog.js";
import {
  buildInstallOpencodeCommand,
  buildOpencodeModelsCommand,
  buildOpencodeRunCommand,
} from "./opencode-cli.js";
import {
  loadConfiguredEnv,
  type ResolvedSandcodeConfig,
  resolveSandcodeConfig,
} from "./sandcode-config.js";

type CliOptions = {
  inputFile?: string;
  outDir: string;
  createTimeoutSec: number;
  installTimeoutSec: number;
  analyzeTimeoutSec: number;
  keepSandbox: boolean;
  target?: string;
  model?: string;
  variant?: string;
  vision: boolean;
  urls: string[];
};

const SANDBOX_LIFECYCLE_POLICY = {
  autoStopInterval: 15,
  autoArchiveInterval: 30,
  autoDeleteInterval: -1,
} as const;

type DaytonaCompatClient = {
  configApi: {
    configControllerGetConfig: () => Promise<{
      data: {
        proxyToolboxUrl?: string;
      };
    }>;
  };
  getProxyToolboxUrl: (sandboxId: string, regionId: string) => Promise<string>;
};

type AnalyzeResult = {
  url: string;
  slug: string;
  localDir: string;
  findingsPath: string;
  readmePath?: string;
  obsidianNotePath?: string;
  success: boolean;
  error?: string;
};

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer. Received "${value}".`);
  }
  return parsed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function collectForwardedEnvEntries(): Array<[string, string]> {
  const allowedPrefixes = [
    "OPENCODE_",
    "OPENAI_",
    "AZURE_OPENAI_",
    "ANTHROPIC_",
    "XAI_",
    "GOOGLE_",
    "GOOGLE_GENERATIVE_AI_",
    "GROQ_",
    "MINIMAX_",
    "MISTRAL_",
    "ZHIPU_",
    "TOGETHER_",
    "DEEPSEEK_",
    "OPENROUTER_",
  ];

  const matchesPrefix = (name: string): boolean =>
    allowedPrefixes.some((prefix) => name.startsWith(prefix));

  return Object.entries(process.env)
    .filter((entry): entry is [string, string] => Boolean(entry[1]) && matchesPrefix(entry[0]))
    .sort(([a], [b]) => a.localeCompare(b));
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function slugFromRepoUrl(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.pathname.replace(/\/+$/g, "").split("/").filter(Boolean);
  const repo = (parts.at(-1) ?? "repo").replace(/\.git$/i, "");
  const owner = parts.at(-2) ?? parsed.hostname;
  return sanitizeSlug(`${owner}-${repo}`);
}

function formatDatePrefix(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeUrlCandidate(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/[),.;]+$/g, "");
  if (!cleaned.startsWith("http://") && !cleaned.startsWith("https://")) {
    return undefined;
  }
  try {
    const parsed = new URL(cleaned);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()"']+/g) ?? [];
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const candidate of matches) {
    const normalized = normalizeUrlCandidate(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }

  return ordered;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

function getLocalOpencodeConfigCandidates(): string[] {
  const home = process.env.HOME;
  if (!home) {
    return [];
  }
  return [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(home, ".config", "opencode", "config.json"),
    path.join(home, ".config", "opencode", "antigravity-accounts.json"),
  ];
}

async function getExistingLocalOpencodeConfigFiles(): Promise<string[]> {
  const candidates = getLocalOpencodeConfigCandidates();
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

function getLocalOpencodeAuthCandidates(): string[] {
  const home = process.env.HOME;
  if (!home) {
    return [];
  }
  return [path.join(home, ".local", "share", "opencode", "auth.json")];
}

async function getExistingLocalOpencodeAuthFiles(): Promise<string[]> {
  const candidates = getLocalOpencodeAuthCandidates();
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

function modelProvider(modelId: string): string | undefined {
  const slashIndex = modelId.indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  return modelId.slice(0, slashIndex).toLowerCase();
}

function parseModelListOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(line));
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/[._]/g, "-");
}

function findNormalizedModelMatch(
  requestedModel: string,
  availableModels: string[],
): string | undefined {
  const normalizedRequested = normalizeModelId(requestedModel);
  return availableModels.find((model) => normalizeModelId(model) === normalizedRequested);
}

export function formatAnalyzeHelp(invocation = "sandcode analyze"): string {
  return `Usage: ${invocation} [repo-url ...] [options]

Examples:
  sandcode analyze --input example.md
  sandcode analyze https://github.com/agenticnotetaking/arscontexta
  sandcode analyze links.md
  sandcode analyze --vision

Options:
  -i, --input <path>             Markdown/text file containing links
      --out-dir <dir>            Output directory for findings (default: findings)
      --create-timeout-sec <n>   Sandbox creation timeout (default: 180)
      --install-timeout-sec <n>  OpenCode install timeout (default: 900)
      --analyze-timeout-sec <n>  Per-repo analysis timeout (default: 2400)
      --target <name>            Daytona target override
      --model <provider/model>   OpenCode model (default: opencode-go/glm-5)
      --variant <name>           Model variant override
      --vision                   Prefer vision-capable default model (zai-coding-plan/glm-4.6v)
      --keep-sandbox             Keep each sandbox instead of deleting it
  -h, --help                     Show this help
`;
}

function parseCliOptions(args: string[]): CliOptions | undefined {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      input: { type: "string", short: "i" },
      "out-dir": { type: "string", default: "findings" },
      "create-timeout-sec": { type: "string", default: "180" },
      "install-timeout-sec": { type: "string", default: "900" },
      "analyze-timeout-sec": { type: "string", default: "2400" },
      "keep-sandbox": { type: "boolean", default: false },
      target: { type: "string" },
      model: { type: "string" },
      variant: { type: "string" },
      vision: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    return undefined;
  }

  const directInputFile =
    values.input === undefined &&
    positionals.length === 1 &&
    !normalizeUrlCandidate(positionals[0]) &&
    positionals[0].trim().length > 0
      ? positionals[0]
      : undefined;

  return {
    inputFile: values.input ?? directInputFile,
    outDir: values["out-dir"],
    createTimeoutSec: parsePositiveInt(values["create-timeout-sec"], "--create-timeout-sec"),
    installTimeoutSec: parsePositiveInt(values["install-timeout-sec"], "--install-timeout-sec"),
    analyzeTimeoutSec: parsePositiveInt(values["analyze-timeout-sec"], "--analyze-timeout-sec"),
    keepSandbox: values["keep-sandbox"],
    target: values.target,
    model: values.model,
    variant: values.variant,
    vision: values.vision,
    urls: directInputFile ? [] : positionals,
  };
}

async function resolveInputUrls(options: CliOptions): Promise<string[]> {
  const candidates: string[] = [];

  for (const raw of options.urls) {
    const normalized = normalizeUrlCandidate(raw);
    if (normalized) {
      candidates.push(normalized);
    }
  }

  const useDefaultInputFile = !options.inputFile && options.urls.length === 0;
  const inputFile =
    options.inputFile ??
    (useDefaultInputFile && (await fileExists("example.md")) ? "example.md" : undefined);
  if (inputFile) {
    const inputText = await readFile(inputFile, "utf8");
    candidates.push(...extractUrls(inputText));
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of candidates) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    unique.push(url);
  }

  if (unique.length === 0) {
    throw new Error("No valid URLs found. Provide URLs directly or via --input <file>.");
  }

  return unique;
}

function patchToolboxProxyUrlFallback(daytona: Daytona): void {
  const compat = daytona as unknown as DaytonaCompatClient;
  const originalResolver = compat.getProxyToolboxUrl.bind(compat);
  let cachedFallbackUrl: string | undefined;

  compat.getProxyToolboxUrl = async (sandboxId: string, regionId: string): Promise<string> => {
    try {
      return await originalResolver(sandboxId, regionId);
    } catch (error) {
      const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
      const message = String((error as { message?: string } | undefined)?.message ?? "");
      const isMissingEndpoint = statusCode === 404 || message.includes("toolbox-proxy-url");

      if (!isMissingEndpoint) {
        throw error;
      }

      if (!cachedFallbackUrl) {
        const configResponse = await compat.configApi.configControllerGetConfig();
        const candidate = configResponse.data.proxyToolboxUrl;
        if (!candidate) {
          throw new Error(
            "Daytona server is missing /sandbox/:id/toolbox-proxy-url and /config.proxyToolboxUrl fallback is empty.",
          );
        }
        cachedFallbackUrl = candidate;
        console.log(`[analyze] Using legacy toolbox fallback URL: ${cachedFallbackUrl}`);
      }

      const fallbackUrl = cachedFallbackUrl;
      if (!fallbackUrl) {
        throw new Error("Failed to resolve toolbox fallback URL.");
      }
      return fallbackUrl;
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function compactErrorMessage(error: unknown): string {
  const normalized = errorMessage(error).replace(/\s+/g, " ").trim();
  if (normalized.length <= 320) {
    return normalized;
  }
  return `${normalized.slice(0, 320)}...`;
}

function errorStatusCode(error: unknown): number | undefined {
  const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
  if (typeof statusCode === "number") {
    return statusCode;
  }
  return (error as { response?: { status?: number } } | undefined)?.response?.status;
}

function isRetryableDaytonaError(error: unknown): boolean {
  const statusCode = errorStatusCode(error);
  if (statusCode && [408, 429, 500, 502, 503, 504, 520, 522, 523, 524].includes(statusCode)) {
    return true;
  }

  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("error code 524") ||
    message.includes("a timeout occurred") ||
    message.includes("operation timed out") ||
    message.includes("cloudflare")
  );
}

function detectOpencodeFatalError(output: string): string | undefined {
  const lines = output.split("\n");
  const patterns = [
    /Error:\s*Model not found:/i,
    /API key is missing/i,
    /AI_LoadAPIKeyError/i,
    /AuthenticationError/i,
    /Token refresh failed/i,
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        return line.trim();
      }
    }
  }
  return undefined;
}

function hasReadyResponse(output: string): boolean {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .some((line) => line === "ready");
}

async function withRetries<T>(params: {
  label: string;
  maxAttempts?: number;
  run: () => Promise<T>;
}): Promise<T> {
  const maxAttempts = params.maxAttempts ?? 4;

  let attempt = 1;
  while (true) {
    try {
      return await params.run();
    } catch (error) {
      if (!isRetryableDaytonaError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const backoffMs = Math.min(2 ** (attempt - 1) * 1000, 8000);
      console.warn(
        `[analyze] Retryable failure in ${params.label} (attempt ${attempt}/${maxAttempts}): ${compactErrorMessage(error)}. Retrying in ${backoffMs}ms...`,
      );
      await sleep(backoffMs);
      attempt += 1;
    }
  }
}

async function runCommand(
  sandbox: Sandbox,
  command: string,
  timeoutSec: number,
): Promise<{ exitCode: number; output: string }> {
  const result = await withRetries({
    label: "executeCommand",
    run: async () => sandbox.process.executeCommand(command, undefined, undefined, timeoutSec),
  });
  return {
    exitCode: result.exitCode,
    output: result.result ?? "",
  };
}

async function downloadFileWithRetries(
  sandbox: Sandbox,
  remotePath: string,
  localPath: string,
): Promise<void> {
  await withRetries({
    label: `downloadFile(${remotePath})`,
    run: async () => sandbox.fs.downloadFile(remotePath, localPath),
  });
}

async function uploadFileWithRetries(
  sandbox: Sandbox,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await withRetries({
    label: `uploadFile(${path.basename(localPath)})`,
    run: async () => sandbox.fs.uploadFile(localPath, remotePath),
  });
}

async function requireSuccess(
  sandbox: Sandbox,
  command: string,
  label: string,
  timeoutSec: number,
): Promise<string> {
  const result = await runCommand(sandbox, command, timeoutSec);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}\n${result.output}`);
  }
  return result.output;
}

function buildEnsureGitCommand(): string {
  return [
    "if command -v git >/dev/null 2>&1; then exit 0; fi",
    'echo "[bootstrap] git not found; attempting install" >&2',
    "INSTALL_CMD=''",
    "if command -v apt-get >/dev/null 2>&1; then INSTALL_CMD='apt-get update && apt-get install -y git';",
    "elif command -v apk >/dev/null 2>&1; then INSTALL_CMD='apk add --no-cache git';",
    "elif command -v dnf >/dev/null 2>&1; then INSTALL_CMD='dnf install -y git';",
    "elif command -v microdnf >/dev/null 2>&1; then INSTALL_CMD='microdnf install -y git';",
    "elif command -v yum >/dev/null 2>&1; then INSTALL_CMD='yum install -y git';",
    "elif command -v pacman >/dev/null 2>&1; then INSTALL_CMD='pacman -Sy --noconfirm git';",
    "else echo 'No supported package manager found for git install' >&2; exit 127; fi",
    'if command -v sudo >/dev/null 2>&1; then sudo -n sh -lc "$INSTALL_CMD" || sh -lc "$INSTALL_CMD"; else sh -lc "$INSTALL_CMD"; fi',
    "command -v git >/dev/null 2>&1 || { echo 'git install failed' >&2; exit 127; }",
  ].join("\n");
}

function buildEnsureNodeCommand(): string {
  return [
    "if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then exit 0; fi",
    'echo "[bootstrap] node/npm not found; attempting install" >&2',
    "INSTALL_CMD=''",
    "if command -v apt-get >/dev/null 2>&1; then INSTALL_CMD='apt-get update && apt-get install -y nodejs npm';",
    "elif command -v apk >/dev/null 2>&1; then INSTALL_CMD='apk add --no-cache nodejs npm';",
    "elif command -v dnf >/dev/null 2>&1; then INSTALL_CMD='dnf install -y nodejs';",
    "elif command -v microdnf >/dev/null 2>&1; then INSTALL_CMD='microdnf install -y nodejs';",
    "elif command -v yum >/dev/null 2>&1; then INSTALL_CMD='yum install -y nodejs';",
    "elif command -v pacman >/dev/null 2>&1; then INSTALL_CMD='pacman -Sy --noconfirm nodejs npm';",
    "else echo 'No supported package manager found for node/npm install' >&2; exit 127; fi",
    'if command -v sudo >/dev/null 2>&1; then sudo -n sh -lc "$INSTALL_CMD" || sh -lc "$INSTALL_CMD"; else sh -lc "$INSTALL_CMD"; fi',
    "command -v node >/dev/null 2>&1 || { echo 'node install failed' >&2; exit 127; }",
    "command -v npm >/dev/null 2>&1 || { echo 'npm install failed' >&2; exit 127; }",
  ].join("\n");
}

async function runLongCommandWithPolling(params: {
  sandbox: Sandbox;
  command: string;
  logPath: string;
  timeoutSec: number;
  pollIntervalSec?: number;
}): Promise<{ exitCode: number }> {
  const { sandbox, command, logPath, timeoutSec } = params;
  const pollIntervalSec = params.pollIntervalSec ?? 10;
  const markerPrefix = `/tmp/opencode-audit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const donePath = `${markerPrefix}.done`;
  const exitPath = `${markerPrefix}.exit`;
  const pidPath = `${markerPrefix}.pid`;

  const launchScript = [
    `rm -f ${shellEscape(donePath)} ${shellEscape(exitPath)} ${shellEscape(pidPath)} ${shellEscape(logPath)}`,
    "(",
    `  (${command}) > ${shellEscape(logPath)} 2>&1`,
    "  EXIT_CODE=$?",
    `  echo "$EXIT_CODE" > ${shellEscape(exitPath)}`,
    `  touch ${shellEscape(donePath)}`,
    ") &",
    `echo "$!" > ${shellEscape(pidPath)}`,
  ].join("\n");

  await requireSuccess(sandbox, launchScript, "Launch long-running command", 30);

  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(pollIntervalSec * 1000);

    let statusResult: { exitCode: number; output: string } | undefined;
    try {
      statusResult = await runCommand(
        sandbox,
        `if [ -f ${shellEscape(donePath)} ]; then cat ${shellEscape(exitPath)}; else echo "__RUNNING__"; fi`,
        30,
      );
    } catch (error) {
      if (isRetryableDaytonaError(error)) {
        console.warn(
          `[analyze] Retryable polling failure: ${compactErrorMessage(error)}. Continuing...`,
        );
        continue;
      }
      throw error;
    }

    if (statusResult.exitCode !== 0) {
      continue;
    }

    const statusText = statusResult.output.trim();
    if (statusText === "__RUNNING__") {
      continue;
    }

    const exitCode = Number.parseInt(statusText, 10);
    if (!Number.isFinite(exitCode)) {
      throw new Error(`Invalid exit code while polling long-running command: "${statusText}"`);
    }

    return { exitCode };
  }

  await runCommand(
    sandbox,
    `if [ -f ${shellEscape(pidPath)} ]; then kill "$(cat ${shellEscape(pidPath)})" 2>/dev/null || true; fi`,
    30,
  );
  throw new Error(`Long-running command timed out after ${timeoutSec} seconds.`);
}

function buildAnalysisPrompt(params: { inputUrl: string; reportPath: string }): string {
  return [
    "You are performing an evidence-based repository audit.",
    `Input URL: ${params.inputUrl}`,
    "",
    "Workflow requirements:",
    "1) Read README and infer claimed scope/completeness.",
    "2) Inspect highest-signal code paths and architecture.",
    "3) Run a small runtime check where sensible (install + one or two commands max).",
    "4) Capture meaningful command evidence and errors; do not fabricate.",
    "5) Evaluate implementation quality honestly.",
    "6) Compare alternatives (products/repos) that do similar things better, with links.",
    "",
    "Execution budget:",
    "- Keep tool usage focused (target <= 8 tool calls total).",
    "- Prioritize high-signal files first: README, package manifest, main implementation files, and tests.",
    "- Runtime validation should be concise: 1-2 high-value commands max.",
    "",
    `Write a markdown report to this exact path: ${params.reportPath}`,
    "",
    "Required markdown sections (in this order):",
    "1. Input URL",
    "2. Claimed Purpose (from README)",
    "3. Reality Check Summary",
    "   - Keep this concise and easy to scan (4-7 bullets max).",
    "   - Sentence fragments are allowed and encouraged when clearer.",
    "4. How It Works (logic walkthrough)",
    "   - Explain the end-to-end flow in plain terms.",
    "   - Include at least one ASCII diagram that maps key components and data flow.",
    "5. Functionality Breakdown (logically grouped)",
    "   - For each group: what exists, what's solid, what's partial/sloppy, with file-path evidence.",
    "6. Runtime Validation",
    "   - Commands run, key logs/output, blockers.",
    "7. Quality Assessment",
    "   - correctness, maintainability, test quality, production-readiness risks.",
    "8. Better Alternatives",
    "   - at least 3 alternatives with links and why they are better for specific scenarios.",
    "9. Final Verdict",
    "   - include completeness score (0-10) and practical value score (0-10), with rationale.",
    "10. Usefulness & Value Judgment",
    "   - who should use it, who should not, where it is valuable.",
    "",
    "Constraints:",
    "- Be direct and specific.",
    "- Prefer concise bullets over long prose paragraphs.",
    "- Sentence fragments are acceptable.",
    "- Do not output planning notes, handoff notes, or 'continue' prompts.",
    "- Final step must write the complete report to the exact target path before exiting.",
    "- Stop immediately after writing the report file.",
    "- If something cannot be validated, state it explicitly.",
    "- Save only the final report file.",
  ].join("\n");
}

async function analyzeOneRepo(params: {
  daytona: Daytona;
  options: CliOptions;
  config: ResolvedSandcodeConfig;
  url: string;
  index: number;
  total: number;
}): Promise<AnalyzeResult> {
  const { daytona, options, config, url, index, total } = params;
  const slug = slugFromRepoUrl(url);
  const runPrefix = `${String(index + 1).padStart(2, "0")}-${slug}`;
  const datedRunPrefix = `${formatDatePrefix(new Date())}-${runPrefix}`;
  const localDir = path.join(options.outDir, datedRunPrefix);
  const findingsPath = path.join(localDir, "findings.md");
  let readmePath: string | undefined;

  await mkdir(localDir, { recursive: true });

  let sandbox: Sandbox | undefined;
  try {
    console.log(`[analyze] (${index + 1}/${total}) Creating sandbox for ${url}`);
    const sandboxName = sanitizeSlug(
      `audit-${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ).slice(0, 63);

    const createParams = {
      name: sandboxName,
      language: "typescript",
      autoStopInterval: SANDBOX_LIFECYCLE_POLICY.autoStopInterval,
      autoArchiveInterval: SANDBOX_LIFECYCLE_POLICY.autoArchiveInterval,
      autoDeleteInterval: SANDBOX_LIFECYCLE_POLICY.autoDeleteInterval,
    };

    sandbox = await daytona.create(createParams, { timeout: options.createTimeoutSec });
    console.log(`[analyze] (${runPrefix}) Sandbox ready: ${sandbox.id}`);

    const userHome = (await sandbox.getUserHomeDir()) ?? "/home/daytona";
    const remoteRepoDir = `${userHome}/audit/${slug}`;
    const remoteReportPath = `${remoteRepoDir}/.opencode-audit-findings.md`;
    const remoteOpencodeConfigDir = `${userHome}/.config/opencode`;
    const remoteOpencodeShareDir = `${userHome}/.local/share/opencode`;

    const localOpencodeConfigFiles = await getExistingLocalOpencodeConfigFiles();
    if (localOpencodeConfigFiles.length > 0) {
      await requireSuccess(
        sandbox,
        `mkdir -p ${shellEscape(remoteOpencodeConfigDir)}`,
        "Create OpenCode config directory",
        30,
      );
      for (const localConfigFile of localOpencodeConfigFiles) {
        const remoteConfigFile = `${remoteOpencodeConfigDir}/${path.basename(localConfigFile)}`;
        await uploadFileWithRetries(sandbox, localConfigFile, remoteConfigFile);
      }
      console.log(
        `[analyze] (${runPrefix}) Synced ${localOpencodeConfigFiles.length} local OpenCode config file(s) into sandbox.`,
      );
    } else {
      console.warn(
        `[analyze] (${runPrefix}) No local OpenCode config files found at ~/.config/opencode; sandbox run may require explicit provider env vars.`,
      );
    }

    const localOpencodeAuthFiles = await getExistingLocalOpencodeAuthFiles();
    if (localOpencodeAuthFiles.length > 0) {
      await requireSuccess(
        sandbox,
        `mkdir -p ${shellEscape(remoteOpencodeShareDir)} && chmod 700 ${shellEscape(remoteOpencodeShareDir)}`,
        "Create OpenCode auth directory",
        30,
      );

      for (const localAuthFile of localOpencodeAuthFiles) {
        const remoteAuthFile = `${remoteOpencodeShareDir}/${path.basename(localAuthFile)}`;
        await uploadFileWithRetries(sandbox, localAuthFile, remoteAuthFile);
        await requireSuccess(
          sandbox,
          `chmod 600 ${shellEscape(remoteAuthFile)}`,
          `Harden ${path.basename(localAuthFile)} permissions`,
          30,
        );
      }

      console.log(
        `[analyze] (${runPrefix}) Synced ${localOpencodeAuthFiles.length} local OpenCode auth file(s) into sandbox.`,
      );

      if (options.keepSandbox) {
        console.warn(
          `[analyze] (${runPrefix}) OAuth auth files were synced and --keep-sandbox is enabled. Remove ${remoteOpencodeShareDir}/auth.json when done.`,
        );
      }
    }

    await requireSuccess(sandbox, buildEnsureGitCommand(), "Ensure git", options.installTimeoutSec);
    await requireSuccess(
      sandbox,
      buildEnsureNodeCommand(),
      "Ensure node/npm",
      options.installTimeoutSec,
    );

    const cloneCommand =
      `mkdir -p ${shellEscape(`${userHome}/audit`)} && ` +
      `rm -rf ${shellEscape(remoteRepoDir)} && ` +
      `git clone --depth 1 ${shellEscape(url)} ${shellEscape(remoteRepoDir)}`;
    await requireSuccess(sandbox, cloneCommand, "Clone repository", 240);

    await requireSuccess(
      sandbox,
      buildInstallOpencodeCommand(),
      "Install OpenCode CLI",
      options.installTimeoutSec,
    );

    const resolveOpencodeBin =
      'if [ -x "$HOME/.bun/bin/opencode" ]; then echo "$HOME/.bun/bin/opencode"; ' +
      'elif [ -x "$HOME/.local/bin/opencode" ]; then echo "$HOME/.local/bin/opencode"; ' +
      "elif command -v opencode >/dev/null 2>&1; then command -v opencode; " +
      'else echo "opencode binary not found in PATH, ~/.bun/bin, or ~/.local/bin" >&2; exit 127; fi';

    const prompt = buildAnalysisPrompt({
      inputUrl: url,
      reportPath: remoteReportPath,
    });

    const forwardedEnvEntries = collectForwardedEnvEntries();
    const hasProviderCredential = forwardedEnvEntries.some(
      ([name]) => !name.startsWith("OPENCODE_"),
    );
    const hasOAuthAuthFile = localOpencodeAuthFiles.length > 0;
    if (!hasProviderCredential && !hasOAuthAuthFile) {
      console.warn(
        `[analyze] (${runPrefix}) No model provider env vars or local OAuth auth file detected. OpenCode may fail or block.`,
      );
    }
    const selectedModel = resolveAnalyzeModel({
      model: options.model,
      variant: options.variant,
      vision: options.vision,
    });
    let resolvedModelId = selectedModel.model;
    const requestedProvider = modelProvider(selectedModel.model);
    const hasAnthropicEnvCredential = forwardedEnvEntries.some(([name]) =>
      name.startsWith("ANTHROPIC_"),
    );

    if (
      requestedProvider === "anthropic" &&
      !hasAnthropicEnvCredential &&
      localOpencodeAuthFiles.length === 0
    ) {
      throw new Error(
        "Anthropic model selected, but no ANTHROPIC_* env var or ~/.local/share/opencode/auth.json was found to authenticate inside the sandbox.",
      );
    }

    console.log(
      `[analyze] (${runPrefix}) Model: ${selectedModel.model}${selectedModel.variant ? ` (variant: ${selectedModel.variant})` : ""}`,
    );

    if (requestedProvider === "anthropic") {
      console.log(`[analyze] (${runPrefix}) Verifying Anthropic provider access...`);
      const anthropicModelsCommand = buildOpencodeModelsCommand({
        resolveOpencodeBinCommand: resolveOpencodeBin,
        provider: "anthropic",
        forwardedEnvEntries,
      });
      const anthropicModelsResult = await runCommand(sandbox, anthropicModelsCommand, 120);
      const anthropicModelsOutput = anthropicModelsResult.output;
      await writeFile(
        path.join(localDir, "opencode-models-anthropic.log"),
        anthropicModelsOutput,
        "utf8",
      );

      if (anthropicModelsResult.exitCode !== 0) {
        const preview = anthropicModelsOutput.split("\n").slice(-120).join("\n");
        throw new Error(
          `Anthropic provider preflight failed (exit code ${anthropicModelsResult.exitCode}).\n${preview}`,
        );
      }

      const availableAnthropicModels = parseModelListOutput(anthropicModelsOutput).filter(
        (model) => modelProvider(model) === "anthropic",
      );

      if (availableAnthropicModels.length === 0) {
        throw new Error(
          "Anthropic provider preflight returned no models. Verify OpenCode OAuth session and retry.",
        );
      }

      const hasExactMatch = availableAnthropicModels.some(
        (model) => model.toLowerCase() === selectedModel.model.toLowerCase(),
      );
      if (!hasExactMatch) {
        const normalizedMatch = findNormalizedModelMatch(
          selectedModel.model,
          availableAnthropicModels,
        );
        if (normalizedMatch) {
          resolvedModelId = normalizedMatch;
          console.warn(
            `[analyze] (${runPrefix}) Requested model ${selectedModel.model} not found exactly. Using ${normalizedMatch} from available Anthropic models.`,
          );
        } else {
          const preview = availableAnthropicModels.slice(0, 12).join(", ");
          throw new Error(
            `Requested Anthropic model ${selectedModel.model} is unavailable in sandbox auth context. Available examples: ${preview}`,
          );
        }
      }
    }

    const preflightPrompt = "Reply with exactly one word: ready";
    const preflightTimeoutSec = Math.max(
      90,
      Math.min(300, Math.floor(options.analyzeTimeoutSec / 4)),
    );
    const preflightCommandText = buildOpencodeRunCommand({
      resolveOpencodeBinCommand: resolveOpencodeBin,
      workingDir: remoteRepoDir,
      prompt: preflightPrompt,
      model: resolvedModelId,
      variant: selectedModel.variant,
      forwardedEnvEntries,
    });

    console.log(`[analyze] (${runPrefix}) Running OpenCode preflight...`);
    const preflightResult = await runCommand(sandbox, preflightCommandText, preflightTimeoutSec);
    const preflightOutput = preflightResult.output;
    await writeFile(path.join(localDir, "opencode-preflight.log"), preflightOutput, "utf8");
    const preflightFatalError = detectOpencodeFatalError(preflightOutput);
    const preflightReady = hasReadyResponse(preflightOutput);
    if (preflightResult.exitCode !== 0 || preflightFatalError || !preflightReady) {
      const preview = preflightOutput.split("\n").slice(-120).join("\n");
      const reason =
        preflightFatalError ??
        (preflightReady
          ? `exit code ${preflightResult.exitCode}`
          : "missing expected readiness response");
      throw new Error(`OpenCode preflight failed (${reason})\n${preview}`);
    }

    const runCommandText = buildOpencodeRunCommand({
      resolveOpencodeBinCommand: resolveOpencodeBin,
      workingDir: remoteRepoDir,
      prompt,
      model: resolvedModelId,
      variant: selectedModel.variant,
      forwardedEnvEntries,
    });
    const remoteOpencodeLogPath = `/tmp/${slug}.opencode.log`;
    const localOpencodeLogPath = path.join(localDir, "opencode-run.log");

    console.log(`[analyze] (${runPrefix}) Running OpenCode analysis...`);
    const analysisResult = await runLongCommandWithPolling({
      sandbox,
      command: runCommandText,
      logPath: remoteOpencodeLogPath,
      timeoutSec: options.analyzeTimeoutSec,
    });
    await downloadFileWithRetries(sandbox, remoteOpencodeLogPath, localOpencodeLogPath);
    const analysisLog = await readFile(localOpencodeLogPath, "utf8");

    if (analysisResult.exitCode !== 0) {
      const outputPreview = analysisLog.split("\n").slice(-120).join("\n");
      throw new Error(`OpenCode run exited with code ${analysisResult.exitCode}\n${outputPreview}`);
    }
    const analysisFatalError = detectOpencodeFatalError(analysisLog);
    if (analysisFatalError) {
      throw new Error(`OpenCode run emitted fatal model/auth error: ${analysisFatalError}`);
    }

    await downloadFileWithRetries(sandbox, remoteReportPath, findingsPath);

    const readmeLookup = await runCommand(
      sandbox,
      `cd ${shellEscape(remoteRepoDir)} && find . -maxdepth 2 -type f \\( -iname 'README.md' -o -iname 'README.mdx' -o -iname 'README.rst' -o -iname 'README.txt' \\) | sort | head -n 1`,
      20,
    );
    const remoteReadmeRelative = readmeLookup.output.trim();
    if (remoteReadmeRelative) {
      const normalized = remoteReadmeRelative.replace(/^\.\//, "");
      const remoteReadmeAbsolute = `${remoteRepoDir}/${normalized}`;
      const localReadmeFile = path.join(localDir, path.basename(normalized));
      await downloadFileWithRetries(sandbox, remoteReadmeAbsolute, localReadmeFile);
      readmePath = localReadmeFile;
    }

    const result: AnalyzeResult = {
      url,
      slug,
      localDir,
      findingsPath,
      readmePath,
      success: true,
    };
    await maybeCatalogResult({
      config,
      result,
      runPrefix,
    });
    console.log(`[analyze] (${runPrefix}) Wrote ${findingsPath}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const fallback = [
      `# Audit failed`,
      ``,
      `- Input URL: ${url}`,
      `- Slug: ${slug}`,
      `- Error:`,
      ``,
      "```text",
      message,
      "```",
    ].join("\n");
    await writeFile(findingsPath, fallback, "utf8");

    console.error(`[analyze] (${runPrefix}) Failed: ${message}`);
    const result: AnalyzeResult = {
      url,
      slug,
      localDir,
      findingsPath,
      success: false,
      error: message,
    };
    await maybeCatalogResult({
      config,
      result,
      runPrefix,
    });
    return result;
  } finally {
    if (sandbox && !options.keepSandbox) {
      try {
        await sandbox.delete();
      } catch (cleanupError) {
        const message =
          cleanupError instanceof Error
            ? (cleanupError.stack ?? cleanupError.message)
            : String(cleanupError);
        console.error(`[analyze] (${runPrefix}) Sandbox cleanup failed: ${message}`);
      }
    }
  }
}

async function maybeCatalogResult(params: {
  config: ResolvedSandcodeConfig;
  result: AnalyzeResult;
  runPrefix: string;
}): Promise<void> {
  const { config, result, runPrefix } = params;

  try {
    const catalogResult = await catalogAnalysisResult({
      config,
      slug: result.slug,
      runLabel: runPrefix,
      sourceUrl: result.url,
      findingsPath: result.findingsPath,
      success: result.success,
      error: result.error,
    });

    if (!catalogResult.attempted && catalogResult.skippedReason) {
      console.log(
        `[analyze] (${runPrefix}) Obsidian catalog skipped: ${catalogResult.skippedReason}`,
      );
      return;
    }

    if (catalogResult.written && catalogResult.notePath) {
      result.obsidianNotePath = catalogResult.notePath;
      console.log(`[analyze] (${runPrefix}) Obsidian note: ${catalogResult.notePath}`);
    }

    if (catalogResult.warning) {
      console.warn(`[analyze] (${runPrefix}) Obsidian warning: ${catalogResult.warning}`);
    }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.warn(`[analyze] (${runPrefix}) Obsidian catalog failed: ${message}`);
  }
}

async function writeIndex(results: AnalyzeResult[], outDir: string): Promise<void> {
  const lines: string[] = [];
  lines.push("# Repository Audits");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  for (const result of results) {
    const status = result.success ? "success" : "failed";
    const findingsRel = path.relative(outDir, result.findingsPath);
    lines.push(`## ${result.slug}`);
    lines.push("");
    lines.push(`- URL: ${result.url}`);
    lines.push(`- Status: ${status}`);
    lines.push(`- Findings: \`${findingsRel}\``);
    if (result.readmePath) {
      lines.push(`- README copy: \`${path.relative(outDir, result.readmePath)}\``);
    }
    if (result.obsidianNotePath) {
      lines.push(`- Obsidian note: \`${result.obsidianNotePath}\``);
    }
    if (result.error) {
      lines.push(`- Error: ${result.error.split("\n")[0]}`);
    }
    lines.push("");
  }

  await writeFile(path.join(outDir, "index.md"), lines.join("\n"), "utf8");
}

export async function runAnalyzeCli(args = process.argv.slice(2)): Promise<number> {
  const loadedEnv = await loadConfiguredEnv();
  if (loadedEnv.keysLoaded.length > 0) {
    console.log(
      `[analyze] Loaded ${loadedEnv.keysLoaded.length} env var(s) from config (.env) files.`,
    );
  }
  const config = await resolveSandcodeConfig();

  const options = parseCliOptions(args);
  if (!options) {
    console.log(formatAnalyzeHelp());
    return 0;
  }
  const urls = await resolveInputUrls(options);
  const apiKey = requireEnv("DAYTONA_API_KEY");
  const apiUrl = process.env.DAYTONA_API_URL;
  const effectiveTarget = options.target ?? process.env.DAYTONA_TARGET;

  await mkdir(options.outDir, { recursive: true });
  console.log(`[analyze] URLs queued: ${urls.length}`);
  console.log(`[analyze] Output directory: ${options.outDir}`);

  const daytona = new Daytona({
    apiKey,
    apiUrl,
    target: effectiveTarget,
  });
  patchToolboxProxyUrlFallback(daytona);

  const results: AnalyzeResult[] = [];
  for (const [index, url] of urls.entries()) {
    const result = await analyzeOneRepo({
      daytona,
      options,
      config,
      url,
      index,
      total: urls.length,
    });
    results.push(result);
  }

  await writeIndex(results, options.outDir);
  const failures = results.filter((result) => !result.success).length;
  console.log(`[analyze] Completed. Success: ${results.length - failures}, Failed: ${failures}`);
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  const exitCode = await runAnalyzeCli().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`[analyze] Fatal error: ${message}`);
    return 1;
  });
  process.exit(exitCode);
}
