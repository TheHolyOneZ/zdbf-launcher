import { useState } from "react";
import { api, errorText } from "../lib/api";
import { useStore } from "../state/store";
import { Dialog } from "./Dialog";
import { Button } from "./ui";

export function ClosePrompt() {
  const open = useStore((s) => s.closePrompt);
  const setOpen = useStore((s) => s.setClosePrompt);
  const toast = useStore((s) => s.toast);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<"tray" | "quit" | null>(null);

  const choose = async (keepRunning: boolean) => {
    setBusy(keepRunning ? "tray" : "quit");
    try {
      if (remember && prefs) setPrefs(await api.setPrefs({ closeToTray: keepRunning }));
      if (keepRunning) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().hide();
        setOpen(false);
      } else {
        await api.quit(true);
      }
    } catch (e) {
      toast("bad", errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      title="A bot is still running"
      onClose={() => setOpen(false)}
      actions={
        <>
          <Button onClick={() => choose(false)} busy={busy === "quit"}>
            Stop bots and quit
          </Button>
          <Button variant="primary" onClick={() => choose(true)} busy={busy === "tray"}>
            Keep running
          </Button>
        </>
      }
    >
      <p>
        Keep running hides this window. Your bots stay online, and the launcher stays in the system tray,
        where you can open it again or quit.
      </p>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Remember my choice</span>
      </label>
    </Dialog>
  );
}
