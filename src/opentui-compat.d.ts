import type { CliRenderer, CliRendererConfig, KeyEvent } from "@opentui/core";

declare module "@opentui/core" {
  export function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>;
}

declare module "@opentui/solid" {
  export function useKeyboard(
    callback: (key: KeyEvent) => void,
    options?: { release?: boolean },
  ): void;
}
