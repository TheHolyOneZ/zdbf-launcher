import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "../state/store";

export function TitleBar() {
  const os = useStore((s) => s.app?.os);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!os || os === "macos") return;
    const win = getCurrentWindow();
    let alive = true;
    let off: (() => void) | null = null;
    const sync = () => {
      win
        .isMaximized()
        .then((m) => {
          if (alive) setMaximized(m);
        })
        .catch(() => undefined);
    };
    sync();
    win
      .onResized(sync)
      .then((u) => {
        if (alive) off = u;
        else u();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, [os]);

  if (!os) return null;

  return (
    <>
      <div className="dragstrip" data-tauri-drag-region aria-hidden />
      {os === "macos" ? null : (
        <div className="wincontrols" role="group" aria-label="Window">
          <button
            type="button"
            className="winbtn"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => void getCurrentWindow().minimize()}
          >
            <Minus size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="winbtn"
            aria-label={maximized ? "Restore" : "Maximize"}
            title={maximized ? "Restore" : "Maximize"}
            onClick={() => void getCurrentWindow().toggleMaximize()}
          >
            {maximized ? (
              <Copy size={13} strokeWidth={1.8} className="winbtn-restore" />
            ) : (
              <Square size={12} strokeWidth={1.8} />
            )}
          </button>
          <button
            type="button"
            className="winbtn winbtn-close"
            aria-label="Close"
            title="Close"
            onClick={() => void getCurrentWindow().close()}
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>
      )}
    </>
  );
}
