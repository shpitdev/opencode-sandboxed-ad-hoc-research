import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedShpitConfig } from "./shpit-config.js";

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

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toMarkdownPath(value: string): string {
  return value.replace(/\\/g, "/");
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
  const notePath = path.join(obsidian.vaultPath, relativeNotePath);
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

  if (!obsidian.openAfterCatalog) {
    return {
      attempted: true,
      written: true,
      notePath,
    };
  }

  const warning = await tryOpenInObsidian({
    command: obsidian.command,
    vaultPath: obsidian.vaultPath,
    relativeNotePath,
  });

  return {
    attempted: true,
    written: true,
    notePath,
    warning,
  };
}

export const __testables = {
  buildRelativeNotePath,
};
