import { Fragment, memo } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { useMcp } from "../../context/McpContext";
import { errorMessage } from "../../services/agent";
import * as mcp from "../../services/mcp";
import { CheckIcon, ServerIcon } from "../icons";
import { McpServerStatus } from "./McpServerStatus";

const report = (action: Promise<void>, failure: string) =>
  void action.catch((reason) => toast.error(`${failure}: ${errorMessage(reason)}`));

/**
 * The MCP servers the agent can use alongside the open note: which are on,
 * whether each is reachable, and the quick fixes (sign in, reconnect) without
 * leaving the note. Adding and editing servers happens in settings.
 */
export const McpServices = memo(function McpServices({ onManage }: { onManage?: () => void }) {
  const { servers } = useMcp();
  if (!servers) return null;
  if (!servers.length)
    return onManage ? (
      <div className="agent-panel-services">
        <ServerIcon className="w-3.5 h-3.5 shrink-0" />
        <button type="button" className="agent-panel-link agent-panel-link-quiet" onClick={onManage}>
          Connect a service
        </button>
      </div>
    ) : null;
  const on = servers.filter((server) => server.enabled);
  const attention = on.filter((server) => server.status === "needs_auth" || server.status === "error").length;
  const summary = on.length ? on.map((server) => server.name).join(", ") : "Services off";
  return (
    <div className="agent-panel-services">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="agent-panel-services-trigger"
            aria-label={`Services the agent can use: ${on.length ? summary : "none on"}${attention ? `. ${attention} need attention` : ""}`}
          >
            <ServerIcon className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{summary}</span>
            {attention > 0 && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="agent-panel-history" sideOffset={5} align="start">
            <DropdownMenu.Label className="agent-panel-history-label">
              Services the agent can use with this note
            </DropdownMenu.Label>
            {servers.map((server) => (
              <Fragment key={server.id}>
                <DropdownMenu.CheckboxItem
                  className="agent-panel-history-item"
                  checked={server.enabled}
                  // Keep the menu open: turning a server on shows its connection settle.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    report(mcp.setServerEnabled(server.id, checked), `Couldn't change ${server.name}`)
                  }
                >
                  <CheckIcon className="agent-panel-history-check w-3.5 h-3.5" />
                  <span className="min-w-0 flex-1 truncate">{server.name}</span>
                  <McpServerStatus server={server} />
                </DropdownMenu.CheckboxItem>
                {server.enabled && server.status === "needs_auth" && (
                  <DropdownMenu.Item
                    className="agent-panel-history-item agent-panel-services-action"
                    onSelect={() => report(mcp.authorizeServer(server.id), `Couldn't sign in to ${server.name}`)}
                  >
                    Sign in to {server.name}…
                  </DropdownMenu.Item>
                )}
                {server.enabled && server.status === "authorizing" && (
                  <DropdownMenu.Item
                    className="agent-panel-history-item agent-panel-services-action"
                    onSelect={() => void mcp.cancelAuthorize(server.id)}
                  >
                    Cancel sign-in
                  </DropdownMenu.Item>
                )}
                {server.enabled && server.status === "error" && (
                  <DropdownMenu.Item
                    className="agent-panel-history-item agent-panel-services-action"
                    title={server.detail ?? undefined}
                    onSelect={(event) => {
                      event.preventDefault();
                      report(mcp.connectServer(server.id), `Couldn't reconnect ${server.name}`);
                    }}
                  >
                    Reconnect {server.name}
                  </DropdownMenu.Item>
                )}
              </Fragment>
            ))}
            {onManage && (
              <>
                <DropdownMenu.Separator className="agent-panel-services-separator" />
                <DropdownMenu.Item className="agent-panel-history-item" onSelect={onManage}>
                  Manage MCP servers…
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
});
