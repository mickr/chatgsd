import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";

export function useUpdateMenu(check: () => Promise<"update" | "no-update" | "error">): void {
  useEffect(() => {
    let disposed = false;
    let checking = false;
    const subscription = getCurrentWindow().listen("check-for-updates", async () => {
      if (disposed || checking) return;
      checking = true;
      const id = toast.loading("Checking for updates…");
      try {
        const result = await check();
        if (result === "no-update") toast.success("You're on the latest version!", { id });
        else if (result === "error") toast.error("Could not check for updates. Try again later.", { id });
        else toast.dismiss(id);
      } catch {
        toast.error("Could not check for updates. Try again later.", { id });
      } finally {
        checking = false;
      }
    });
    subscription.catch((error) => console.error("Couldn't listen for update checks:", error));
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [check]);
}
