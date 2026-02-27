import { describe, expect, test } from "bun:test";
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
});
