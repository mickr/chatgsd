import { useState } from "react";
import { isMac } from "../../lib/platform";
import { errorMessage, setupComputerPermissions, type ComputerPermission } from "../../services/agent";
import { Button } from "../ui";

const PERMISSIONS: ComputerPermission[] = ["accessibility", "screen_recording"];
const LABELS = { accessibility: "Open Accessibility", screen_recording: "Open Screen Recording" };

/** Explicit user actions only. The agent cannot request or grant OS permissions. */
export function ComputerPermissions({ permissions = PERMISSIONS }: { permissions?: ComputerPermission[] }) {
  const [message, setMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  if (!isMac || permissions.length === 0) return null;
  const open = async (permission: ComputerPermission) => {
    setOpening(true);
    try {
      setMessage(await setupComputerPermissions(permission));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {permissions.map((permission) => (
          <Button key={permission} variant="outline" size="md" disabled={opening} onClick={() => { void open(permission); }}>
            {LABELS[permission]}
          </Button>
        ))}
      </div>
      {message && <p role="status" className="text-xs text-text-muted">{message}</p>}
    </div>
  );
}
