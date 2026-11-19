import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAgent } from "../../context/AgentContext";
import { errorMessage, openExternalUrl } from "../../services/agent";
import { AntigravityIcon, SpinnerIcon } from "../icons";
import { Button } from "../ui";

/**
 * Antigravity Google sign-in button and inline authorization-code handoff.
 * `agy acp --login` opens Google OAuth in the browser and reads the resulting
 * authorization code (or full callback URL) back from stdin.
 */
export function AntigravitySignIn() {
  const agent = useAgent();
  const authUrl = agent.antigravityAuthUrl ?? null;
  const signingIn = !!agent.antigravitySigningIn;
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (authUrl) {
      setCode("");
      inputRef.current?.focus();
    }
  }, [authUrl]);

  if (!authUrl) {
    return (
      <button
        type="button"
        className="agent-panel-chatgpt"
        disabled={signingIn}
        onClick={() => {
          void agent.signInAntigravity?.();
        }}
      >
        {signingIn ? (
          <SpinnerIcon className="w-4 h-4 animate-spin" />
        ) : (
          <AntigravityIcon className="w-4.5 h-4.5" />
        )}
        {signingIn ? "Opening Google sign-in…" : "Continue with Antigravity"}
      </button>
    );
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || signingIn) return;
    void agent.completeAntigravitySignIn?.(trimmed);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5">
      <p className="text-xs text-text-muted leading-relaxed">
        Finish signing in with Google in your browser, then paste the authorization code or callback URL here.
      </p>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={code}
          disabled={signingIn}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Antigravity authorization code or callback URL"
          placeholder="Paste code or callback URL…"
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !signingIn) {
              event.preventDefault();
              void agent.cancelAntigravitySignIn?.();
            }
          }}
          className="flex-1 min-w-0 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs font-mono text-text placeholder:text-text-muted/60 focus:outline-none focus:border-accent"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={signingIn || !code.trim()}
        >
          {signingIn ? (
            <span className="inline-flex items-center gap-1.5">
              <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />
              Signing in…
            </span>
          ) : (
            "Finish sign-in"
          )}
        </Button>
      </div>
      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          className="text-text-muted hover:text-text underline underline-offset-2"
          onClick={() => {
            void openExternalUrl(authUrl).catch((error) => {
              toast.error(`Couldn't open sign-in page: ${errorMessage(error)}`);
            });
          }}
        >
          Open sign-in page again
        </button>
        <button
          type="button"
          className="text-text-muted hover:text-text"
          disabled={signingIn}
          onClick={() => {
            setCode("");
            void agent.cancelAntigravitySignIn?.();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
