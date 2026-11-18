import { memo, useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Select,
} from "../ui";
import { ServerIcon, SpinnerIcon } from "../icons";
import { useMcp } from "../../context/McpContext";
import { McpServerStatus } from "../agent/McpServerStatus";
import { errorMessage } from "../../services/agent";
import * as mcp from "../../services/mcp";
import type { McpConfig, McpFoundServer, McpServer, McpTool, McpToolPolicy } from "../../services/mcp";

interface Draft {
  url: string;
  name: string;
  token: string;
  clientId: string;
}
const emptyDraft: Draft = { url: "", name: "", token: "", clientId: "" };

/** Opens the browser sign-in; the row shows progress, so only failure is announced. */
function signIn(server: Pick<McpServer, "id" | "name">) {
  void mcp
    .authorizeServer(server.id)
    .catch((reason) => toast.error(`Couldn't sign in to ${server.name}: ${errorMessage(reason)}`));
}

/** Says how a newly added server's first connection went, and opens its sign-in if it asked for one. */
function announceAdded(server: McpServer) {
  if (server.status === "needs_auth" && server.auth === "none") {
    toast(`Finish signing in to ${server.name} in your browser.`);
    signIn(server);
  } else if (server.status === "error") {
    toast.error(`Added ${server.name}, but couldn't connect: ${server.detail ?? "unknown error"}`);
  } else if (server.status === "connected") {
    toast.success(`Connected to ${server.name}.`);
  }
}

function showConfig() {
  void mcp.revealConfig().catch((reason) => toast.error(errorMessage(reason)));
}

const fieldLabel = "block text-xs font-medium";
const fieldHint = "text-xs text-text-muted leading-relaxed";
const quietLink = "text-xs text-text-muted hover:text-text";

/** The optional fields: a name, a pasted token, and a hand-made OAuth client. */
function OptionalFields({
  idPrefix,
  draft,
  onChange,
  redirectUri,
  savedToken,
}: {
  idPrefix: string;
  draft: Draft;
  onChange: (change: Partial<Draft>) => void;
  redirectUri: string;
  savedToken: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-name`} className={fieldLabel}>Name</label>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          maxLength={60}
          placeholder="Uses the server's own name"
          onChange={(event) => onChange({ name: event.target.value })}
          className="h-8.25"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-token`} className={fieldLabel}>Access token</label>
        <Input
          id={`${idPrefix}-token`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.token}
          placeholder={savedToken ? "Saved. Type a new one to replace it." : "Only for servers that give you a token instead of a sign-in"}
          onChange={(event) => onChange({ token: event.target.value })}
          aria-describedby={`${idPrefix}-token-hint`}
          className="h-8.25"
        />
        <p id={`${idPrefix}-token-hint`} className={fieldHint}>
          Sent to this server as a bearer token and kept on this Mac. Leave it empty to sign in through your browser.
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-client`} className={fieldLabel}>OAuth client ID</label>
        <Input
          id={`${idPrefix}-client`}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft.clientId}
          placeholder="Usually not needed"
          onChange={(event) => onChange({ clientId: event.target.value })}
          aria-describedby={`${idPrefix}-client-hint`}
          className="h-8.25"
        />
        <p id={`${idPrefix}-client-hint`} className={fieldHint}>
          ChatGSD registers itself with most services. If one asks you to create an app first, enter its client ID
          here and give the service this redirect address:{" "}
          <code className="font-mono bg-bg-muted px-1 py-0.5 rounded select-all">{redirectUri}</code>
        </p>
      </div>
    </div>
  );
}

const POLICY_LABELS: Record<McpToolPolicy, string> = {
  allow: "Allow",
  ask: "Ask first",
  off: "Off",
};

const ToolRow = memo(function ToolRow({ serverId, serverName, tool }: { serverId: string; serverName: string; tool: McpTool }) {
  const descriptionId = `mcp-${serverId}-${tool.name}`;
  return (
    <li className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <p className="flex items-center gap-2 text-xs">
          <span className="font-mono font-medium truncate">{tool.name}</span>
          {tool.readOnly && <span className="shrink-0 text-[10px] text-text-muted">Read-only</span>}
        </p>
        <p id={descriptionId} className={`text-xs leading-relaxed line-clamp-2 ${tool.policy === "off" ? "text-text-muted/60" : "text-text-muted"}`} title={tool.description}>
          {tool.description || tool.title || "No description"}
        </p>
      </div>
      <div className="w-27 shrink-0">
        <Select
          aria-label={`When the agent wants to use ${tool.name} on ${serverName}`}
          aria-describedby={descriptionId}
          value={tool.policy}
          className="h-7.5 py-0 text-xs"
          onChange={(event) => {
            void mcp
              .setToolPolicy(serverId, tool.name, event.target.value as McpToolPolicy)
              .catch((reason) => toast.error(`Couldn't change ${tool.name}: ${errorMessage(reason)}`));
          }}
        >
          {(Object.keys(POLICY_LABELS) as McpToolPolicy[]).map((policy) => (
            <option key={policy} value={policy}>{POLICY_LABELS[policy]}</option>
          ))}
        </Select>
      </div>
    </li>
  );
});

function EditServer({ server, redirectUri, onDone }: { server: McpServer; redirectUri: string; onDone: () => void }) {
  const [draft, setDraft] = useState<Draft>({ url: server.url, name: server.name, token: "", clientId: server.clientId ?? "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent, removeToken = false) => {
    event.preventDefault();
    if (saving || !draft.url.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await mcp.updateServer(server.id, {
        url: draft.url,
        name: draft.name,
        // An empty field keeps the saved token; only Remove clears it.
        token: removeToken ? "" : draft.token.trim() || undefined,
        clientId: draft.clientId,
      });
      onDone();
    } catch (reason) {
      setError(errorMessage(reason));
      setSaving(false);
    }
  };
  const id = `mcp-edit-${server.id}`;
  return (
    <form className="space-y-3 border-t border-border border-dashed pt-3" onSubmit={(event) => void save(event)} aria-label={`Edit ${server.name}`}>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-url`} className={fieldLabel}>Address</label>
        <Input
          id={`${id}-url`}
          inputMode="url"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft.url}
          onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
          aria-describedby={`${id}-url-hint`}
          className="h-8.25"
        />
        <p id={`${id}-url-hint`} className={fieldHint}>Changing the address signs you out of the old one.</p>
      </div>
      <OptionalFields
        idPrefix={id}
        draft={draft}
        onChange={(change) => setDraft((current) => ({ ...current, ...change }))}
        redirectUri={redirectUri}
        savedToken={server.auth === "token"}
      />
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="outline" size="md" disabled={saving || !draft.url.trim()}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="md" disabled={saving} onClick={onDone}>Cancel</Button>
        {server.auth === "token" && (
          <button type="button" className="ml-auto text-xs text-text-muted hover:text-text" disabled={saving} onClick={(event) => void save(event, true)}>
            Remove saved token
          </button>
        )}
      </div>
    </form>
  );
}

const rowAction = "hover:text-text disabled:opacity-50 disabled:hover:text-text-muted";

const ServerRow = memo(function ServerRow({
  server,
  redirectUri,
  onRemove,
}: {
  server: McpServer;
  redirectUri: string;
  onRemove: (server: McpServer) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const run = (action: Promise<void>, failure: string) => {
    setWorking(true);
    void action
      .catch((reason) => toast.error(`${failure}: ${errorMessage(reason)}`))
      .finally(() => setWorking(false));
  };
  const busy = working || server.status === "connecting";
  const asking = server.tools.filter((tool) => tool.policy === "ask").length;
  const off = server.tools.filter((tool) => tool.policy === "off").length;
  return (
    <li className="rounded-[10px] border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-medium truncate">{server.name}</h3>
            <McpServerStatus server={server} />
          </div>
          {server.transport === "stdio" ? (
            <p className="font-mono text-xs text-text-muted truncate" title={server.command ?? undefined}>
              {server.command}
              <span className="font-sans">{server.command ? " · " : ""}runs on this Mac</span>
            </p>
          ) : (
            <p className="font-mono text-xs text-text-muted truncate" title={server.url}>
              {server.url}
              {server.local && <span className="font-sans"> · on this network</span>}
            </p>
          )}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
          {server.enabled ? "On" : "Off"}
          <input
            type="checkbox"
            checked={server.enabled}
            aria-label={`Let the agent use ${server.name}`}
            onChange={(event) => run(mcp.setServerEnabled(server.id, event.target.checked), `Couldn't change ${server.name}`)}
          />
        </label>
      </div>
      {server.enabled && server.detail && (
        <p role="alert" className={`text-xs leading-relaxed ${server.status === "error" ? "text-red-500" : "text-text-muted"}`}>
          {server.detail}
        </p>
      )}
      {server.enabled && server.status === "needs_auth" && !server.detail && (
        <p className="text-xs text-text-muted leading-relaxed">
          {server.auth === "token"
            ? "The server didn't accept the saved access token. Replace it under Edit, or sign in instead."
            : "Sign in to let the agent use this server. Your browser opens to the service's own sign-in page."}
        </p>
      )}
      {server.enabled && (server.status === "needs_auth" || server.status === "authorizing") && (
        <div className="flex items-center gap-3">
          {server.status === "authorizing" ? (
            <>
              <span className="flex items-center gap-2 text-xs text-text-muted">
                <SpinnerIcon className="w-3.25 h-3.25 animate-spin" />
                Finish signing in in your browser
              </span>
              <Button variant="ghost" size="sm" onClick={() => void mcp.cancelAuthorize(server.id)}>Cancel</Button>
            </>
          ) : (
            <Button variant="outline" size="md" onClick={() => signIn(server)}>Sign in</Button>
          )}
        </div>
      )}
      {server.tools.length > 0 && (
        <details className="group border-t border-border border-dashed pt-3">
          <summary className="cursor-pointer text-xs text-text-muted hover:text-text select-none">
            {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
            {asking > 0 && ` · ${asking} ask first`}
            {off > 0 && ` · ${off} off`}
          </summary>
          <p className={`${fieldHint} mt-2`}>
            Tools the server marks read-only run without asking. Anything else shows you the call first, until you choose otherwise here.
          </p>
          <ul className="mt-1 divide-y divide-border divide-dashed">
            {server.tools.map((tool) => (
              <ToolRow key={tool.name} serverId={server.id} serverName={server.name} tool={tool} />
            ))}
          </ul>
        </details>
      )}
      {editing ? (
        <EditServer server={server} redirectUri={redirectUri} onDone={() => setEditing(false)} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
          <button
            type="button"
            className={rowAction}
            disabled={busy || !server.enabled}
            onClick={() => run(mcp.connectServer(server.id), `Couldn't reconnect ${server.name}`)}
          >
            {server.status === "connecting" ? "Connecting…" : "Reconnect"}
          </button>
          {server.auth === "oauth" && (
            <>
              <button type="button" className={rowAction} disabled={busy || !server.enabled || server.status === "authorizing"} onClick={() => signIn(server)}>
                Sign in again
              </button>
              <button type="button" className={rowAction} disabled={busy} onClick={() => run(mcp.signOutServer(server.id), `Couldn't sign out of ${server.name}`)}>
                Sign out
              </button>
            </>
          )}
          {server.transport === "stdio" ? (
            <button type="button" className={rowAction} onClick={showConfig}>Edit in mcp.json</button>
          ) : (
            <button type="button" className={rowAction} onClick={() => setEditing(true)}>Edit</button>
          )}
          <button type="button" className={`${rowAction} ml-auto`} onClick={() => onRemove(server)}>Remove</button>
        </div>
      )}
    </li>
  );
});

const emptyLocalDraft = { name: "", command: "", env: "" };

/** Add a server that is a program on this Mac. It is written to `mcp.json`, which defines it from then on. */
function AddLocalServer({ onAdded }: { onAdded: () => void }) {
  const [draft, setDraft] = useState(emptyLocalDraft);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = draft.name.trim() !== "" && draft.command.trim() !== "";
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (adding || !ready) return;
    setAdding(true);
    setError(null);
    try {
      const server = await mcp.addLocalServer({ name: draft.name, command: draft.command, env: draft.env.trim() || undefined });
      setDraft(emptyLocalDraft);
      announceAdded(server);
      onAdded();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAdding(false);
    }
  };
  const change = (field: keyof typeof emptyLocalDraft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));
  return (
    <form className="rounded-[10px] border border-border p-4 space-y-3" aria-labelledby="mcp-local-title" onSubmit={(event) => void add(event)}>
      <div className="space-y-1">
        <h3 id="mcp-local-title" className="text-sm font-medium">A server that runs on this Mac</h3>
        <p className={fieldHint}>
          For a server you start with a command instead of reaching at an address. ChatGSD runs the command as you
          while the server is on. It is saved in <code className="font-mono bg-bg-muted px-1 py-0.5 rounded">mcp.json</code>,
          in the format other MCP apps use, and changes you make to that file yourself are picked up when you come
          back here.{" "}
          <button type="button" className="underline hover:text-text" onClick={showConfig}>Show mcp.json</button>
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="mcp-local-name" className={fieldLabel}>Name</label>
        <Input
          id="mcp-local-name"
          value={draft.name}
          maxLength={60}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="files"
          onChange={change("name")}
          className="h-8.25"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="mcp-local-command" className={fieldLabel}>Command</label>
        <Input
          id="mcp-local-command"
          value={draft.command}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents"
          onChange={change("command")}
          className="h-8.25 font-mono"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="mcp-local-env" className={fieldLabel}>Environment variables</label>
        <textarea
          id="mcp-local-env"
          rows={2}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={draft.env}
          placeholder="API_KEY=…"
          onChange={change("env")}
          aria-describedby="mcp-local-env-hint"
          className="block w-full resize-y rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus-visible:outline-none focus-visible:border-accent"
        />
        <p id="mcp-local-env-hint" className={fieldHint}>
          Optional, one NAME=value per line. They are given to this server only and kept in mcp.json on this Mac.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <Button type="submit" variant="outline" size="md" disabled={adding || !ready}>
        {adding ? (
          <>
            <SpinnerIcon className="w-3.25 h-3.25 mr-2 animate-spin" />
            Starting…
          </>
        ) : (
          "Add local server"
        )}
      </Button>
    </form>
  );
}

/** Add a server from its address alone; the rest is read from the server. */
function AddServer({ redirectUri, onAdded }: { redirectUri: string; onAdded: () => void }) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [options, setOptions] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (adding || !draft.url.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const server = await mcp.addServer({
        url: draft.url,
        name: draft.name.trim() || undefined,
        token: draft.token.trim() || undefined,
        clientId: draft.clientId.trim() || undefined,
      });
      setDraft(emptyDraft);
      setOptions(false);
      announceAdded(server);
      onAdded();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAdding(false);
    }
  };
  return (
    <div className="space-y-3">
      <form className="space-y-3" onSubmit={(event) => void add(event)}>
        <div className="flex gap-2">
          <Input
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Address of an MCP server"
            placeholder="mcp.example.com/mcp"
            value={draft.url}
            onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
            className="h-8.25"
          />
          <Button type="submit" variant="outline" size="md" disabled={adding || !draft.url.trim()}>
            {adding ? (
              <>
                <SpinnerIcon className="w-3.25 h-3.25 mr-2 animate-spin" />
                Connecting…
              </>
            ) : (
              "Add server"
            )}
          </Button>
        </div>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <button type="button" className={quietLink} aria-expanded={options} onClick={() => setOptions((open) => !open)}>
          {options ? "Hide options" : "More options"}
        </button>
        {options && (
          <div className="rounded-[10px] border border-border p-4">
            <OptionalFields
              idPrefix="mcp-add"
              draft={draft}
              onChange={(change) => setDraft((current) => ({ ...current, ...change }))}
              redirectUri={redirectUri}
              savedToken={false}
            />
          </div>
        )}
      </form>
      {options && <AddLocalServer onAdded={onAdded} />}
    </div>
  );
}

const FoundRow = memo(function FoundRow({ found, onAdded }: { found: McpFoundServer; onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const add = () => {
    setAdding(true);
    void mcp
      .addFoundServer(found.name)
      .then(announceAdded, (reason) => toast.error(`Couldn't add ${found.name}: ${errorMessage(reason)}`))
      .finally(() => {
        setAdding(false);
        onAdded();
      });
  };
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium truncate">{found.name}</p>
        <p className="font-mono text-xs text-text-muted truncate" title={found.detail}>{found.detail}</p>
      </div>
      <Button variant="outline" size="sm" disabled={adding} aria-label={`Add ${found.name} from Codex`} onClick={add}>
        {adding ? "Adding…" : "Add"}
      </Button>
    </li>
  );
});

export function McpSettingsSection() {
  const { servers, error, refresh } = useMcp();
  const [removing, setRemoving] = useState<McpServer | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const [config, setConfig] = useState<McpConfig | null>(null);
  const loadConfig = useCallback(() => {
    void mcp.loadConfig().then(setConfig, () => {});
  }, []);
  // mcp.json may have been edited elsewhere: follow it on opening and on coming back.
  useEffect(() => {
    loadConfig();
    window.addEventListener("focus", loadConfig);
    return () => window.removeEventListener("focus", loadConfig);
  }, [loadConfig]);
  useEffect(() => {
    let active = true;
    void mcp.redirectUri().then(
      (uri) => { if (active) setRedirectUri(uri); },
      () => {},
    );
    return () => { active = false; };
  }, []);
  const confirmRemove = () => {
    if (!removing) return;
    const { id, name } = removing;
    setRemoving(null);
    void mcp
      .removeServer(id)
      .then(loadConfig, (reason) => toast.error(`Couldn't remove ${name}: ${errorMessage(reason)}`));
  };
  const on = servers?.filter((server) => server.enabled).length ?? 0;
  return (
    <div className="space-y-8 py-8">
      <section className="pb-2">
        <h2 className="text-xl font-medium mb-0.5">MCP Servers</h2>
        <p className="text-sm text-text-muted mb-4">
          Connect the agent to services you use, like an issue tracker, a calendar or a document store, through
          their MCP servers. It can then look things up there while it reads the note you're working on.
          Servers apply in every notes folder.
        </p>
        {error && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-red-500/20 bg-red-500/10 p-3">
            <p role="alert" className="text-sm text-red-500">{error}</p>
            <button type="button" className="shrink-0 text-xs text-text-muted hover:text-text" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        {config?.problem && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border bg-bg-muted p-3">
            <p role="status" className="text-sm text-text-muted">{config.problem}</p>
            <button type="button" className={`shrink-0 ${quietLink}`} onClick={showConfig}>Show mcp.json</button>
          </div>
        )}
        {servers === null && !error && (
          <div className="flex items-center gap-2 p-3 text-sm text-text-muted">
            <SpinnerIcon className="w-4 h-4 animate-spin" />
            Loading your servers…
          </div>
        )}
        {servers?.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border border-dashed px-6 py-8 text-center">
            <ServerIcon className="w-6 h-6 text-text-muted/50" />
            <h3 className="text-sm font-medium">No servers yet</h3>
            <p className="max-w-md text-sm leading-relaxed text-text-muted">
              Add a server by its address below. ChatGSD reads its name and tools from it and, if it asks,
              opens your browser to sign in. A server that runs on this Mac is under More options.
            </p>
          </div>
        )}
        {servers && servers.length > 0 && (
          <>
            <p className="mb-2.5 text-xs text-text-muted" role="status">
              {servers.length} added · {on} on
            </p>
            <ul className="space-y-2.5">
              {servers.map((server) => (
                <ServerRow key={server.id} server={server} redirectUri={redirectUri} onRemove={setRemoving} />
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="border-t border-border border-dashed" />

      <section className="pb-2">
        <h2 className="text-xl font-medium mb-0.5">Add a server</h2>
        <p className="text-sm text-text-muted mb-4">
          Paste the address of a remote MCP server, or open More options for one that runs on this Mac. What the
          agent sends to a remote server leaves this Mac, and what any server sends back is treated as
          information, never as instructions.
        </p>
        <AddServer redirectUri={redirectUri} onAdded={loadConfig} />
        {config && config.found.length > 0 && (
          <div className="mt-6 space-y-2.5">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Already set up in Codex</h3>
              <p className={fieldHint}>
                Servers from Codex's configuration on this Mac. Nothing here is used until you add it; a server
                that runs on this Mac is copied into mcp.json with its variables.
              </p>
            </div>
            <ul className="divide-y divide-border divide-dashed rounded-[10px] border border-border">
              {config.found.map((found) => (
                <FoundRow key={found.name} found={found} onAdded={loadConfig} />
              ))}
            </ul>
          </div>
        )}
      </section>

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this server?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.transport === "stdio"
                ? `ChatGSD stops ${removing.name}, takes it out of mcp.json and forgets your choices for its tools.`
                : `The agent will stop using ${removing?.name}, and ChatGSD forgets its sign-in and your choices for its tools. Access you granted stays listed in your account with that service until you revoke it there.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
