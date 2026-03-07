import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type TomlPrimitive = string | number | boolean;
interface ParsedTomlTable {
  [key: string]: TomlPrimitive | ParsedTomlTable;
}
type ParsedTomlValue = TomlPrimitive | ParsedTomlTable;

type PartialObsidianConfig = {
  enabled?: boolean;
  command?: string;
  vaultPath?: string;
  notesRoot?: string;
  catalogMode?: "date" | "repo";
  openAfterCatalog?: boolean;
  integrationMode?: "desktop" | "headless";
  headlessCommand?: string;
  syncAfterCatalog?: boolean;
  syncTimeoutSec?: number;
};

type PartialSandcodeConfig = {
  obsidian?: PartialObsidianConfig;
};

export type ResolvedSandcodeConfig = {
  paths: {
    globalConfigPath?: string;
    projectConfigPath?: string;
  };
  obsidian: {
    enabled: boolean;
    command: string;
    vaultPath?: string;
    notesRoot: string;
    catalogMode: "date" | "repo";
    openAfterCatalog: boolean;
    integrationMode: "desktop" | "headless";
    headlessCommand: string;
    syncAfterCatalog: boolean;
    syncTimeoutSec: number;
  };
};

export type LoadedEnvInfo = {
  globalEnvPath?: string;
  projectEnvPath?: string;
  keysLoaded: string[];
};

const DEFAULT_NOTES_ROOT = "Research/Sandcode";

function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && inDouble) {
      escaped = true;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === "#" && !inSingle && !inDouble) {
      return value.slice(0, i).trim();
    }
  }

  return value.trim();
}

function parseTomlPrimitive(rawValue: string, filePath: string, lineNumber: number): TomlPrimitive {
  const value = stripInlineComment(rawValue);

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new Error(`${filePath}:${lineNumber} invalid double-quoted TOML string.`);
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  throw new Error(
    `${filePath}:${lineNumber} unsupported TOML value "${value}". Use quoted strings, booleans, or integers.`,
  );
}

function setNestedTableValue(
  target: ParsedTomlTable,
  keyPath: string[],
  value: TomlPrimitive,
): void {
  let current = target;

  for (const segment of keyPath.slice(0, -1)) {
    const existing = current[segment];
    if (existing === undefined) {
      const next: ParsedTomlTable = {};
      current[segment] = next;
      current = next;
      continue;
    }

    if (typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error(`Cannot assign nested key through primitive TOML key: ${keyPath.join(".")}`);
    }

    current = existing;
  }

  const leaf = keyPath.at(-1);
  if (!leaf) {
    throw new Error("Invalid TOML key path.");
  }
  current[leaf] = value;
}

function parseToml(content: string, filePath: string): ParsedTomlTable {
  const root: ParsedTomlTable = {};
  let currentSection: string[] = [];

  const lines = content.split(/\r?\n/);
  for (const [index, originalLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      const sectionName = line.slice(1, -1).trim();
      if (!sectionName) {
        throw new Error(`${filePath}:${lineNumber} invalid TOML table header.`);
      }
      currentSection = sectionName.split(".").map((segment) => segment.trim());
      if (currentSection.some((segment) => !segment)) {
        throw new Error(`${filePath}:${lineNumber} invalid TOML table header "${sectionName}".`);
      }
      let pointer = root;
      for (const segment of currentSection) {
        const existing = pointer[segment];
        if (existing === undefined) {
          const next: ParsedTomlTable = {};
          pointer[segment] = next;
          pointer = next;
          continue;
        }
        if (typeof existing !== "object" || Array.isArray(existing)) {
          throw new Error(
            `${filePath}:${lineNumber} table "${sectionName}" conflicts with existing primitive key.`,
          );
        }
        pointer = existing;
      }
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`${filePath}:${lineNumber} expected "key = value".`);
    }

    const rawKey = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (!rawKey) {
      throw new Error(`${filePath}:${lineNumber} missing TOML key before "=".`);
    }

    const keyPath = [...currentSection, ...rawKey.split(".").map((segment) => segment.trim())];
    if (keyPath.some((segment) => !segment)) {
      throw new Error(`${filePath}:${lineNumber} invalid TOML key "${rawKey}".`);
    }

    const primitive = parseTomlPrimitive(rawValue, filePath, lineNumber);
    setNestedTableValue(root, keyPath, primitive);
  }

  return root;
}

function asTable(value: ParsedTomlValue | undefined): ParsedTomlTable | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function asString(value: ParsedTomlValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: ParsedTomlValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asInteger(value: ParsedTomlValue | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function toPartialConfig(parsed: ParsedTomlTable): PartialSandcodeConfig {
  const obsidian = asTable(parsed.obsidian);

  return {
    obsidian: obsidian
      ? {
          enabled: asBoolean(obsidian.enabled),
          command: asString(obsidian.command),
          vaultPath: asString(obsidian.vault_path),
          notesRoot: asString(obsidian.notes_root),
          catalogMode: asString(obsidian.catalog_mode) as "date" | "repo" | undefined,
          openAfterCatalog: asBoolean(obsidian.open_after_catalog),
          integrationMode: asString(obsidian.integration_mode) as
            | "desktop"
            | "headless"
            | undefined,
          headlessCommand: asString(obsidian.headless_command),
          syncAfterCatalog: asBoolean(obsidian.sync_after_catalog),
          syncTimeoutSec: asInteger(obsidian.sync_timeout_sec),
        }
      : undefined,
  };
}

function mergePartialConfig(
  base: PartialSandcodeConfig,
  override: PartialSandcodeConfig,
): PartialSandcodeConfig {
  return {
    obsidian: {
      ...(base.obsidian ?? {}),
      ...(override.obsidian ?? {}),
    },
  };
}

function normalizeObsidianCommand(command: string | undefined): string {
  const normalized = (command ?? "obsidian").trim();
  if (!normalized) {
    return "obsidian";
  }
  if (normalized === "obs") {
    throw new Error(
      'Invalid `obsidian.command`: "obs". Use "obsidian" to avoid launching the wrong binary.',
    );
  }
  return normalized;
}

function normalizeIntegrationMode(
  mode: string | undefined,
): ResolvedSandcodeConfig["obsidian"]["integrationMode"] {
  const normalized = (mode ?? "desktop").trim() || "desktop";
  if (normalized !== "desktop" && normalized !== "headless") {
    throw new Error(
      `Invalid obsidian.integration_mode: ${normalized}. Expected "desktop" or "headless".`,
    );
  }
  return normalized;
}

function normalizeHeadlessCommand(command: string | undefined): string {
  const normalized = (command ?? "ob").trim();
  return normalized || "ob";
}

function resolveVaultPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("~")) {
    const home = process.env.HOME;
    return home ? path.join(home, value.slice(1)) : value;
  }
  return value;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

function candidateProjectConfigPaths(startDir: string): string[] {
  const candidates: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    candidates.push(path.join(current, "sandcode.toml"));
    candidates.push(path.join(current, ".sandcode.toml"));
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return candidates;
}

async function findProjectConfigPath(startDir: string): Promise<string | undefined> {
  for (const candidate of candidateProjectConfigPaths(startDir)) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function getGlobalConfigPath(): string | undefined {
  const home = process.env.HOME;
  if (!home) {
    return undefined;
  }
  return path.join(home, ".config", "sandcode", "sandcode.toml");
}

async function loadConfigAtPath(filePath: string | undefined): Promise<PartialSandcodeConfig> {
  if (!filePath || !(await fileExists(filePath))) {
    return {};
  }

  const content = await readFile(filePath, "utf8");
  return toPartialConfig(parseToml(content, filePath));
}

function resolveFinalConfig(partial: PartialSandcodeConfig): ResolvedSandcodeConfig["obsidian"] {
  const obsidian = partial.obsidian ?? {};
  const catalogMode = obsidian.catalogMode ?? "date";
  if (catalogMode !== "date" && catalogMode !== "repo") {
    throw new Error(`Invalid obsidian.catalog_mode: ${catalogMode}. Expected "date" or "repo".`);
  }

  const integrationMode = normalizeIntegrationMode(obsidian.integrationMode);
  const syncTimeoutSec = obsidian.syncTimeoutSec ?? 120;
  if (!Number.isInteger(syncTimeoutSec) || syncTimeoutSec <= 0) {
    throw new Error(
      `Invalid obsidian.sync_timeout_sec: ${syncTimeoutSec}. Expected a positive integer.`,
    );
  }

  return {
    enabled: obsidian.enabled ?? false,
    command: normalizeObsidianCommand(obsidian.command),
    vaultPath: resolveVaultPath(obsidian.vaultPath),
    notesRoot: (obsidian.notesRoot ?? DEFAULT_NOTES_ROOT).trim() || DEFAULT_NOTES_ROOT,
    catalogMode,
    openAfterCatalog: obsidian.openAfterCatalog ?? false,
    integrationMode,
    headlessCommand: normalizeHeadlessCommand(obsidian.headlessCommand),
    syncAfterCatalog: obsidian.syncAfterCatalog ?? integrationMode === "headless",
    syncTimeoutSec,
  };
}

function parseEnvFile(content: string): Map<string, string> {
  const env = new Map<string, string>();
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

    const rawValue = line.slice(separatorIndex + 1).trim();
    const valueWithoutComment = stripInlineComment(rawValue);

    let value = valueWithoutComment;
    if (valueWithoutComment.startsWith('"') && valueWithoutComment.endsWith('"')) {
      try {
        value = JSON.parse(valueWithoutComment) as string;
      } catch {
        value = valueWithoutComment.slice(1, -1);
      }
    } else if (valueWithoutComment.startsWith("'") && valueWithoutComment.endsWith("'")) {
      value = valueWithoutComment.slice(1, -1);
    }

    env.set(key, value);
  }

  return env;
}

async function loadEnvFile(filePath: string | undefined): Promise<Map<string, string>> {
  if (!filePath || !(await fileExists(filePath))) {
    return new Map<string, string>();
  }
  const content = await readFile(filePath, "utf8");
  return parseEnvFile(content);
}

export async function resolveSandcodeConfig(cwd = process.cwd()): Promise<ResolvedSandcodeConfig> {
  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = await findProjectConfigPath(cwd);

  const [globalConfig, projectConfig] = await Promise.all([
    loadConfigAtPath(globalConfigPath),
    loadConfigAtPath(projectConfigPath),
  ]);

  const merged = mergePartialConfig(globalConfig, projectConfig);

  return {
    paths: {
      globalConfigPath:
        globalConfigPath && (await fileExists(globalConfigPath)) ? globalConfigPath : undefined,
      projectConfigPath,
    },
    obsidian: resolveFinalConfig(merged),
  };
}

export async function loadConfiguredEnv(cwd = process.cwd()): Promise<LoadedEnvInfo> {
  const home = process.env.HOME;
  const globalEnvPath = home ? path.join(home, ".config", "sandcode", ".env") : undefined;
  const projectConfigPath = await findProjectConfigPath(cwd);
  const projectEnvPath = projectConfigPath
    ? path.join(path.dirname(projectConfigPath), ".env")
    : undefined;

  const [globalEnv, projectEnv] = await Promise.all([
    loadEnvFile(globalEnvPath),
    loadEnvFile(projectEnvPath),
  ]);

  const merged = new Map<string, string>();
  for (const [key, value] of globalEnv.entries()) {
    merged.set(key, value);
  }
  for (const [key, value] of projectEnv.entries()) {
    merged.set(key, value);
  }

  const keysLoaded: string[] = [];
  for (const [key, value] of merged.entries()) {
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
    keysLoaded.push(key);
  }

  return {
    globalEnvPath: globalEnvPath && (await fileExists(globalEnvPath)) ? globalEnvPath : undefined,
    projectEnvPath:
      projectEnvPath && (await fileExists(projectEnvPath)) ? projectEnvPath : undefined,
    keysLoaded: keysLoaded.sort(),
  };
}

export const __testables = {
  parseEnvFile,
  parseToml,
  resolveFinalConfig,
};
