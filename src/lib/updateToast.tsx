import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  check as checkForUpdate,
  type Update,
} from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { CircleCheckIcon } from "../components/icons";

const UPDATE_TOAST_ID = "update-toast";
const UPDATE_INSTALLED_TOAST_ID = "update-installed-toast";
const FLUSH_BEFORE_RESTART_EVENT = "flush-before-restart";
const FLUSH_TIMEOUT_MS = 2000;

let installedVersion: string | null = null;

export function resetInstalledUpdateState(): void {
  installedVersion = null;
}

async function flushBeforeRestart(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(
    new CustomEvent(FLUSH_BEFORE_RESTART_EVENT, {
      detail: {
        register: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      },
    }),
  );
  if (pending.length === 0) return;
  let timer: number | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, FLUSH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function showUpdateInstalledToast(version: string): void {
  toast(<UpdateInstalledToast version={version} />, {
    id: UPDATE_INSTALLED_TOAST_ID,
    duration: Infinity,
    closeButton: true,
  });
}

// Shared update check — used by startup and manual "Check for Updates"
export async function showUpdateToast(): Promise<"update" | "no-update" | "error"> {
  try {
    const update = await checkForUpdate();
    if (update) {
      if (installedVersion === update.version) {
        showUpdateInstalledToast(update.version);
      } else {
        toast(<UpdateToast update={update} toastId={UPDATE_TOAST_ID} />, {
          id: UPDATE_TOAST_ID,
          duration: Infinity,
          closeButton: true,
        });
      }
      return "update";
    }
    return "no-update";
  } catch (err) {
    console.error("Update check failed:", err);
    return "error";
  }
}

export function UpdateInstalledToast({ version }: { version: string }) {
  const [restarting, setRestarting] = useState(false);

  const handleRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    try {
      await flushBeforeRestart();
      await invoke("restart_app");
    } catch (err) {
      console.error("Restart failed:", err);
      toast.error("Could not restart ChatGSD. Please quit and reopen it manually.");
      setRestarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium text-sm flex items-center gap-1.5">
        <CircleCheckIcon className="w-4 h-4 shrink-0 text-text" />
        <span>Update Installed</span>
      </div>
      <div className="text-xs text-text-muted">
        Restart ChatGSD to apply v{version}.
      </div>
      <button
        type="button"
        onClick={handleRestart}
        disabled={restarting}
        className="self-start mt-1 text-xs font-medium px-3 py-1.5 rounded-md bg-text text-bg hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer"
      >
        {restarting ? "Restarting..." : "Restart Now"}
      </button>
    </div>
  );
}

export function UpdateToast({
  update,
  toastId,
}: {
  update: Update;
  toastId: string | number;
}) {
  const [installing, setInstalling] = useState(false);

  const handleUpdate = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      installedVersion = update.version;
      toast.dismiss(toastId);
      showUpdateInstalledToast(update.version);
    } catch (err) {
      console.error("Update failed:", err);
      toast.error("Update failed. Please try again later.");
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium text-sm">
        Update Available: v{update.version}
      </div>
      {update.body && (
        <div className="text-xs text-text-muted line-clamp-3">
          {update.body}
        </div>
      )}
      <button
        type="button"
        onClick={handleUpdate}
        disabled={installing}
        className="self-start mt-1 text-xs font-medium px-3 py-1.5 rounded-md bg-text text-bg hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer"
      >
        {installing ? "Installing..." : "Update Now"}
      </button>
    </div>
  );
}
