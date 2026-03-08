export function isSubmitKey(name: string): boolean {
  return name === "return" || name === "linefeed" || name === "enter";
}

export function parseChoiceShortcut(name: string): number | undefined {
  if (!/^[1-9]$/.test(name)) {
    return undefined;
  }

  return Number.parseInt(name, 10) - 1;
}
