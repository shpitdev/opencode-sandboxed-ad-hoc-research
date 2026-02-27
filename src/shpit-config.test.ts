import { describe, expect, test } from "bun:test";
import { __testables } from "./shpit-config.js";

describe("shpit config parsing", () => {
  test("parses obsidian table values", () => {
    const parsed = __testables.parseToml(
      [
        "[obsidian]",
        "enabled = true",
        'command = "obsidian"',
        'vault_path = "/vault"',
        'notes_root = "Research/OpenCode"',
        'catalog_mode = "repo"',
        "open_after_catalog = false",
      ].join("\n"),
      "shpit.toml",
    );

    expect(parsed).toBeObject();
    const obsidian = parsed.obsidian as Record<string, unknown>;
    expect(obsidian.enabled).toBe(true);
    expect(obsidian.command).toBe("obsidian");
    expect(obsidian.vault_path).toBe("/vault");
    expect(obsidian.notes_root).toBe("Research/OpenCode");
    expect(obsidian.catalog_mode).toBe("repo");
    expect(obsidian.open_after_catalog).toBe(false);
  });

  test("rejects obs command alias", () => {
    expect(() =>
      __testables.resolveFinalConfig({
        obsidian: {
          command: "obs",
        },
      }),
    ).toThrow(/Use "obsidian"/);
  });

  test("uses sane defaults", () => {
    const config = __testables.resolveFinalConfig({});
    expect(config.enabled).toBe(false);
    expect(config.command).toBe("obsidian");
    expect(config.catalogMode).toBe("date");
    expect(config.notesRoot).toBe("Research/OpenCode");
    expect(config.openAfterCatalog).toBe(false);
  });
});

describe("env parsing", () => {
  test("parses quoted and unquoted values", () => {
    const env = __testables.parseEnvFile(
      [
        "# comment",
        "DAYTONA_API_KEY=abc123",
        'OPENAI_API_KEY="sk-test"',
        "EMPTY=",
        "NOT_A_KEY hi",
      ].join("\n"),
    );

    expect(env.get("DAYTONA_API_KEY")).toBe("abc123");
    expect(env.get("OPENAI_API_KEY")).toBe("sk-test");
    expect(env.get("EMPTY")).toBe("");
    expect(env.has("NOT_A_KEY hi")).toBe(false);
  });
});
