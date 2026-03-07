import { describe, expect, test } from "bun:test";
import { getNextWizardStepIndex } from "./setup-ui-state.js";

describe("getNextWizardStepIndex", () => {
  test("advances to the next step when the wizard still has remaining steps", () => {
    expect(getNextWizardStepIndex(1, 5)).toBe(2);
  });

  test("clamps to the final available step when the step count shrinks", () => {
    expect(getNextWizardStepIndex(3, 2)).toBe(1);
  });

  test("returns zero when no steps remain", () => {
    expect(getNextWizardStepIndex(0, 0)).toBe(0);
  });
});
