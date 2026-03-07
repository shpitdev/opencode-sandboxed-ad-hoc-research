export function getNextWizardStepIndex(currentStepIndex: number, stepCount: number): number {
  return Math.min(currentStepIndex + 1, Math.max(stepCount - 1, 0));
}
