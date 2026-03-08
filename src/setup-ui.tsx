import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For } from "solid-js";
import {
  applySetupState,
  type SetupContext,
  type SetupProgressEvent,
  type SetupResult,
  type SetupState,
  summarizeSetupContext,
} from "./setup-core.js";
import { isSubmitKey, parseChoiceShortcut } from "./setup-ui-keys.js";
import { getNextWizardStepIndex } from "./setup-ui-state.js";

type WizardChoice = {
  name: string;
  description: string;
  value: string;
};

type WizardStep =
  | {
      kind: "choice";
      key: string;
      title: string;
      eyebrow: string;
      description: string;
      hint: string;
      value: string;
      options: WizardChoice[];
      commit: (draft: SetupState, value: string) => void;
    }
  | {
      kind: "input";
      key: string;
      title: string;
      eyebrow: string;
      description: string;
      hint: string;
      value: string;
      placeholder: string;
      commit: (draft: SetupState, value: string) => void;
    }
  | {
      kind: "summary";
      key: string;
    };

function appendStatus(
  lines: SetupProgressEvent[],
  event: SetupProgressEvent,
): SetupProgressEvent[] {
  return [...lines, event].slice(-10);
}

function buildSteps(state: SetupState): WizardStep[] {
  const steps: WizardStep[] = [
    {
      kind: "choice",
      key: "enable-obsidian",
      eyebrow: "Setup",
      title: "Catalog findings into Obsidian?",
      description: "Enable note creation for research runs and keep the workflow in one place.",
      hint: "Left/right changes the option. Enter commits it. Esc goes back.",
      value: state.enableObsidian ? "yes" : "no",
      options: [
        { name: "Yes", description: "Write findings into your vault automatically.", value: "yes" },
        { name: "No", description: "Skip vault integration for now.", value: "no" },
      ],
      commit: () => {},
    },
  ];

  if (state.enableObsidian) {
    steps.push(
      {
        kind: "choice",
        key: "integration-mode",
        eyebrow: "Obsidian",
        title: "Choose the integration mode",
        description:
          "Headless works well for automation. Desktop is simpler if you already use the Obsidian CLI locally.",
        hint: "Enter commits the current mode.",
        value: state.integrationMode,
        options: [
          {
            name: "Headless",
            description: "Best for automation. Uses `ob` and can sync after note writes.",
            value: "headless",
          },
          {
            name: "Desktop",
            description: "Uses the `obsidian` command and can open notes after creation.",
            value: "desktop",
          },
        ],
        commit: () => {},
      },
      {
        kind: "input",
        key: "vault-path",
        eyebrow: "Obsidian",
        title: "Where is the vault?",
        description:
          "Use an absolute path or `~/...`. This is required when cataloging is enabled.",
        hint: "Type the path and press Enter to continue.",
        value: state.vaultPath,
        placeholder: "/Users/you/vaults/research",
        commit: () => {},
      },
      {
        kind: "input",
        key: "notes-root",
        eyebrow: "Obsidian",
        title: "Which folder should Sandcode write into?",
        description: "This becomes the root path inside the vault for all generated notes.",
        hint: "Press Enter to continue.",
        value: state.notesRoot,
        placeholder: "Research/Sandcode",
        commit: () => {},
      },
      {
        kind: "choice",
        key: "catalog-mode",
        eyebrow: "Obsidian",
        title: "How should notes be grouped?",
        description:
          "Date mode is broad and chronological. Repo mode clusters repeat analyses together.",
        hint: "Enter commits the grouping mode.",
        value: state.catalogMode,
        options: [
          {
            name: "Date",
            description: "Folders by date. Good for broad research sessions.",
            value: "date",
          },
          {
            name: "Repo",
            description: "Folders by repository. Better for revisiting the same codebase.",
            value: "repo",
          },
        ],
        commit: () => {},
      },
    );

    if (state.integrationMode === "headless") {
      steps.push(
        {
          kind: "choice",
          key: "sync-after-catalog",
          eyebrow: "Headless",
          title: "Run `ob sync` after each note write?",
          description:
            "Useful if you want findings to appear remotely without a separate sync step.",
          hint: "Enter commits the choice.",
          value: state.syncAfterCatalog ? "yes" : "no",
          options: [
            { name: "Yes", description: "Run headless sync after writes.", value: "yes" },
            { name: "No", description: "Leave syncing manual.", value: "no" },
          ],
          commit: () => {},
        },
        {
          kind: "input",
          key: "sync-timeout",
          eyebrow: "Headless",
          title: "How long should sync wait before timing out?",
          description: "Only used in headless mode.",
          hint: "Enter a positive number of seconds and press Enter.",
          value: state.syncTimeoutInput,
          placeholder: "120",
          commit: () => {},
        },
      );
    } else {
      steps.push({
        kind: "choice",
        key: "open-after-catalog",
        eyebrow: "Desktop",
        title: "Open each created note in Obsidian?",
        description: "Convenient during live research. Leave it off if you want a quieter flow.",
        hint: "Enter commits the choice.",
        value: state.openAfterCatalog ? "yes" : "no",
        options: [
          { name: "Yes", description: "Launch each note after creation.", value: "yes" },
          { name: "No", description: "Only write the files.", value: "no" },
        ],
        commit: () => {},
      });
    }
  }

  steps.push(
    {
      kind: "input",
      key: "daytona-key",
      eyebrow: "Credentials",
      title: "DAYTONA_API_KEY",
      description: "Required for `sandcode start` and `sandcode analyze`.",
      hint: "Visible as typed in this terminal. Leave blank to keep the current shell or env-file value.",
      value: state.daytonaApiKey,
      placeholder: "daytona_...",
      commit: () => {},
    },
    {
      kind: "input",
      key: "opencode-key",
      eyebrow: "Credentials",
      title: "OPENCODE_API_KEY",
      description: "Required for the built-in opencode-go model defaults.",
      hint: "Visible as typed in this terminal. Leave blank to keep the current shell or env-file value.",
      value: state.opencodeApiKey,
      placeholder: "oc_...",
      commit: () => {},
    },
    {
      kind: "summary",
      key: "summary",
    },
  );

  return steps.map((step) => {
    if (step.key === "enable-obsidian") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => {
          draft.enableObsidian = value === "yes";
          if (!draft.enableObsidian) {
            draft.vaultPath = "";
          }
        },
      };
    }

    if (step.key === "integration-mode") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => {
          draft.integrationMode = value === "headless" ? "headless" : "desktop";
          if (draft.integrationMode === "headless") {
            draft.openAfterCatalog = false;
          } else {
            draft.syncAfterCatalog = false;
          }
        },
      };
    }

    if (step.key === "vault-path") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => (draft.vaultPath = value.trim()),
      };
    }

    if (step.key === "notes-root") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => (draft.notesRoot = value.trim()),
      };
    }

    if (step.key === "catalog-mode") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => {
          draft.catalogMode = value === "repo" ? "repo" : "date";
        },
      };
    }

    if (step.key === "sync-after-catalog") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => {
          draft.syncAfterCatalog = value === "yes";
        },
      };
    }

    if (step.key === "sync-timeout") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => {
          draft.syncTimeoutInput = value;
          const parsed = Number.parseInt(value.trim(), 10);
          if (Number.isInteger(parsed) && parsed > 0) {
            draft.syncTimeoutSec = parsed;
            draft.syncTimeoutError = undefined;
            return;
          }
          draft.syncTimeoutError = "Sync timeout must be a positive integer.";
        },
      };
    }

    if (step.key === "open-after-catalog") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => {
          draft.openAfterCatalog = value === "yes";
        },
      };
    }

    if (step.key === "daytona-key") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => (draft.daytonaApiKey = value.trim()),
      };
    }

    if (step.key === "opencode-key") {
      return {
        ...step,
        commit: (draft: SetupState, value: string) => (draft.opencodeApiKey = value.trim()),
      };
    }

    return step;
  });
}

function stateSnapshot(state: SetupState): string[] {
  const lines = [
    `Obsidian: ${state.enableObsidian ? "enabled" : "disabled"}`,
    `Mode: ${state.integrationMode}`,
  ];

  if (state.enableObsidian) {
    lines.push(`Vault: ${state.vaultPath || "(missing)"}`);
    lines.push(`Notes root: ${state.notesRoot || "(missing)"}`);
    lines.push(`Catalog: ${state.catalogMode}`);
    lines.push(
      state.integrationMode === "headless"
        ? `Sync after catalog: ${state.syncAfterCatalog ? "yes" : "no"}`
        : `Open after catalog: ${state.openAfterCatalog ? "yes" : "no"}`,
    );
  }

  lines.push(`DAYTONA_API_KEY: ${state.daytonaApiKey ? "seeded" : "not set"}`);
  lines.push(`OPENCODE_API_KEY: ${state.opencodeApiKey ? "seeded" : "not set"}`);
  return lines;
}

export function SetupWizard(props: {
  context: SetupContext;
  initialState: SetupState;
  complete: (result: SetupResult) => void;
  cancel: (error: Error) => void;
}) {
  const [state, setState] = createSignal<SetupState>({ ...props.initialState });
  const [stepIndex, setStepIndex] = createSignal(0);
  const [phase, setPhase] = createSignal<"wizard" | "saving" | "done" | "error">("wizard");
  const [statusLines, setStatusLines] = createSignal<SetupProgressEvent[]>(
    summarizeSetupContext(props.context),
  );
  const [errorMessage, setErrorMessage] = createSignal<string>();
  const [result, setResult] = createSignal<SetupResult>();
  const [summaryActionIndex, setSummaryActionIndex] = createSignal(0);

  const steps = createMemo(() => buildSteps({ ...state() }));
  const activeStep = createMemo(() => steps()[Math.min(stepIndex(), steps().length - 1)]);
  const activeChoiceStep = createMemo(() => {
    const step = activeStep();
    return step.kind === "choice" ? step : undefined;
  });
  const activeInputStep = createMemo(() => {
    const step = activeStep();
    return step.kind === "input" ? step : undefined;
  });
  const activeChoiceIndex = createMemo(() => {
    const step = activeChoiceStep();
    if (!step) {
      return 0;
    }
    const index = step.options.findIndex((option) => option.value === step.value);
    return index >= 0 ? index : 0;
  });

  createEffect(() => {
    if (activeStep().kind === "summary") {
      setSummaryActionIndex(0);
    }
  });

  const goBack = (): void => {
    if (phase() === "saving") {
      return;
    }

    if (phase() === "wizard" && stepIndex() > 0) {
      setStepIndex((value) => value - 1);
      return;
    }

    if (phase() === "done") {
      const current = result();
      if (current) {
        props.complete(current);
      }
      return;
    }

    if (phase() === "error") {
      setPhase("wizard");
      setErrorMessage(undefined);
      return;
    }

    props.cancel(new Error("Setup cancelled."));
  };

  const commitAndAdvance = (commit: () => void): void => {
    commit();
    const nextSteps = steps();
    setStepIndex((value) => getNextWizardStepIndex(value, nextSteps.length));
  };

  let saveInFlight = false;
  const save = async (): Promise<void> => {
    if (saveInFlight) {
      return;
    }
    saveInFlight = true;
    setPhase("saving");
    setErrorMessage(undefined);
    setStatusLines((current) =>
      appendStatus(current, { level: "info", message: "Writing Sandcode configuration..." }),
    );

    try {
      const saved = await applySetupState(props.context, state(), (event) => {
        setStatusLines((current) => appendStatus(current, event));
      });
      setResult(saved);
      setPhase("done");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setPhase("error");
    } finally {
      saveInFlight = false;
    }
  };

  const updateChoiceSelection = (offset: -1 | 1): void => {
    const step = activeChoiceStep();
    if (!step) {
      return;
    }

    const nextIndex = Math.max(0, Math.min(activeChoiceIndex() + offset, step.options.length - 1));
    const option = step.options[nextIndex];
    if (!option) {
      return;
    }

    setState((current) => {
      const next = { ...current };
      step.commit(next, option.value);
      return next;
    });
  };

  const commitChoiceAndAdvance = (): void => {
    const step = activeChoiceStep();
    if (!step) {
      return;
    }

    const option = step.options[activeChoiceIndex()];
    if (!option) {
      return;
    }

    commitAndAdvance(() => {
      setState((current) => {
        const next = { ...current };
        step.commit(next, option.value);
        return next;
      });
    });
  };

  const triggerSummaryAction = (): void => {
    if (summaryActionIndex() === 1) {
      props.cancel(new Error("Setup cancelled."));
      return;
    }

    void save();
  };

  const triggerSummaryShortcut = (index: number): void => {
    if (index < 0 || index > 1) {
      return;
    }

    setSummaryActionIndex(index);
    if (index === 1) {
      props.cancel(new Error("Setup cancelled."));
      return;
    }

    void save();
  };

  useKeyboard(
    (event: {
      ctrl: boolean;
      name: string;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => {
      if (event.ctrl && event.name === "c") {
        event.preventDefault();
        event.stopPropagation();
        props.cancel(new Error("Setup cancelled."));
        return;
      }

      if (event.name === "escape") {
        event.preventDefault();
        event.stopPropagation();
        goBack();
        return;
      }

      if (phase() === "wizard" && activeStep().kind === "choice") {
        const shortcutIndex = parseChoiceShortcut(event.name);
        if (shortcutIndex !== undefined) {
          const step = activeChoiceStep();
          const option = step?.options[shortcutIndex];
          if (!option || !step) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          commitAndAdvance(() => {
            setState((current) => {
              const next = { ...current };
              step.commit(next, option.value);
              return next;
            });
          });
          return;
        }

        if (event.name === "left") {
          event.preventDefault();
          event.stopPropagation();
          updateChoiceSelection(-1);
          return;
        }

        if (event.name === "right") {
          event.preventDefault();
          event.stopPropagation();
          updateChoiceSelection(1);
          return;
        }

        if (isSubmitKey(event.name)) {
          event.preventDefault();
          event.stopPropagation();
          commitChoiceAndAdvance();
          return;
        }
      }

      if (phase() === "wizard" && activeStep().kind === "summary") {
        const shortcutIndex = parseChoiceShortcut(event.name);
        if (shortcutIndex !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          triggerSummaryShortcut(shortcutIndex);
          return;
        }

        if (event.name === "left") {
          event.preventDefault();
          event.stopPropagation();
          setSummaryActionIndex(0);
          return;
        }

        if (event.name === "right") {
          event.preventDefault();
          event.stopPropagation();
          setSummaryActionIndex(1);
          return;
        }

        if (isSubmitKey(event.name)) {
          event.preventDefault();
          event.stopPropagation();
          triggerSummaryAction();
          return;
        }
      }

      if ((phase() === "done" || phase() === "error") && isSubmitKey(event.name)) {
        event.preventDefault();
        event.stopPropagation();
        goBack();
      }
    },
  );

  return (
    <box
      flexDirection="column"
      padding={1}
      gap={1}
      height="100%"
      width="100%"
      backgroundColor="#0e1116"
    >
      <box
        border
        borderColor="#25434f"
        padding={1}
        flexDirection="column"
        backgroundColor="#12202b"
      >
        <text>
          <strong fg="#f6d365">sandcode </strong>
          <span fg="#8aa5b8">
            Daytona research, OpenCode sandboxes, and a setup flow worth reusing.
          </span>
        </text>
      </box>

      <box flexDirection="row" gap={1} flexGrow={1} minHeight={12}>
        <box
          width="34%"
          border
          borderColor="#25434f"
          padding={1}
          flexDirection="column"
          backgroundColor="#0f161d"
          gap={1}
        >
          <text>
            <strong fg="#9fd3c7">Path</strong>
          </text>
          <For each={steps()}>
            {(step, index) => (
              <text fg={index() === stepIndex() ? "#f6d365" : "#7d91a2"}>
                {index() === stepIndex() ? "› " : "  "}
                {step.kind === "summary" ? "Review and save" : step.title}
              </text>
            )}
          </For>

          <box border borderColor="#1d313a" padding={1} flexDirection="column" gap={1}>
            <text>
              <strong fg="#9fd3c7">Current state</strong>
            </text>
            <For each={stateSnapshot(state())}>{(line) => <text fg="#aab8c2">{line}</text>}</For>
          </box>

          <box border borderColor="#1d313a" padding={1} flexDirection="column" gap={1}>
            <text>
              <strong fg="#9fd3c7">Signals</strong>
            </text>
            <For each={statusLines()}>
              {(entry) => (
                <text fg={entry.level === "warn" ? "#f8b195" : "#8fbcd4"}>{entry.message}</text>
              )}
            </For>
          </box>
        </box>

        <box
          flexGrow={1}
          border
          borderColor="#25434f"
          padding={1}
          flexDirection="column"
          backgroundColor="#141a20"
          gap={1}
        >
          {phase() === "wizard" ? (
            activeStep().kind === "summary" ? (
              <box flexDirection="column" gap={1}>
                <text fg="#8fbcd4">Ready</text>
                <text>
                  <strong fg="#f6d365">Review your configuration</strong>
                </text>
                <text fg="#aab8c2">
                  Press Enter on Save to write `sandcode.toml` and the optional `.env` file.
                </text>
                <box border borderColor="#1d313a" padding={1} flexDirection="column" gap={1}>
                  <For each={stateSnapshot(state())}>
                    {(line) => <text fg="#d7e3ea">{line}</text>}
                  </For>
                </box>
                <box flexDirection="column" gap={1}>
                  <box>
                    <For each={["Save", "Cancel"]}>
                      {(label, index) => (
                        <text
                          backgroundColor={index() === summaryActionIndex() ? "#334455" : "#1a1a1a"}
                          fg={index() === summaryActionIndex() ? "#ffff00" : "#ffffff"}
                        >
                          {" "}
                          {label}{" "}
                        </text>
                      )}
                    </For>
                  </box>
                  <text fg="#cccccc">
                    {summaryActionIndex() === 0
                      ? "Write config and finish setup."
                      : "Exit without writing files."}
                  </text>
                </box>
              </box>
            ) : (
              (() => {
                const choiceStep = activeChoiceStep();
                if (choiceStep) {
                  return (
                    <box flexDirection="column" gap={1}>
                      <text fg="#8fbcd4">{choiceStep.eyebrow}</text>
                      <text>
                        <strong fg="#f6d365">{choiceStep.title}</strong>
                      </text>
                      <text fg="#d7e3ea">{choiceStep.description}</text>
                      <text fg="#7d91a2">{choiceStep.hint}</text>
                      <box flexDirection="column" gap={1}>
                        <box>
                          <For each={choiceStep.options}>
                            {(option, index) => (
                              <text
                                backgroundColor={
                                  index() === activeChoiceIndex() ? "#334455" : "#1a1a1a"
                                }
                                fg={index() === activeChoiceIndex() ? "#ffff00" : "#ffffff"}
                              >
                                {" "}
                                {option.name}{" "}
                              </text>
                            )}
                          </For>
                        </box>
                        <text fg="#cccccc">
                          {choiceStep.options[activeChoiceIndex()]?.description ?? ""}
                        </text>
                      </box>
                    </box>
                  );
                }

                const inputStep = activeInputStep();
                if (inputStep) {
                  return (
                    <box flexDirection="column" gap={1}>
                      <text fg="#8fbcd4">{inputStep.eyebrow}</text>
                      <text>
                        <strong fg="#f6d365">{inputStep.title}</strong>
                      </text>
                      <text fg="#d7e3ea">{inputStep.description}</text>
                      <text fg="#7d91a2">{inputStep.hint}</text>
                      {inputStep.key === "sync-timeout" && state().syncTimeoutError ? (
                        <text fg="#f8b195">{state().syncTimeoutError}</text>
                      ) : null}
                      <input
                        focused
                        value={inputStep.value}
                        placeholder={inputStep.placeholder}
                        onInput={(value: string) => {
                          setState((current) => {
                            const next = { ...current };
                            inputStep.commit(next, value);
                            return next;
                          });
                        }}
                        onSubmit={(value: string) => {
                          const parsed = Number.parseInt(value.trim(), 10);
                          const shouldAdvance =
                            inputStep.key !== "sync-timeout" ||
                            (Number.isInteger(parsed) && parsed > 0);

                          setState((current) => {
                            const next = { ...current };
                            inputStep.commit(next, value);
                            return next;
                          });

                          if (shouldAdvance) {
                            setStepIndex((current) =>
                              getNextWizardStepIndex(current, steps().length),
                            );
                          }
                        }}
                      />
                    </box>
                  );
                }

                return null;
              })()
            )
          ) : phase() === "saving" ? (
            <box flexDirection="column" gap={1}>
              <text fg="#8fbcd4">Writing</text>
              <text>
                <strong fg="#f6d365">Applying configuration</strong>
              </text>
              <text fg="#d7e3ea">Running validations and writing files. Stay on this screen.</text>
            </box>
          ) : phase() === "done" ? (
            <box flexDirection="column" gap={1}>
              <text fg="#8fbcd4">Complete</text>
              <text>
                <strong fg="#9fd3c7">Sandcode is configured.</strong>
              </text>
              <text fg="#d7e3ea">Press Enter or Esc to leave setup.</text>
              {(() => {
                const savedResult = result();
                if (!savedResult) {
                  return null;
                }

                return (
                  <box border borderColor="#1d313a" padding={1} flexDirection="column" gap={1}>
                    <text fg="#d7e3ea">Config: {savedResult.configPath}</text>
                    {savedResult.envPath ? (
                      <text fg="#d7e3ea">Env: {savedResult.envPath}</text>
                    ) : null}
                  </box>
                );
              })()}
            </box>
          ) : phase() === "error" ? (
            <box flexDirection="column" gap={1}>
              <text fg="#f8b195">Validation failed</text>
              <text fg="#fbe4d8">{errorMessage()}</text>
              <text fg="#7d91a2">Press Enter or Esc to go back and edit the setup values.</text>
            </box>
          ) : null}

          <box marginTop="auto" border borderColor="#1d313a" padding={1}>
            <text fg="#7d91a2">
              Esc goes back. Ctrl+C exits setup immediately. 1-9 selects a visible choice.
            </text>
          </box>
        </box>
      </box>
    </box>
  );
}

export async function runSetupTui(
  context: SetupContext,
  initialState: SetupState,
): Promise<SetupResult> {
  const renderer = await createCliRenderer({ useMouse: false });

  return await new Promise<SetupResult>((resolve, reject) => {
    let settled = false;

    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      renderer.destroy();
      callback();
    };

    void render(
      () => (
        <SetupWizard
          context={context}
          initialState={initialState}
          complete={(result) => finalize(() => resolve(result))}
          cancel={(error) => finalize(() => reject(error))}
        />
      ),
      renderer,
    );
  });
}
