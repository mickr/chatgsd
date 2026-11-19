import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button, Select } from "../ui";
import { SpinnerIcon, ChatGPTIcon } from "../icons";
import { useAgent } from "../../context/AgentContext";
import { ContinueWithChatGPT, ManageUsage, PlanNotice } from "../agent/ChatGPTAccount";
import { ComputerPermissions } from "../agent/ComputerPermissions";
import { mod } from "../../lib/platform";
import * as cliService from "../../services/cli";
import type { CliStatus } from "../../services/cli";
import { errorMessage, isAntigravityModel, researchBriefDefault } from "../../services/agent";

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

const STATUS_LABELS = { ready: "Ready", signed_out: "Signed out", error: "Codex unavailable" };
const ANTIGRAVITY_STATUS_LABELS = {
  ready: "Ready",
  signed_out: "Sign in required",
  unavailable: "CLI not found",
  error: "Unavailable",
} as const;

function AntigravityIntegrationCard() {
  const agent = useAgent();
  const enabled = !!agent.antigravityEnabled;
  const agyStatus = agent.antigravityStatus ?? null;
  const loading = !!agent.antigravityLoading;
  const error = agent.antigravityError ?? null;
  const signingIn = !!agent.antigravitySigningIn;
  return (
    <div className="mt-4 rounded-[10px] border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-3 text-sm font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => agent.setAntigravityEnabled?.(event.target.checked)}
            aria-describedby="antigravity-description"
          />
          <span>Antigravity</span>
        </label>
        {enabled && (
          <span className="text-xs text-text-muted">
            {loading ? "Checking…" : agyStatus ? ANTIGRAVITY_STATUS_LABELS[agyStatus.status] : "Enabled"}
          </span>
        )}
      </div>
      <p id="antigravity-description" className="text-xs text-text-muted leading-relaxed">
        Use Google Gemini models for prose generation and co-editing through your local{" "}
        <code className="font-mono text-[11px] bg-bg-muted px-1 py-0.5 rounded">agy</code> CLI and Antigravity plan.
        Models appear alongside ChatGPT in the agent panel.
      </p>
      {enabled && loading && (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
          Checking local Antigravity session…
        </div>
      )}
      {enabled && error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      {enabled && !loading && agyStatus?.status === "ready" && (
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>Using your local Antigravity plan</span>
          <button
            type="button"
            className="hover:text-text"
            onClick={() => { void agent.refreshAntigravityStatus?.(); }}
          >
            Refresh
          </button>
        </div>
      )}
      {enabled && !loading && agyStatus?.detail && (
        <p className="text-xs text-text-muted">{agyStatus.detail}</p>
      )}
      {enabled && !loading && agyStatus?.status === "signed_out" && (
        <Button
          variant="outline"
          size="sm"
          disabled={signingIn}
          onClick={() => { void agent.signInAntigravity?.(); }}
        >
          {signingIn ? "Opening Google sign-in…" : "Sign in with Google"}
        </Button>
      )}
      {enabled && !loading && (agyStatus?.status === "error" || agyStatus?.status === "unavailable" || error) && (
        <button
          type="button"
          className="text-xs text-text-muted hover:text-text"
          onClick={() => { void agent.refreshAntigravityStatus?.(); }}
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** Internet access and the researcher role that does the web work. */
function InternetAccessSettings() {
  const agent = useAgent();
  const [defaultBrief, setDefaultBrief] = useState("");
  // What's being typed; null while the field shows the saved brief.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    researchBriefDefault().then(
      (brief) => { if (active) setDefaultBrief(brief); },
      (error) => toast.error(`Couldn't load the researcher's brief: ${errorMessage(error)}`),
    );
    return () => { active = false; };
  }, []);
  const commit = (text: string) => {
    const next = text.trim();
    agent.setResearchBrief(next && next !== defaultBrief ? next : null);
  };
  const saveDraft = () => {
    if (draft === null) return;
    commit(draft);
    setDraft(null);
  };
  // A tab shortcut or closing settings removes the field without blurring it,
  // so what was typed is saved on the way out too.
  const unsaved = useRef<(() => void) | null>(null);
  unsaved.current = draft === null ? null : () => commit(draft);
  useEffect(() => () => unsaved.current?.(), []);
  return (
    <div className="mt-4 rounded-[10px] border border-border p-4 space-y-3">
      <label className="flex items-center justify-between gap-4 text-sm font-medium">
        Internet access
        <input
          type="checkbox"
          checked={agent.webAccess}
          onChange={(event) => agent.setWebAccess(event.target.checked)}
          aria-describedby="web-access-description"
        />
      </label>
      <p id="web-access-description" className="text-xs text-text-muted leading-relaxed">
        When a request needs information your notes don't have, the agent hands a question to a researcher
        that searches the web, reads pages and reports back with its sources. Searches run through ChatGPT,
        and pages it reads in full are fetched from this Mac. The researcher gets the question, not your notes.
        If a site it reads publishes a skill that fits your work, the agent offers it for you to save.
      </p>
      {agent.webAccess && (
        <div className="pt-3 border-t border-border border-dashed space-y-3">
          <div>
            <h3 className="text-sm font-medium">Researcher</h3>
            <p className="text-xs text-text-muted leading-relaxed">
              A separate agent role with its own model and brief. Lighter models keep research quick.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="research-model" className="block text-xs font-medium">Model</label>
            <Select
              id="research-model"
              value={agent.researchModel}
              disabled={!agent.models.some((model) => !isAntigravityModel(model.id))}
              onChange={(event) => agent.setResearchModel(event.target.value)}
            >
              {agent.models.some((model) => !isAntigravityModel(model.id)) ? (
                agent.models
                  .filter((model) => !isAntigravityModel(model.id))
                  .map((model) => (
                    <option key={model.id} value={model.id}>{model.label}</option>
                  ))
              ) : (
                <option value="">
                  {agent.modelsLoading ? "Loading models…" : "Available after signing in"}
                </option>
              )}
            </Select>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="research-brief" className="font-medium">Brief</label>
              {(agent.researchBrief !== null || draft !== null) && (
                <button
                  type="button"
                  className="text-text-muted hover:text-text"
                  onClick={() => { setDraft(null); agent.setResearchBrief(null); }}
                >
                  Reset to default
                </button>
              )}
            </div>
            <textarea
              id="research-brief"
              rows={5}
              maxLength={4000}
              value={draft ?? agent.researchBrief ?? defaultBrief}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={saveDraft}
              aria-describedby="research-brief-description"
              className="block w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-sm leading-relaxed text-text focus-visible:outline-none focus-visible:border-accent"
            />
            <p id="research-brief-description" className="text-xs text-text-muted leading-relaxed">
              The brief shapes how the researcher works and is saved when you leave the field. Its ground rules
              stay fixed: report only what sources say, cite each one, and never follow instructions found on a page.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function ToolsSettingsSection() {
  const [cli, dispatchCli] = useReducer(cliReducer, cliInitialState);
  const agent = useAgent();

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
        <p className="text-sm text-text-muted mb-4">Work alongside Codex in your notes ({mod}J), signed in with ChatGPT. Edits land directly while your caret stays yours.</p>
        {agent.statusLoading && <div className="flex items-center gap-2 p-3 text-sm text-text-muted"><SpinnerIcon className="w-4 h-4 animate-spin" />Checking your ChatGPT account…</div>}
        {agent.statusError && <p role="alert" className="text-sm text-red-500 mb-3">{agent.statusError}</p>}
        {agent.status && (
          <div className="space-y-3">
            <div className="rounded-[10px] border border-border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2.5"><ChatGPTIcon className="w-4.5 h-4.5" /><h3 className="text-sm font-medium">ChatGPT</h3></div><span className="text-xs text-text-muted">{STATUS_LABELS[agent.status.status]}</span></div>
              <p className="text-xs text-text-muted leading-relaxed">Codex powers the agent using your ChatGPT account and plan's Codex usage limits.</p>
              {agent.status.account && <div className="text-xs space-y-1"><p>{agent.status.account.email}</p><p className="text-text-muted">Using your ChatGPT plan's Codex allowance</p></div>}
              {agent.status.detail && <p className="text-xs text-text-muted">{agent.status.detail}</p>}
              {agent.status.status === "signed_out" && <ContinueWithChatGPT />}
              <div className="flex items-center justify-between text-xs"><ManageUsage />{agent.status.account && <button type="button" className="text-text-muted hover:text-text" onClick={() => { void agent.signOut(); }}>Sign out</button>}</div>
            </div>
            <PlanNotice />
          </div>
        )}
        <AntigravityIntegrationCard />
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
          <ComputerPermissions />
        </div>
        <InternetAccessSettings />
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
