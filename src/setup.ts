import process from "node:process";
import {
  applySetupState,
  buildInitialSetupState,
  formatSetupHelp,
  loadSetupContext,
  parseSetupCliOptions,
  summarizeSetupContext,
} from "./setup-core.js";
import { runSetupTui } from "./setup-ui.js";

function logProgress(prefix: string, event: { level: "info" | "warn"; message: string }): void {
  const log = event.level === "warn" ? console.warn : console.log;
  log(`${prefix}${event.message}`);
}

export async function runSetupCli(args = process.argv.slice(2)): Promise<number> {
  const options = parseSetupCliOptions(args);
  if (!options) {
    console.log(formatSetupHelp());
    return 0;
  }

  const context = await loadSetupContext();
  if (context.loadedEnv.keysLoaded.length > 0) {
    console.log(
      `[setup] Loaded ${context.loadedEnv.keysLoaded.length} env var(s) from config (.env) files.`,
    );
  }

  if (options.yes) {
    for (const event of summarizeSetupContext(context)) {
      logProgress("[setup] ", event);
    }

    await applySetupState(context, buildInitialSetupState(context, options), (event) => {
      logProgress("[setup] ", event);
    });
    return 0;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive setup requires a TTY. Re-run with `sandcode setup --yes` and flags.",
    );
  }

  const result = await runSetupTui(context, buildInitialSetupState(context, options));
  console.log(`[setup] Config: ${result.configPath}`);
  if (result.envPath) {
    console.log(`[setup] Env: ${result.envPath}`);
  }
  return 0;
}

if (import.meta.main) {
  const exitCode = await runSetupCli().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`[setup] Failed: ${message}`);
    return 1;
  });
  process.exit(exitCode);
}
