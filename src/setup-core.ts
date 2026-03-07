import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";
import {
  type LoadedEnvInfo,
  loadConfiguredEnv,
  type ResolvedSandcodeConfig,
  resolveSandcodeConfig,
} from "./sandcode-config.js";

const execFileAsync = promisify(execFile);

export type SetupCliOptions = {
  yes: boolean;
  vaultPath?: string;
  notesRoot?: string;
  catalogMode?: "date" | "repo";
  openAfterCatalog?: boolean;
  integrationMode?: "desktop" | "headless";
  syncAfterCatalog?: boolean;
  syncTimeoutSec?: number;
  daytonaApiKey?: string;
  opencodeApiKey?: string;
};

export type SetupState = {
  enableObsidian: boolean;
  integrationMode: "desktop" | "headless";
  vaultPath: string;
  notesRoot: string;
  catalogMode: "date" | "repo";
  openAfterCatalog: boolean;
  syncAfterCatalog: boolean;
  syncTimeoutSec: number;
  syncTimeoutInput: string;
  syncTimeoutError?: string;
  daytonaApiKey: string;
  opencodeApiKey: string;
};

export type SetupContext = {
  loadedEnv: LoadedEnvInfo;
  existingConfig: ResolvedSandcodeConfig;
  home: string;
  configDir: string;
  configPath: string;
  envPath: string;
  obsidianBinary?: string;
  headlessBinary?: string;
  hasExistingConfig: boolean;
  recommendedIntegrationMode: "desktop" | "headless";
  headlessCommand: string;
};

export type SetupProgressEvent = {
  level: "info" | "warn";
  message: string;
};

export type SetupResult = {
  configPath: string;
  envPath?: string;
  seededKeys: string[];
  warnings: string[];
};

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer. Received "${value}".`);
  }
  return parsed;
}

function expandHomeDir(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!value.startsWith("~")) {
    return value;
  }
  const home = process.env.HOME;
  if (!home) {
    return value;
  }
  return path.join(home, value.slice(1));
}

export function formatSetupHelp(invocation = "sandcode setup"): string {
  return `Usage: ${invocation} [options]

Options:
  -y, --yes                     Non-interactive setup using defaults/flags
      --vault-path <path>       Obsidian vault path (absolute or ~/...)
      --notes-root <path>       Folder inside vault for research notes (default: Research/Sandcode)
      --catalog-mode <mode>     date | repo (default: date)
      --obsidian-integration    headless | desktop (default: auto-detect)
      --sync-after-catalog      Run 'ob sync' after each note write (headless mode)
      --sync-timeout-sec <sec>  Timeout for 'ob sync' (default: 120)
      --open-after-catalog      Open each new note via obsidian CLI (desktop mode)
      --daytona-api-key <key>   Seed DAYTONA_API_KEY into ~/.config/sandcode/.env
      --opencode-api-key <key>  Seed OPENCODE_API_KEY into ~/.config/sandcode/.env
  -h, --help                    Show this help
`;
}

export function parseSetupCliOptions(args: string[]): SetupCliOptions | undefined {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "vault-path": { type: "string" },
      "notes-root": { type: "string" },
      "catalog-mode": { type: "string" },
      "open-after-catalog": { type: "boolean" },
      "obsidian-integration": { type: "string" },
      "sync-after-catalog": { type: "boolean" },
      "sync-timeout-sec": { type: "string" },
      "daytona-api-key": { type: "string" },
      "opencode-api-key": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    return undefined;
  }

  const rawCatalogMode = values["catalog-mode"];
  if (rawCatalogMode && rawCatalogMode !== "date" && rawCatalogMode !== "repo") {
    throw new Error(`--catalog-mode must be "date" or "repo". Received "${rawCatalogMode}".`);
  }

  const rawIntegrationMode = values["obsidian-integration"];
  if (rawIntegrationMode && rawIntegrationMode !== "desktop" && rawIntegrationMode !== "headless") {
    throw new Error(
      `--obsidian-integration must be "desktop" or "headless". Received "${rawIntegrationMode}".`,
    );
  }

  const rawSyncTimeoutSec = values["sync-timeout-sec"];
  let syncTimeoutSec: number | undefined;
  if (rawSyncTimeoutSec !== undefined) {
    syncTimeoutSec = parsePositiveInteger(rawSyncTimeoutSec, "--sync-timeout-sec");
  }

  return {
    yes: values.yes,
    vaultPath: values["vault-path"],
    notesRoot: values["notes-root"],
    catalogMode: rawCatalogMode as "date" | "repo" | undefined,
    openAfterCatalog: values["open-after-catalog"],
    integrationMode: rawIntegrationMode as "desktop" | "headless" | undefined,
    syncAfterCatalog: values["sync-after-catalog"],
    syncTimeoutSec,
    daytonaApiKey: values["daytona-api-key"],
    opencodeApiKey: values["opencode-api-key"],
  };
}

export async function detectCommandBinary(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [command]);
    const resolved = stdout.trim();
    return resolved || undefined;
  } catch {
    return undefined;
  }
}

function countRemoteVaults(output: string): number {
  return output.split(/\r?\n/).filter((line) => /^\s*[a-f0-9]{32}\s+"/.test(line)).length;
}

function describeExecError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const message = "message" in error ? String(error.message) : "unknown error";
  const stdout = "stdout" in error ? String(error.stdout ?? "") : "";
  const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
  const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return details ? `${message}\n${details}` : message;
}

export async function validateHeadlessSyncAccess(command: string): Promise<number> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["sync-list-remote"], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return countRemoteVaults(`${stdout}\n${stderr}`);
  } catch (error) {
    throw new Error(
      `Headless Sync preflight failed. Ensure Obsidian Catalyst access, an active Obsidian Sync subscription, and successful \`ob login\`.\n${describeExecError(error)}`,
    );
  }
}

function parseEnvFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    let value = line.slice(separatorIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result.set(key, value);
  }
  return result;
}

async function loadEnvMap(filePath: string): Promise<Map<string, string>> {
  try {
    const content = await readFile(filePath, "utf8");
    return parseEnvFile(content);
  } catch {
    return new Map<string, string>();
  }
}

function serializeEnvMap(env: Map<string, string>): string {
  const lines: string[] = [];
  lines.push("# Managed by sandcode setup");
  lines.push("# Shell-exported env vars still override these values.");
  lines.push("");

  const keys = [...env.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const value = env.get(key);
    if (value === undefined) {
      continue;
    }
    lines.push(`${key}=${JSON.stringify(value)}`);
  }

  lines.push("");
  return lines.join("\n");
}

function hasProviderKey(envMap: Map<string, string>): boolean {
  return (
    Boolean(process.env.OPENCODE_API_KEY) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.XAI_API_KEY) ||
    Boolean(process.env.OPENROUTER_API_KEY) ||
    Boolean(process.env.ZHIPU_API_KEY) ||
    Boolean(envMap.get("OPENCODE_API_KEY")) ||
    Boolean(envMap.get("OPENAI_API_KEY")) ||
    Boolean(envMap.get("ANTHROPIC_API_KEY")) ||
    Boolean(envMap.get("XAI_API_KEY")) ||
    Boolean(envMap.get("OPENROUTER_API_KEY")) ||
    Boolean(envMap.get("ZHIPU_API_KEY"))
  );
}

function sanitizeSetupState(state: SetupState): SetupState {
  return {
    ...state,
    vaultPath: expandHomeDir(state.vaultPath)?.trim() ?? "",
    notesRoot: state.notesRoot.trim() || "Research/Sandcode",
    daytonaApiKey: state.daytonaApiKey.trim(),
    opencodeApiKey: state.opencodeApiKey.trim(),
    syncTimeoutInput: state.syncTimeoutInput.trim() || String(state.syncTimeoutSec),
    syncTimeoutSec:
      Number.isInteger(state.syncTimeoutSec) && state.syncTimeoutSec > 0
        ? state.syncTimeoutSec
        : 120,
  };
}

export async function loadSetupContext(cwd = process.cwd()): Promise<SetupContext> {
  const loadedEnv = await loadConfiguredEnv(cwd);
  const existingConfig = await resolveSandcodeConfig(cwd);

  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME is not set. Cannot write ~/.config/sandcode files.");
  }

  const configDir = path.join(home, ".config", "sandcode");
  const configPath = path.join(configDir, "sandcode.toml");
  const envPath = path.join(configDir, ".env");
  const [obsidianBinary, headlessBinary] = await Promise.all([
    detectCommandBinary("obsidian"),
    detectCommandBinary(existingConfig.obsidian.headlessCommand),
  ]);
  const hasExistingConfig = Boolean(
    existingConfig.paths.globalConfigPath ?? existingConfig.paths.projectConfigPath,
  );
  const recommendedIntegrationMode = hasExistingConfig
    ? existingConfig.obsidian.integrationMode
    : headlessBinary
      ? "headless"
      : "desktop";

  return {
    loadedEnv,
    existingConfig,
    home,
    configDir,
    configPath,
    envPath,
    obsidianBinary,
    headlessBinary,
    hasExistingConfig,
    recommendedIntegrationMode,
    headlessCommand: existingConfig.obsidian.headlessCommand,
  };
}

export function buildInitialSetupState(
  context: SetupContext,
  options: SetupCliOptions,
): SetupState {
  return sanitizeSetupState({
    enableObsidian: Boolean(
      options.vaultPath ??
        context.existingConfig.obsidian.vaultPath ??
        context.existingConfig.obsidian.enabled,
    ),
    integrationMode: options.integrationMode ?? context.recommendedIntegrationMode,
    vaultPath: expandHomeDir(options.vaultPath ?? context.existingConfig.obsidian.vaultPath) ?? "",
    notesRoot: options.notesRoot ?? context.existingConfig.obsidian.notesRoot,
    catalogMode: options.catalogMode ?? context.existingConfig.obsidian.catalogMode,
    openAfterCatalog: options.openAfterCatalog ?? context.existingConfig.obsidian.openAfterCatalog,
    syncAfterCatalog: options.syncAfterCatalog ?? context.existingConfig.obsidian.syncAfterCatalog,
    syncTimeoutSec: options.syncTimeoutSec ?? context.existingConfig.obsidian.syncTimeoutSec,
    syncTimeoutInput: String(
      options.syncTimeoutSec ?? context.existingConfig.obsidian.syncTimeoutSec,
    ),
    daytonaApiKey: options.daytonaApiKey ?? process.env.DAYTONA_API_KEY ?? "",
    opencodeApiKey: options.opencodeApiKey ?? process.env.OPENCODE_API_KEY ?? "",
  });
}

export function summarizeSetupContext(context: SetupContext): SetupProgressEvent[] {
  return [
    {
      level: "info",
      message: context.obsidianBinary
        ? `Detected Obsidian desktop CLI at ${context.obsidianBinary}`
        : "Obsidian desktop CLI not found in PATH (command: obsidian)",
    },
    {
      level: "info",
      message: context.headlessBinary
        ? `Detected Obsidian Headless CLI at ${context.headlessBinary}`
        : "Obsidian Headless CLI not found in PATH (command: ob)",
    },
    {
      level: "info",
      message:
        "Headless mode runs a real preflight against Obsidian Sync using `ob sync-list-remote`.",
    },
  ];
}

export async function applySetupState(
  context: SetupContext,
  stateInput: SetupState,
  report?: (event: SetupProgressEvent) => void,
): Promise<SetupResult> {
  const state = sanitizeSetupState(stateInput);

  if (state.enableObsidian && !state.vaultPath) {
    throw new Error("Obsidian cataloging is enabled, but no vault path was provided.");
  }

  if (state.enableObsidian && state.integrationMode === "desktop" && state.openAfterCatalog) {
    if (!context.obsidianBinary) {
      throw new Error(
        "Desktop integration with open_after_catalog requires the `obsidian` command in PATH.",
      );
    }
  }

  if (state.enableObsidian && state.integrationMode === "headless") {
    const resolvedHeadlessBinary =
      context.headlessBinary ?? (await detectCommandBinary(context.headlessCommand));
    if (!resolvedHeadlessBinary) {
      throw new Error(
        "Headless integration requires `ob` in PATH. Install with: bun add -g obsidian-headless",
      );
    }

    report?.({ level: "info", message: "Running Obsidian headless preflight..." });
    const remoteVaultCount = await validateHeadlessSyncAccess(context.headlessCommand);
    if (remoteVaultCount > 0) {
      report?.({
        level: "info",
        message: `Headless preflight passed. Remote vaults visible: ${remoteVaultCount}`,
      });
    } else {
      report?.({
        level: "warn",
        message:
          'Headless preflight succeeded but no remote vaults were found. Create one with `ob sync-create-remote --name "..."`.',
      });
    }
  }

  await mkdir(context.configDir, { recursive: true });

  const configLines: string[] = [];
  configLines.push("# Managed by sandcode setup");
  configLines.push("");
  configLines.push("[obsidian]");
  configLines.push(`enabled = ${state.enableObsidian ? "true" : "false"}`);
  configLines.push('command = "obsidian"');
  configLines.push(`integration_mode = ${JSON.stringify(state.integrationMode)}`);
  configLines.push(`headless_command = ${JSON.stringify(context.headlessCommand)}`);
  if (state.vaultPath) {
    configLines.push(`vault_path = ${JSON.stringify(state.vaultPath)}`);
  }
  configLines.push(`notes_root = ${JSON.stringify(state.notesRoot)}`);
  configLines.push(`catalog_mode = ${JSON.stringify(state.catalogMode)}`);
  configLines.push(`sync_after_catalog = ${state.syncAfterCatalog ? "true" : "false"}`);
  configLines.push(`sync_timeout_sec = ${state.syncTimeoutSec}`);
  configLines.push(`open_after_catalog = ${state.openAfterCatalog ? "true" : "false"}`);
  configLines.push("");

  await writeFile(context.configPath, configLines.join("\n"), "utf8");
  report?.({ level: "info", message: `Wrote ${context.configPath}` });

  const envMap = await loadEnvMap(context.envPath);
  const seededKeys = new Set<string>();

  const seedIfPresent = (key: string, value: string): void => {
    if (!value) {
      return;
    }
    envMap.set(key, value);
    seededKeys.add(key);
  };

  seedIfPresent("DAYTONA_API_KEY", state.daytonaApiKey);
  seedIfPresent("OPENCODE_API_KEY", state.opencodeApiKey);

  let envPath: string | undefined;
  if (envMap.size > 0) {
    await writeFile(context.envPath, serializeEnvMap(envMap), "utf8");
    envPath = context.envPath;
    report?.({ level: "info", message: `Wrote ${context.envPath}` });
  }

  const warnings: string[] = [];
  if (!state.daytonaApiKey && !envMap.get("DAYTONA_API_KEY") && !process.env.DAYTONA_API_KEY) {
    warnings.push("DAYTONA_API_KEY is still missing. start/analyze will fail until it is set.");
  }

  if (!hasProviderKey(envMap) && !state.opencodeApiKey) {
    warnings.push(
      "No model auth configured. The built-in default model uses OPENCODE_API_KEY; set it before running sandcode analyze.",
    );
  }

  for (const warning of warnings) {
    report?.({ level: "warn", message: warning });
  }

  if (seededKeys.size > 0) {
    report?.({
      level: "info",
      message: `Seeded credential keys: ${[...seededKeys].sort().join(", ")}`,
    });
  }

  report?.({ level: "info", message: "Setup complete." });

  return {
    configPath: context.configPath,
    envPath,
    seededKeys: [...seededKeys].sort(),
    warnings,
  };
}
