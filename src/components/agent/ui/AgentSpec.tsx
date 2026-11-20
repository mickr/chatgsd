import { Component, useMemo, type ReactNode } from "react";
import type { Spec, StateStore } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { registry } from "./registry";
import { SpecRendererContext } from "./writingOfferContext";

class SpecBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <p className="text-xs text-text-muted">
          This view couldn't be displayed.
        </p>
      );
    return this.props.children;
  }
}

/**
 * Render an agent-generated spec with Scratch's registry. A generated view must
 * never take the panel down, so rendering failures stay inside this block.
 */
export function AgentSpec({
  spec,
  store,
  loading = false,
}: {
  spec: Spec;
  store?: StateStore;
  loading?: boolean;
}) {
  const initialState = useMemo(
    () => (spec as { state?: Record<string, unknown> }).state ?? {},
    [spec],
  );
  const renderNested = useMemo(
    () => (nestedSpec: Spec) => <AgentSpec spec={nestedSpec} />,
    [],
  );
  return (
    <SpecBoundary>
      <SpecRendererContext.Provider value={renderNested}>
        <div className="agent-ui">
          <JSONUIProvider
            registry={registry}
            store={store}
            initialState={store ? undefined : initialState}
          >
            <Renderer spec={spec} registry={registry} loading={loading} />
          </JSONUIProvider>
        </div>
      </SpecRendererContext.Provider>
    </SpecBoundary>
  );
}
