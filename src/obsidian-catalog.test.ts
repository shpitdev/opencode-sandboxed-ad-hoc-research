import { describe, expect, test } from "bun:test";
import path from "node:path";
import { __testables } from "./obsidian-catalog.js";

describe("obsidian catalog pathing", () => {
  test("builds date-based note path", () => {
    const relativePath = __testables.buildRelativeNotePath({
      notesRoot: "Research/OpenCode",
      catalogMode: "date",
      slug: "owner-repo",
      runLabel: "01-owner-repo",
    });

    expect(relativePath).toMatch(
      /^Research[\\/]OpenCode[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}-01-owner-repo\.md$/,
    );
  });

  test("builds repo-based note path", () => {
    const relativePath = __testables.buildRelativeNotePath({
      notesRoot: "Research/OpenCode",
      catalogMode: "repo",
      slug: "owner/repo",
      runLabel: "01-owner-repo",
    });

    expect(relativePath).toMatch(
      /^Research[\\/]OpenCode[\\/]owner-repo[\\/]\d{4}-\d{2}-\d{2}-01-owner-repo\.md$/,
    );
  });

  test("keeps resolved note path inside vault", () => {
    const notePath = __testables.resolveNotePathWithinVault("/vault", "Research/OpenCode/note.md");
    expect(notePath).toBe(path.resolve("/vault", "Research/OpenCode/note.md"));
  });

  test("rejects note path traversal outside vault", () => {
    expect(() => __testables.resolveNotePathWithinVault("/vault", "../../etc/passwd")).toThrow(
      /outside Obsidian vault/,
    );
  });
});
