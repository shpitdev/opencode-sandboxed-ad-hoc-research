import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedShpitConfig } from "./shpit-config.js";

type CommandResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  error?: string;
};

type CatalogInput = {
  config: ResolvedShpitConfig;
  slug: string;
  runLabel: string;
  sourceUrl: string;
  findingsPath: string;
  success: boolean;
  error?: string;
};

export type CatalogResult = {
  attempted: boolean;
  written: boolean;
  notePath?: string;
  skippedReason?: string;
  warning?: string;
};

function sanitizePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function getDateParts(): { year: string; month: string; day: string } {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return { year, month, day };
}

function buildRelativeNotePath(params: {
  notesRoot: string;
  catalogMode: "date" | "repo";
  slug: string;
  runLabel: string;
}): string {
  const notesRoot = params.notesRoot.replace(/^\/+|\/+$/g, "");
  const safeSlug = sanitizePathSegment(params.slug) || "repo";
  const safeRunLabel = sanitizePathSegment(params.runLabel) || safeSlug;
  const { year, month, day } = getDateParts();

  if (params.catalogMode === "repo") {
    return path.join(notesRoot, safeSlug, `${year}-${month}-${day}-${safeRunLabel}.md`);
  }

  return path.join(notesRoot, year, month, `${day}-${safeRunLabel}.md`);
}

function resolveNotePathWithinVault(vaultPath: string, relativeNotePath: string): string {
  const resolvedVaultPath = path.resolve(vaultPath);
  const resolvedNotePath = path.resolve(resolvedVaultPath, relativeNotePath);
  const relative = path.relative(resolvedVaultPath, resolvedNotePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside Obsidian vault. Computed path: ${resolvedNotePath}`);
  }
  return resolvedNotePath;
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toMarkdownPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function summarizeCommandOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "no command output";
  }
  const snippet = trimmed.split(/\r?\n/).slice(-8).join(" | ");
  return snippet.length > 600 ? `${snippet.slice(0, 600)}...` : snippet;
}

function buildCatalogNote(input: {
  sourceUrl: string;
  findings: string;
  success: boolean;
  error?: string;
  runLabel: string;
  slug: string;
}): string {
  const generatedAt = new Date().toISOString();
  const status = input.success ? "success" : "failed";

  const lines: string[] = [];
  lines.push("---");
  lines.push(`source_url: "${escapeYaml(input.sourceUrl)}"`);
  lines.push(`generated_at: "${generatedAt}"`);
  lines.push(`status: "${status}"`);
  lines.push(`run_label: "${escapeYaml(input.runLabel)}"`);
  lines.push(`slug: "${escapeYaml(input.slug)}"`);
  lines.push("---");
  lines.push("");
  lines.push(`# Repository Audit - ${input.slug}`);
  lines.push("");
  lines.push(`- Source: ${input.sourceUrl}`);
  lines.push(`- Status: ${status}`);
  if (input.error) {
    lines.push(`- Error: ${input.error.split("\n")[0]}`);
  }
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  lines.push(input.findings.trim());
  lines.push("");

  return lines.join("\n");
}

async function tryOpenInObsidian(params: {
  command: string;
  vaultPath: string;
  relativeNotePath: string;
}): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    const child = spawn(
      params.command,
      ["open", `path=${toMarkdownPath(params.relativeNotePath)}`],
      {
        cwd: params.vaultPath,
        detached: true,
        stdio: "ignore",
      },
    );

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolve(String(error.message ?? error));
      }
    });

    child.once("spawn", () => {
      child.unref();
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(`Timed out while launching ${params.command}.`);
      }
    }, 2000);
  });
}

async function runForegroundCommand(params: {
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(params.command, params.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: string[] = [];
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer | string) => {
      chunks.push(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      chunks.push(chunk.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, params.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        output: chunks.join(""),
        timedOut,
        error: String(error.message ?? error),
      });
    });

    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        output: chunks.join(""),
        timedOut,
      });
    });
  });
}

async function trySyncWithHeadless(params: {
  command: string;
  vaultPath: string;
  timeoutSec: number;
}): Promise<string | undefined> {
  const commandResult = await runForegroundCommand({
    command: params.command,
    args: ["sync", "--path", params.vaultPath],
    timeoutMs: params.timeoutSec * 1000,
  });

  if (commandResult.timedOut) {
    return `Headless sync timed out after ${params.timeoutSec}s.`;
  }

  if (commandResult.error) {
    return `Failed to run ${params.command} sync: ${commandResult.error}`;
  }

  if (commandResult.exitCode !== 0) {
    return `Headless sync exited with code ${commandResult.exitCode}: ${summarizeCommandOutput(commandResult.output)}`;
  }

  return undefined;
}

export async function catalogAnalysisResult(input: CatalogInput): Promise<CatalogResult> {
  const { obsidian } = input.config;

  if (!obsidian.enabled) {
    return {
      attempted: false,
      written: false,
      skippedReason: "Obsidian cataloging is disabled in shpit.toml.",
    };
  }

  if (!obsidian.vaultPath) {
    return {
      attempted: false,
      written: false,
      skippedReason: "Obsidian cataloging is enabled but `obsidian.vault_path` is not set.",
    };
  }

  const relativeNotePath = buildRelativeNotePath({
    notesRoot: obsidian.notesRoot,
    catalogMode: obsidian.catalogMode,
    slug: input.slug,
    runLabel: input.runLabel,
  });
  const notePath = resolveNotePathWithinVault(obsidian.vaultPath, relativeNotePath);
  const findings = await readFile(input.findingsPath, "utf8");
  const note = buildCatalogNote({
    sourceUrl: input.sourceUrl,
    findings,
    success: input.success,
    error: input.error,
    runLabel: input.runLabel,
    slug: input.slug,
  });

  await mkdir(path.dirname(notePath), { recursive: true });
  await writeFile(notePath, note, "utf8");

  const warnings: string[] = [];

  if (obsidian.integrationMode === "headless") {
    if (obsidian.openAfterCatalog) {
      warnings.push(
        '`open_after_catalog` is ignored when `obsidian.integration_mode = "headless"`.',
      );
    }

    if (obsidian.syncAfterCatalog) {
      const syncWarning = await trySyncWithHeadless({
        command: obsidian.headlessCommand,
        vaultPath: obsidian.vaultPath,
        timeoutSec: obsidian.syncTimeoutSec,
      });
      if (syncWarning) {
        warnings.push(syncWarning);
      }
    }

    return {
      attempted: true,
      written: true,
      notePath,
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
    };
  }

  if (obsidian.syncAfterCatalog) {
    warnings.push('`sync_after_catalog` is ignored when `obsidian.integration_mode = "desktop"`.');
  }

  if (!obsidian.openAfterCatalog) {
    return {
      attempted: true,
      written: true,
      notePath,
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
    };
  }

  const openWarning = await tryOpenInObsidian({
    command: obsidian.command,
    vaultPath: obsidian.vaultPath,
    relativeNotePath,
  });

  if (openWarning) {
    warnings.push(openWarning);
  }

  return {
    attempted: true,
    written: true,
    notePath,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

export const __testables = {
  buildRelativeNotePath,
  resolveNotePathWithinVault,
};
