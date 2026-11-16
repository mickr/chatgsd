import { useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "../ui";
import { SpinnerIcon, ChatGPTIcon } from "../icons";
import { useAgent } from "../../context/AgentContext";
import { ContinueWithChatGPT, ManageUsage, PlanNotice } from "../agent/ChatGPTAccount";
import { mod } from "../../lib/platform";
import * as cliService from "../../services/cli";
import type { CliStatus } from "../../services/cli";
import { errorMessage, setupComputerPermissions } from "../../services/agent";

type CliState = {
  status: CliStatus | null;
  loaded: boolean;
  error: boolean;
  operating: boolean;
};

type CliAction =
  | { type: "loaded"; status: CliStatus }
  | { type: "error" }
  | { type: "operating" }
  | { type: "operated"; status: CliStatus }
  | { type: "operate_failed" };

const cliInitialState: CliState = {
  status: null,
  loaded: false,
  error: false,
  operating: false,
};

function cliReducer(state: CliState, action: CliAction): CliState {
  switch (action.type) {
    case "loaded":
      return { ...state, status: action.status, loaded: true, error: false };
    case "error":
      return { ...state, error: true };
    case "operating":
      return { ...state, operating: true };
    case "operated":
      return { ...state, status: action.status, operating: false };
    case "operate_failed":
      return { ...state, operating: false };
  }
}

function CliUsageHint() {
  return (
    <p className="text-sm text-text-muted font-mono">
      scratch file.md # open note
      <br />
      scratch . # open folder
      <br />
      scratch # launch app
    </p>
  );
}

const STATUS_LABELS = { ready: "Ready", signed_out: "Signed out", plan_usage_disabled: "Plan usage disabled" };

export function ToolsSettingsSection() {
  const [cli, dispatchCli] = useReducer(cliReducer, cliInitialState);
  const agent = useAgent();
  const [computerSetup, setComputerSetup] = useState<string | null>(null);

  useEffect(() => {
    cliService
      .getCliStatus()
      .then((status) => dispatchCli({ type: "loaded", status }))
      .catch((err) => {
        console.error("Failed to get CLI status:", err);
        dispatchCli({ type: "error" });
      });
  }, []);

  useEffect(() => { void agent.refreshStatus(); }, [agent.refreshStatus]);

  const handleInstallCli = async () => {
    dispatchCli({ type: "operating" });
    try {
      await cliService.installCli();
      const status = await cliService.getCliStatus();
      dispatchCli({ type: "operated", status });
      toast.success(
        "CLI tool installed. Open a new terminal to use `scratch`.",
      );
    } catch (err) {
      dispatchCli({ type: "operate_failed" });
      toast.error(
        err instanceof Error ? err.message : "Failed to install CLI tool",
      );
    }
  };

  const handleUninstallCli = async () => {
    dispatchCli({ type: "operating" });
    try {
      await cliService.uninstallCli();
      const status = await cliService.getCliStatus();
      dispatchCli({ type: "operated", status });
      toast.success("CLI tool uninstalled.");
    } catch (err) {
      dispatchCli({ type: "operate_failed" });
      toast.error(
        err instanceof Error ? err.message : "Failed to uninstall CLI tool",
      );
    }
  };

  return (
    <div className="space-y-8 py-8">
      <section className="pb-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-medium mb-0.5">Agent</h2>
          <button type="button" className="text-xs text-text-muted hover:text-text" disabled={agent.statusLoading} onClick={() => { void agent.refreshStatus(); }}>Refresh</button>
        </div>
        <p className="text-sm text-text-muted mb-4">Work alongside ChatGPT in your notes ({mod}J). Edits land directly while your caret stays yours.</p>
        {agent.statusLoading && <div className="flex items-center gap-2 p-3 text-sm text-text-muted"><SpinnerIcon className="w-4 h-4 animate-spin" />Checking your ChatGPT account…</div>}
        {agent.statusError && <p role="alert" className="text-sm text-red-500 mb-3">{agent.statusError}</p>}
        {agent.status && (
          <div className="space-y-3">
            <div className="rounded-[10px] border border-border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2.5"><ChatGPTIcon className="w-4.5 h-4.5" /><h3 className="text-sm font-medium">ChatGPT</h3></div><span className="text-xs text-text-muted">{STATUS_LABELS[agent.status.status]}</span></div>
              <p className="text-xs text-text-muted leading-relaxed">Use your ChatGPT plan or credits balance for eligible requests in Scratch.</p>
              {agent.status.account && <div className="text-xs space-y-1"><p>{agent.status.account.email}</p><p className="text-text-muted">{agent.status.account.planUsage ? "Using ChatGPT plan" : "ChatGPT plan usage is disabled"}</p></div>}
              {agent.status.detail && <p className="text-xs text-text-muted">{agent.status.detail}</p>}
              {(agent.status.status !== "ready" || !agent.status.account?.planUsage) && <ContinueWithChatGPT />}
              <div className="flex items-center justify-between text-xs"><ManageUsage />{agent.status.account && <button type="button" className="text-text-muted hover:text-text" onClick={() => { void agent.signOut(); }}>Sign out</button>}</div>
            </div>
            <PlanNotice />
          </div>
        )}
        <div className="mt-4 rounded-[10px] border border-border p-4 space-y-3">
          <label className="flex items-center justify-between gap-4 text-sm font-medium">
            Computer access
            <input
              type="checkbox"
              checked={agent.computerAccess}
              onChange={(event) => agent.setComputerAccess(event.target.checked)}
              aria-describedby="computer-access-description"
            />
          </label>
          <p id="computer-access-description" className="text-xs text-text-muted leading-relaxed">
            Cua can read and interact with other apps, including your signed-in browser, in the background.
            Captured content is sent to ChatGPT. Turning this off pauses the current session.
            Actions already taken in other apps are not undone.
          </p>
          <p className="text-xs text-text-muted leading-relaxed">
            During active coediting, a pause in your typing can start a check-in using your ChatGPT plan.
            Pause in the agent panel stops check-ins and computer access.
          </p>
          <Button
            variant="outline"
            size="md"
            onClick={() => {
              void setupComputerPermissions().then(
                setComputerSetup,
                (error) => setComputerSetup(errorMessage(error)),
              );
            }}
          >
            Set up Cua permissions
          </Button>
          {computerSetup && <p role="status" className="text-xs text-text-muted">{computerSetup}</p>}
        </div>
      </section>

      {/* CLI Tool (macOS only) */}
      {(cli.loaded && cli.status?.supported) || cli.error ? (
        <>
          <div className="border-t border-border border-dashed" />

          <section className="pb-2">
            <h2 className="text-xl font-medium mb-0.5">CLI Tool</h2>
            <p className="text-sm text-text-muted mb-4">
              Open notes from the terminal with the{" "}
              <code className="font-mono text-xs bg-bg-muted px-1.5 py-0.5 rounded">
                scratch
              </code>{" "}
              command
            </p>

            {cli.error ? (
              <div className="bg-red-500/10 border border-red-500/20 rounded-md p-3">
                <p className="text-sm text-red-500">
                  Failed to check CLI status. Please restart the app.
                </p>
              </div>
            ) : cli.status === null ? (
              <div className="rounded-[10px] border border-border p-4 flex items-center justify-center">
                <SpinnerIcon className="w-4.5 h-4.5 stroke-[1.5] animate-spin text-text-muted" />
              </div>
            ) : cli.status.installed ? (
              <>
                <div className="rounded-[10px] border border-border p-4 space-y-3 mb-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-text font-medium">
                      Status
                    </span>
                    <span className="text-sm text-text-muted">Installed</span>
                  </div>
                  {cli.status.path && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text font-medium">
                        Path
                      </span>
                      <button
                        type="button"
                        className="text-xs font-mono text-text-muted bg-bg-muted px-2 py-0.5 rounded max-w-48 truncate cursor-pointer hover:bg-bg-hover transition-colors"
                        title="Click to copy path"
                        onClick={async () => {
                          try {
                            await invoke("copy_to_clipboard", { text: cli.status!.path! });
                            toast.success("Path copied to clipboard");
                          } catch {
                            toast.error("Failed to copy path");
                          }
                        }}
                      >
                        {cli.status.path}
                      </button>
                    </div>
                  )}
                  <div className="pt-3 border-t border-border border-dashed">
                    <CliUsageHint />
                  </div>
                </div>
                <Button
                  onClick={handleUninstallCli}
                  disabled={cli.operating}
                  variant="outline"
                  size="md"
                >
                  {cli.operating ? (
                    <>
                      <SpinnerIcon className="w-3.25 h-3.25 mr-2 animate-spin" />
                      Uninstalling...
                    </>
                  ) : (
                    "Uninstall CLI Tool"
                  )}
                </Button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2.5 p-2.5 rounded-[10px] border border-border bg-bg-secondary mb-2.5">
                  <CliUsageHint />
                </div>
                <Button
                  onClick={handleInstallCli}
                  disabled={cli.operating}
                  variant="outline"
                  size="md"
                >
                  {cli.operating ? (
                    <>
                      <SpinnerIcon className="w-3.25 h-3.25 mr-2 animate-spin" />
                      Installing...
                    </>
                  ) : (
                    "Install CLI Tool"
                  )}
                </Button>
              </>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
