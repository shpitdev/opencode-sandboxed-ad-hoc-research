import { existsSync } from "node:fs";
import process from "node:process";
import pkg from "../package.json" with { type: "json" };
import { runAnalyzeCli } from "./analyze-repos.js";
import { runSetupCli } from "./setup.js";
import { runStartCli } from "./start-opencode-daytona.js";

function formatRootHelp(): string {
  return `sandcode ${pkg.version}

Usage:
  sandcode <repo-url>
  sandcode <links-file>
  sandcode <command> [options]

Commands:
  analyze    Audit one or more repositories in Daytona sandboxes
  start      Launch OpenCode web in a Daytona sandbox
  setup      Configure Obsidian integration and local credentials
  help       Show this help

Examples:
  bunx sandcode https://github.com/octocat/Hello-World
  bunx sandcode links.md
  bunx sandcode start
  bunx sandcode setup
`;
}

function isLikelyUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export async function runSandcodeCli(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(formatRootHelp());
    return 0;
  }

  if (command === "--version" || command === "-v") {
    console.log(pkg.version);
    return 0;
  }

  if (command === "start") {
    return await runStartCli(rest);
  }

  if (command === "setup") {
    return await runSetupCli(rest);
  }

  if (command === "analyze") {
    return await runAnalyzeCli(rest);
  }

  if (isLikelyUrl(command)) {
    return await runAnalyzeCli(args);
  }

  if (!command.startsWith("-") && existsSync(command)) {
    return await runAnalyzeCli(args);
  }

  console.error(`sandcode: unknown command or target "${command}"`);
  console.log(formatRootHelp());
  return 1;
}

if (import.meta.main) {
  const exitCode = await runSandcodeCli().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`sandcode: ${message}`);
    return 1;
  });
  process.exit(exitCode);
}
