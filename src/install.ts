import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs, promisify } from "node:util";
import { loadConfiguredEnv, resolveShpitConfig } from "./shpit-config.js";

type CliOptions = {
  yes: boolean;
  vaultPath?: string;
  notesRoot?: string;
  catalogMode?: "date" | "repo";
  openAfterCatalog?: boolean;
  daytonaApiKey?: string;
  openaiApiKey?: string;
  zhipuApiKey?: string;
};

const execFileAsync = promisify(execFile);

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "vault-path": { type: "string" },
      "notes-root": { type: "string" },
      "catalog-mode": { type: "string" },
      "open-after-catalog": { type: "boolean", default: false },
      "daytona-api-key": { type: "string" },
      "openai-api-key": { type: "string" },
      "zhipu-api-key": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: bun run setup -- [options]

Options:
  -y, --yes                     Non-interactive setup using defaults/flags
      --vault-path <path>       Obsidian vault path (absolute or ~/...)
      --notes-root <path>       Folder inside vault for audit notes (default: Research/OpenCode)
      --catalog-mode <mode>     date | repo (default: date)
      --open-after-catalog      Open each new note via obsidian CLI after writing
      --daytona-api-key <key>   Seed DAYTONA_API_KEY into ~/.config/opencode/.env
      --openai-api-key <key>    Seed OPENAI_API_KEY into ~/.config/opencode/.env
      --zhipu-api-key <key>     Seed ZHIPU_API_KEY into ~/.config/opencode/.env
  -h, --help                    Show this help
`);
    process.exit(0);
  }

  const rawCatalogMode = values["catalog-mode"];
  if (rawCatalogMode && rawCatalogMode !== "date" && rawCatalogMode !== "repo") {
    throw new Error(`--catalog-mode must be "date" or "repo". Received "${rawCatalogMode}".`);
  }

  return {
    yes: values.yes,
    vaultPath: values["vault-path"],
    notesRoot: values["notes-root"],
    catalogMode: rawCatalogMode as "date" | "repo" | undefined,
    openAfterCatalog: values["open-after-catalog"],
    daytonaApiKey: values["daytona-api-key"],
    openaiApiKey: values["openai-api-key"],
    zhipuApiKey: values["zhipu-api-key"],
  };
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

async function detectObsidianBinary(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("sh", ["-lc", "command -v obsidian"]);
    const resolved = stdout.trim();
    return resolved || undefined;
  } catch {
    return undefined;
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
  lines.push("# Managed by bun run setup");
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

async function askYesNo(params: {
  rl: ReturnType<typeof createInterface>;
  prompt: string;
  defaultValue: boolean;
}): Promise<boolean> {
  const suffix = params.defaultValue ? "Y/n" : "y/N";
  const answer = (await params.rl.question(`${params.prompt} (${suffix}): `)).trim().toLowerCase();
  if (!answer) {
    return params.defaultValue;
  }
  return answer === "y" || answer === "yes";
}

async function askText(params: {
  rl: ReturnType<typeof createInterface>;
  prompt: string;
  defaultValue?: string;
}): Promise<string | undefined> {
  const renderedPrompt = params.defaultValue
    ? `${params.prompt} [${params.defaultValue}]: `
    : `${params.prompt}: `;
  const answer = (await params.rl.question(renderedPrompt)).trim();
  if (!answer) {
    return params.defaultValue;
  }
  return answer;
}

async function main(): Promise<void> {
  const options = parseCliOptions();
  await loadConfiguredEnv();
  const existingConfig = await resolveShpitConfig();

  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME is not set. Cannot write ~/.config/opencode files.");
  }

  const configDir = path.join(home, ".config", "opencode");
  const configPath = path.join(configDir, "shpit.toml");
  const envPath = path.join(configDir, ".env");

  const obsidianBinary = await detectObsidianBinary();
  console.log(
    obsidianBinary
      ? `[install] Detected Obsidian CLI command at: ${obsidianBinary}`
      : "[install] Obsidian CLI command not found in PATH. Expected command name: obsidian",
  );
  console.log(
    "[install] The installer will not execute Obsidian commands; it only configures them.",
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const nonInteractive = options.yes;

    const enableObsidian = nonInteractive
      ? Boolean(options.vaultPath ?? existingConfig.obsidian.enabled)
      : await askYesNo({
          rl,
          prompt: "Enable automatic Obsidian cataloging for analyze results?",
          defaultValue: existingConfig.obsidian.enabled,
        });

    const vaultPath = expandHomeDir(
      options.vaultPath ??
        (nonInteractive
          ? existingConfig.obsidian.vaultPath
          : await askText({
              rl,
              prompt: "Obsidian vault path",
              defaultValue: existingConfig.obsidian.vaultPath,
            })),
    );

    const notesRoot =
      options.notesRoot ??
      (nonInteractive
        ? existingConfig.obsidian.notesRoot
        : await askText({
            rl,
            prompt: "Vault folder for repo audits",
            defaultValue: existingConfig.obsidian.notesRoot,
          }));

    const catalogMode =
      options.catalogMode ??
      (nonInteractive
        ? existingConfig.obsidian.catalogMode
        : ((await askText({
            rl,
            prompt: "Catalog mode (date|repo)",
            defaultValue: existingConfig.obsidian.catalogMode,
          })) as "date" | "repo" | undefined));

    if (catalogMode && catalogMode !== "date" && catalogMode !== "repo") {
      throw new Error(`Invalid catalog mode "${catalogMode}".`);
    }

    const openAfterCatalog = nonInteractive
      ? Boolean(options.openAfterCatalog)
      : await askYesNo({
          rl,
          prompt: "Open each created note via obsidian command",
          defaultValue: existingConfig.obsidian.openAfterCatalog,
        });

    if (enableObsidian && !vaultPath) {
      throw new Error("Obsidian cataloging is enabled, but no vault path was provided.");
    }

    await mkdir(configDir, { recursive: true });

    const shpitTomlLines: string[] = [];
    shpitTomlLines.push("# Managed by bun run setup");
    shpitTomlLines.push("");
    shpitTomlLines.push("[obsidian]");
    shpitTomlLines.push(`enabled = ${enableObsidian ? "true" : "false"}`);
    shpitTomlLines.push('command = "obsidian"');
    if (vaultPath) {
      shpitTomlLines.push(`vault_path = ${JSON.stringify(vaultPath)}`);
    }
    shpitTomlLines.push(
      `notes_root = ${JSON.stringify(notesRoot ?? existingConfig.obsidian.notesRoot)}`,
    );
    shpitTomlLines.push(
      `catalog_mode = ${JSON.stringify(catalogMode ?? existingConfig.obsidian.catalogMode)}`,
    );
    shpitTomlLines.push(`open_after_catalog = ${openAfterCatalog ? "true" : "false"}`);
    shpitTomlLines.push("");

    await writeFile(configPath, shpitTomlLines.join("\n"), "utf8");
    console.log(`[install] Wrote ${configPath}`);

    const envMap = await loadEnvMap(envPath);
    const seededKeys: string[] = [];

    const daytonaApiKey = options.daytonaApiKey ?? process.env.DAYTONA_API_KEY;
    if (!daytonaApiKey && !nonInteractive) {
      const entered = await askText({
        rl,
        prompt: "DAYTONA_API_KEY (leave blank to skip)",
      });
      if (entered) {
        envMap.set("DAYTONA_API_KEY", entered);
        seededKeys.push("DAYTONA_API_KEY");
      }
    } else if (daytonaApiKey) {
      envMap.set("DAYTONA_API_KEY", daytonaApiKey);
      seededKeys.push("DAYTONA_API_KEY");
    }

    const hasProviderKey =
      Boolean(process.env.OPENAI_API_KEY) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.XAI_API_KEY) ||
      Boolean(process.env.OPENROUTER_API_KEY) ||
      Boolean(process.env.ZHIPU_API_KEY) ||
      Boolean(envMap.get("OPENAI_API_KEY")) ||
      Boolean(envMap.get("ANTHROPIC_API_KEY")) ||
      Boolean(envMap.get("XAI_API_KEY")) ||
      Boolean(envMap.get("OPENROUTER_API_KEY")) ||
      Boolean(envMap.get("ZHIPU_API_KEY"));

    const openaiApiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
    const zhipuApiKey = options.zhipuApiKey ?? process.env.ZHIPU_API_KEY;
    if (!hasProviderKey && !openaiApiKey && !zhipuApiKey && !nonInteractive) {
      console.log(
        "[install] No provider API key detected. Free opencode/* models can work without a key, but provider keys are needed for OpenAI/Anthropic/Z.AI/etc.",
      );
      const entered = await askText({
        rl,
        prompt: "OPENAI_API_KEY (leave blank to skip)",
      });
      if (entered) {
        envMap.set("OPENAI_API_KEY", entered);
        seededKeys.push("OPENAI_API_KEY");
      }
    } else if (openaiApiKey) {
      envMap.set("OPENAI_API_KEY", openaiApiKey);
      seededKeys.push("OPENAI_API_KEY");
    }

    if (zhipuApiKey) {
      envMap.set("ZHIPU_API_KEY", zhipuApiKey);
      seededKeys.push("ZHIPU_API_KEY");
    } else if (!hasProviderKey && !openaiApiKey && !nonInteractive) {
      const entered = await askText({
        rl,
        prompt: "ZHIPU_API_KEY (for Z.AI / GLM, leave blank to skip)",
      });
      if (entered) {
        envMap.set("ZHIPU_API_KEY", entered);
        seededKeys.push("ZHIPU_API_KEY");
      }
    }

    if (envMap.size > 0) {
      await writeFile(envPath, serializeEnvMap(envMap), "utf8");
      console.log(`[install] Wrote ${envPath}`);
    }

    if (!process.env.DAYTONA_API_KEY && !envMap.get("DAYTONA_API_KEY")) {
      console.warn(
        "[install] DAYTONA_API_KEY is still missing. start/analyze will fail until it is set.",
      );
    }

    const hasAnyProviderKey =
      Boolean(process.env.OPENAI_API_KEY) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.XAI_API_KEY) ||
      Boolean(process.env.OPENROUTER_API_KEY) ||
      Boolean(process.env.ZHIPU_API_KEY) ||
      Boolean(envMap.get("OPENAI_API_KEY")) ||
      Boolean(envMap.get("ANTHROPIC_API_KEY")) ||
      Boolean(envMap.get("XAI_API_KEY")) ||
      Boolean(envMap.get("OPENROUTER_API_KEY")) ||
      Boolean(envMap.get("ZHIPU_API_KEY"));

    if (!hasAnyProviderKey) {
      console.warn(
        "[install] No model provider key configured. This is OK if you use free opencode/* models; set OPENAI_API_KEY or ZHIPU_API_KEY for broader model access.",
      );
    }

    if (seededKeys.length > 0) {
      console.log(`[install] Seeded credential keys: ${[...new Set(seededKeys)].join(", ")}`);
    }

    console.log("[install] Setup complete.");
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[install] Failed: ${message}`);
  process.exit(1);
});
