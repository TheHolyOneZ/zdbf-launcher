import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { IconButton } from "./ui";

export function Dialog({
  open,
  title,
  children,
  actions,
  onClose,
  wide,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      el.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog-wide" : ""}`}
      tabIndex={-1}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <>
          <header className="dialog-head">
            <h2 id={id}>{title}</h2>
            <IconButton label="Close" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>
          <div className="dialog-body">{children}</div>
          {actions ? <footer className="dialog-actions">{actions}</footer> : null}
        </>
      ) : null}
    </dialog>
  );
}
