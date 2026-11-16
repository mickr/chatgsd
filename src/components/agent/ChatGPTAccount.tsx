import { toast } from "sonner";
import { useAgent } from "../../context/AgentContext";
import { ChatGPTIcon, SpinnerIcon } from "../icons";
import { errorMessage, openUsage } from "../../services/agent";

export function ManageUsage({ primary = false }: { primary?: boolean }) {
  return (
    <button
      type="button"
      className={primary ? "agent-panel-primary" : "agent-panel-link"}
      onClick={() => {
        void openUsage().catch((error) => toast.error(errorMessage(error)));
      }}
    >
      Manage usage
    </button>
  );
}
export function ContinueWithChatGPT() {
  const { signingIn, signIn, cancelSignIn } = useAgent();
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="agent-panel-chatgpt"
        disabled={signingIn}
        onClick={() => {
          void signIn();
        }}
      >
        {signingIn ? (
          <SpinnerIcon className="w-4 h-4 animate-spin" />
        ) : (
          <ChatGPTIcon className="w-4.5 h-4.5" />
        )}
        {signingIn ? "Waiting for browser…" : "Continue with ChatGPT"}
      </button>
      {signingIn && (
        <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
          <span>Finish signing in in your browser.</span>
          <button
            type="button"
            className="agent-panel-link"
            onClick={() => {
              void cancelSignIn();
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
export function PlanNotice() {
  const { status, acknowledgePlan } = useAgent();
  const account = status?.account;
  if (!account?.planUsage || account.planNoticeSeen) return null;
  return (
    <section
      className="rounded-xl border border-border bg-bg p-4 space-y-3"
      aria-label="ChatGPT plan confirmation"
    >
      <ChatGPTIcon className="w-6 h-6" />
      <div>
        <h3 className="text-sm font-medium">You're using your ChatGPT plan</h3>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          Eligible requests in ChatGSD use your ChatGPT plan or credits balance.
          You can review and manage usage in ChatGPT settings.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="agent-panel-primary"
          onClick={() => {
            void acknowledgePlan();
          }}
        >
          Got it
        </button>
        <ManageUsage />
      </div>
    </section>
  );
}
