import { describe, expect, test } from "bun:test";
import { __testables } from "./sandcode-config.js";

describe("sandcode config parsing", () => {
  test("parses obsidian table values", () => {
    const parsed = __testables.parseToml(
      [
        "[obsidian]",
        "enabled = true",
        'command = "obsidian"',
        'vault_path = "/vault"',
        'notes_root = "Research/Sandcode"',
        'catalog_mode = "repo"',
        "open_after_catalog = false",
        'integration_mode = "headless"',
        'headless_command = "ob"',
        "sync_after_catalog = true",
        "sync_timeout_sec = 180",
      ].join("\n"),
      "sandcode.toml",
    );

    expect(parsed).toBeObject();
    const obsidian = parsed.obsidian as Record<string, unknown>;
    expect(obsidian.enabled).toBe(true);
    expect(obsidian.command).toBe("obsidian");
    expect(obsidian.vault_path).toBe("/vault");
    expect(obsidian.notes_root).toBe("Research/Sandcode");
    expect(obsidian.catalog_mode).toBe("repo");
    expect(obsidian.open_after_catalog).toBe(false);
    expect(obsidian.integration_mode).toBe("headless");
    expect(obsidian.headless_command).toBe("ob");
    expect(obsidian.sync_after_catalog).toBe(true);
    expect(obsidian.sync_timeout_sec).toBe(180);
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
    expect(config.notesRoot).toBe("Research/Sandcode");
    expect(config.openAfterCatalog).toBe(false);
    expect(config.integrationMode).toBe("desktop");
    expect(config.headlessCommand).toBe("ob");
    expect(config.syncAfterCatalog).toBe(false);
    expect(config.syncTimeoutSec).toBe(120);
  });

  test("enables sync_after_catalog by default in headless mode", () => {
    const config = __testables.resolveFinalConfig({
      obsidian: {
        integrationMode: "headless",
      },
    });

    expect(config.integrationMode).toBe("headless");
    expect(config.syncAfterCatalog).toBe(true);
  });

  test("rejects invalid integration mode", () => {
    expect(() =>
      __testables.resolveFinalConfig({
        obsidian: {
          integrationMode: "mobile" as "desktop" | "headless",
        },
      }),
    ).toThrow(/integration_mode/);
  });

  test("rejects non-positive sync timeout", () => {
    expect(() =>
      __testables.resolveFinalConfig({
        obsidian: {
          syncTimeoutSec: 0,
        },
      }),
    ).toThrow(/sync_timeout_sec/);
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
