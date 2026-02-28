import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { buildInstallOpencodeCommand } from "./opencode-cli.js";
import { loadConfiguredEnv } from "./shpit-config.js";

type CliOptions = {
  port: number;
  keepSandbox: boolean;
  sandboxName?: string;
  createTimeoutSec: number;
  installTimeoutSec: number;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  target?: string;
  openUi: boolean;
};

type LogCursor = { value: string };
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

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer. Received "${value}".`);
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`--port must be between 1 and 65535. Received "${value}".`);
  }
  return parsed;
}

function parseAutoStopInterval(value: string | undefined, source: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${source} must be a non-negative integer (0 disables auto-stop). Received "${value}".`,
    );
  }
  return parsed;
}

function parseAutoDeleteInterval(value: string | undefined, source: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || (parsed !== -1 && parsed <= 0)) {
    throw new Error(
      `${source} must be -1 (disable auto-delete) or a positive integer. Received "${value}".`,
    );
  }
  return parsed;
}

function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      port: { type: "string", short: "p", default: "3000" },
      "keep-sandbox": { type: "boolean", default: false },
      "sandbox-name": { type: "string" },
      "create-timeout-sec": { type: "string", default: "180" },
      "install-timeout-sec": { type: "string", default: "900" },
      "auto-stop-interval": { type: "string" },
      "auto-delete-interval": { type: "string" },
      target: { type: "string" },
      "no-open": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: bun run start -- [options]

Options:
  -p, --port <n>                 Port to expose OpenCode web server (default: 3000)
      --target <name>            Daytona target override
      --sandbox-name <name>      Custom sandbox name
      --create-timeout-sec <n>   Sandbox creation timeout seconds (default: 180)
      --install-timeout-sec <n>  OpenCode install timeout seconds (default: 900)
      --auto-stop-interval <n>   Daytona auto-stop interval (minutes, 0 disables)
      --auto-delete-interval <n> Daytona auto-delete interval (minutes, -1 disables)
      --keep-sandbox             Keep sandbox after stopping (default: false)
      --no-open                  Do not auto-open OpenCode URL
  -h, --help                     Show this help
`);
    process.exit(0);
  }

  const autoStopInterval =
    parseAutoStopInterval(values["auto-stop-interval"], "--auto-stop-interval") ??
    parseAutoStopInterval(process.env.DAYTONA_AUTO_STOP_INTERVAL, "DAYTONA_AUTO_STOP_INTERVAL");
  const autoDeleteInterval =
    parseAutoDeleteInterval(values["auto-delete-interval"], "--auto-delete-interval") ??
    parseAutoDeleteInterval(
      process.env.DAYTONA_AUTO_DELETE_INTERVAL,
      "DAYTONA_AUTO_DELETE_INTERVAL",
    );

  return {
    port: parsePort(values.port),
    keepSandbox: values["keep-sandbox"],
    sandboxName: values["sandbox-name"],
    createTimeoutSec: parsePositiveInt(values["create-timeout-sec"], "--create-timeout-sec"),
    installTimeoutSec: parsePositiveInt(values["install-timeout-sec"], "--install-timeout-sec"),
    autoStopInterval,
    autoDeleteInterval,
    target: values.target,
    openUi: !values["no-open"],
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPreviewUrlPattern(previewUrl: string, port: number): string {
  const asStringPort = `:${port}`;
  if (previewUrl.includes(asStringPort)) {
    return previewUrl.replace(asStringPort, ":{PORT}");
  }
  return previewUrl.replace(`${port}`, "{PORT}");
}

function buildOpencodeConfig(previewUrlPattern: string): string {
  const prompt = [
    "You are running in a Daytona sandbox.",
    "Use /home/daytona for file operations unless the task explicitly requires another directory.",
    `Services started on localhost inside this sandbox are reachable from outside as: ${previewUrlPattern}.`,
    "When you start a server, always provide the preview URL to the user.",
    "Start long-running services in the background so the shell stays usable.",
  ].join(" ");

  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      default_agent: "daytona",
      agent: {
        daytona: {
          description: "Daytona sandbox-aware coding agent",
          mode: "primary",
          prompt,
        },
      },
    },
    null,
    2,
  );
}

function extractNewLogChunk(latest: string | undefined, cursor: LogCursor): string {
  if (!latest) {
    return "";
  }

  if (latest.startsWith(cursor.value)) {
    const next = latest.slice(cursor.value.length);
    cursor.value = latest;
    return next;
  }

  cursor.value = latest;
  return latest;
}

function rewriteLocalhostUrls(text: string, port: number, previewUrl: string): string {
  const regex = new RegExp(
    `http:\\/\\/(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|localhost):${port}(?:\\/[^\\s]*)?`,
    "g",
  );
  return text.replace(regex, (localUrl) => {
    try {
      const source = new URL(localUrl);
      const target = new URL(previewUrl);
      target.pathname = source.pathname;
      target.search = source.search;
      target.hash = source.hash;
      return target.toString();
    } catch {
      return previewUrl;
    }
  });
}

async function runOpenCommand(command: string, args: string[]): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const child = spawn(command, args, { detached: true, stdio: "ignore" });

    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });

    child.once("spawn", () => {
      child.unref();
      if (!settled) {
        settled = true;
        resolve(true);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, 2000);
  });
}

async function tryOpenDesktop(url: string): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  return (
    (await runOpenCommand("open", ["-a", "OpenCode", url])) ||
    (await runOpenCommand("open", ["-a", "OpenCode"]))
  );
}

async function tryOpenBrowser(url: string): Promise<boolean> {
  if (process.platform === "darwin") {
    return await runOpenCommand("open", [url]);
  }
  if (process.platform === "win32") {
    return await runOpenCommand("cmd", ["/c", "start", "", url]);
  }
  return await runOpenCommand("xdg-open", [url]);
}

async function openUi(url: string): Promise<void> {
  if (await tryOpenDesktop(url)) {
    console.log("[local] Opened OpenCode desktop app.");
    return;
  }
  if (await tryOpenBrowser(url)) {
    console.log("[local] Opened OpenCode web URL in browser.");
    return;
  }
  console.log(`[local] Could not auto-open URL. Open manually: ${url}`);
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
        console.log(`[local] Using legacy toolbox fallback URL: ${cachedFallbackUrl}`);
      }

      const fallbackUrl = cachedFallbackUrl;
      if (!fallbackUrl) {
        throw new Error("Failed to resolve toolbox fallback URL.");
      }
      return fallbackUrl;
    }
  };
}

async function runCommand(
  sandbox: Sandbox,
  command: string,
  label: string,
  timeoutSec: number,
): Promise<void> {
  const result = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}\n${result.result}`);
  }
}

async function streamCommandLogsUntilExit(params: {
  sandbox: Sandbox;
  sessionId: string;
  commandId: string;
  port: number;
  previewUrl: string;
  shouldStop: () => boolean;
}): Promise<number | undefined> {
  const { sandbox, sessionId, commandId, port, previewUrl, shouldStop } = params;
  const stdoutCursor: LogCursor = { value: "" };
  const stderrCursor: LogCursor = { value: "" };

  while (true) {
    if (shouldStop()) {
      return undefined;
    }

    const [logs, cmd] = await Promise.all([
      sandbox.process.getSessionCommandLogs(sessionId, commandId),
      sandbox.process.getSessionCommand(sessionId, commandId),
    ]);

    const nextStdout = extractNewLogChunk(logs.stdout, stdoutCursor);
    if (nextStdout) {
      process.stdout.write(rewriteLocalhostUrls(nextStdout, port, previewUrl));
    }

    const nextStderr = extractNewLogChunk(logs.stderr, stderrCursor);
    if (nextStderr) {
      process.stderr.write(rewriteLocalhostUrls(nextStderr, port, previewUrl));
    }

    if (cmd.exitCode !== undefined) {
      return cmd.exitCode;
    }

    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const loadedEnv = await loadConfiguredEnv();
  if (loadedEnv.keysLoaded.length > 0) {
    console.log(
      `[local] Loaded ${loadedEnv.keysLoaded.length} env var(s) from config (.env) files.`,
    );
  }

  const options = parseCliOptions();
  const apiKey = requireEnv("DAYTONA_API_KEY");
  const apiUrl = process.env.DAYTONA_API_URL;
  const effectiveTarget = options.target ?? process.env.DAYTONA_TARGET;

  const daytona = new Daytona({
    apiKey,
    apiUrl,
    target: effectiveTarget,
  });
  patchToolboxProxyUrlFallback(daytona);
  const opencodeServerPassword = process.env.OPENCODE_SERVER_PASSWORD;

  let sandbox: Sandbox | undefined;
  let sessionId: string | undefined;
  let commandId: string | undefined;
  let stopRequested = false;
  let cleaningUp = false;
  let cleanupOnSignalStarted = false;

  const cleanup = async (): Promise<void> => {
    if (cleaningUp) {
      return;
    }
    cleaningUp = true;

    if (sandbox && sessionId && commandId) {
      try {
        await sandbox.process.sendSessionCommandInput(sessionId, commandId, "\u0003");
        await sleep(250);
      } catch {
        // Ignore cleanup-time process signaling failures.
      }
    }

    if (sandbox && sessionId) {
      try {
        await sandbox.process.deleteSession(sessionId);
      } catch {
        // Ignore session delete failures during cleanup.
      }
    }

    if (sandbox && options.keepSandbox) {
      console.log(`[local] Keeping sandbox: ${sandbox.id}`);
      return;
    }

    if (sandbox) {
      console.log(`[local] Deleting sandbox: ${sandbox.id}`);
      await sandbox.delete();
      console.log("[local] Sandbox deleted.");
    }
  };

  const requestStop = (signal: NodeJS.Signals): void => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    console.log(`\n[local] Received ${signal}. Stopping...`);

    if (!cleanupOnSignalStarted) {
      cleanupOnSignalStarted = true;
      void (async () => {
        try {
          await cleanup();
          process.exit(0);
        } catch (error) {
          const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
          console.error(`[local] Cleanup failed after ${signal}: ${message}`);
          process.exit(1);
        }
      })();
    }
  };

  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  try {
    console.log("[local] Creating Daytona sandbox...");
    const createParams: {
      name?: string;
      language: "typescript";
      autoStopInterval?: number;
      autoDeleteInterval?: number;
    } = {
      name: options.sandboxName,
      language: "typescript",
    };

    if (options.autoStopInterval !== undefined) {
      createParams.autoStopInterval = options.autoStopInterval;
    }
    if (options.autoDeleteInterval !== undefined) {
      createParams.autoDeleteInterval = options.autoDeleteInterval;
    }

    sandbox = await daytona.create(createParams, { timeout: options.createTimeoutSec });
    console.log(`[local] Sandbox ready: ${sandbox.id}`);

    const userHome = (await sandbox.getUserHomeDir()) ?? "/home/daytona";
    const opencodeConfigPath = `${userHome}/.config/opencode/opencode.json`;
    const opencodeConfigDir = `${userHome}/.config/opencode`;

    const preview = await sandbox.getPreviewLink(options.port);
    const previewUrlPattern = getPreviewUrlPattern(preview.url, options.port);
    const configContents = buildOpencodeConfig(previewUrlPattern);

    await runCommand(
      sandbox,
      `mkdir -p ${shellEscape(opencodeConfigDir)}`,
      "Prepare OpenCode config directory",
      60,
    );

    await sandbox.fs.uploadFile(Buffer.from(configContents, "utf8"), opencodeConfigPath);

    console.log("[local] Installing latest OpenCode CLI in sandbox...");
    await runCommand(
      sandbox,
      buildInstallOpencodeCommand(),
      "Install OpenCode CLI",
      options.installTimeoutSec,
    );

    const resolveOpencodeBin =
      "if command -v opencode >/dev/null 2>&1; then command -v opencode; " +
      'elif [ -x "$HOME/.bun/bin/opencode" ]; then echo "$HOME/.bun/bin/opencode"; ' +
      'elif [ -x "$HOME/.local/bin/opencode" ]; then echo "$HOME/.local/bin/opencode"; ' +
      'else echo "opencode binary not found in PATH, ~/.bun/bin, or ~/.local/bin" >&2; exit 127; fi';

    sessionId = `opencode-${randomUUID().slice(0, 8)}`;
    await sandbox.process.createSession(sessionId);

    const launchResponse = await sandbox.process.executeSessionCommand(sessionId, {
      command:
        (opencodeServerPassword
          ? `OPENCODE_SERVER_PASSWORD=${shellEscape(opencodeServerPassword)} `
          : "") +
        'OPENCODE_BIN="$(' +
        resolveOpencodeBin +
        ')"; "$OPENCODE_BIN" web --hostname 0.0.0.0 --port ' +
        options.port +
        " --print-logs",
      runAsync: true,
    });
    commandId = launchResponse.cmdId;

    console.log(`[local] OpenCode remote web UI: ${preview.url}`);
    console.log(`[local] Session: ${sessionId}`);
    if (!opencodeServerPassword) {
      console.log("[local] Warning: OPENCODE_SERVER_PASSWORD is not set (web UI is unsecured).");
    }
    if (options.openUi) {
      await openUi(preview.url);
    }
    console.log(
      `[local] Press Ctrl+C to stop${options.keepSandbox ? " (sandbox will be kept)" : ""}.`,
    );

    const opencodeExitCode = await streamCommandLogsUntilExit({
      sandbox,
      sessionId,
      commandId,
      port: options.port,
      previewUrl: preview.url,
      shouldStop: () => stopRequested,
    });

    if (opencodeExitCode !== undefined) {
      console.log(`[local] OpenCode process exited with code ${opencodeExitCode}.`);
      if (opencodeExitCode !== 0) {
        throw new Error(`OpenCode exited with non-zero code: ${opencodeExitCode}`);
      }
    }
  } finally {
    await cleanup();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[local] Failed: ${message}`);
  process.exit(1);
});
