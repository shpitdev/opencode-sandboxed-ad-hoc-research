#!/usr/bin/env bun
import process from "node:process";
import { runSandcodeCli } from "../dist/sandcode.js";

const exitCode = await runSandcodeCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`sandcode: ${message}`);
  return 1;
});

process.exit(exitCode);
