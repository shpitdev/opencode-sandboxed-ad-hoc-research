import { mkdir, rm } from "node:fs/promises";
import solidPlugin from "@opentui/solid/bun-plugin";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./src/sandcode.ts"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
  sourcemap: "none",
  minify: false,
  splitting: false,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
