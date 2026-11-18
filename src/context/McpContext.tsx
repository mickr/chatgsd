import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as mcp from "../services/mcp";
import { errorMessage } from "../services/agent";

export interface McpContextValue {
  /** The user's MCP servers; null until the first load finishes. */
  servers: mcp.McpServer[] | null;
  error: string | null;
  refresh: () => Promise<void>;
}

const McpContext = createContext<McpContextValue | null>(null);

/**
 * The user's MCP servers and their live connection state, shared by the
 * settings page and the agent panel. The backend announces every change, so
 * a sign-in finishing in the browser or a tool the agent was allowed to use
 * shows in both without either asking.
 */
export function McpProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<mcp.McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setServers(await mcp.listServers());
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // Listen before loading, so a change during the load isn't lost.
    void mcp
      .onServersChanged((next) => {
        setServers(next);
        setError(null);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {})
      .then(() => {
        if (!disposed) void refresh();
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);
  const value = useMemo(() => ({ servers, error, refresh }), [servers, error, refresh]);
  return <McpContext.Provider value={value}>{children}</McpContext.Provider>;
}

export function useMcp() {
  const value = useContext(McpContext);
  if (!value) throw new Error("useMcp requires McpProvider");
  return value;
}
