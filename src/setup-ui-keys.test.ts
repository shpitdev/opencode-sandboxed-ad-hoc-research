import { describe, expect, test } from "bun:test";
import { isSubmitKey, parseChoiceShortcut } from "./setup-ui-keys.js";

describe("setup UI key handling", () => {
  test("accepts common submit key names", () => {
    expect(isSubmitKey("return")).toBe(true);
    expect(isSubmitKey("linefeed")).toBe(true);
    expect(isSubmitKey("enter")).toBe(true);
    expect(isSubmitKey("space")).toBe(false);
  });

  test("maps numeric shortcuts to zero-based choice indexes", () => {
    expect(parseChoiceShortcut("1")).toBe(0);
    expect(parseChoiceShortcut("2")).toBe(1);
    expect(parseChoiceShortcut("9")).toBe(8);
    expect(parseChoiceShortcut("0")).toBeUndefined();
    expect(parseChoiceShortcut("x")).toBeUndefined();
  });
});
