import {
  Check,
  CircleCheck,
  Copy,
  Eye,
  EyeOff,
  Info,
  LoaderCircle,
  OctagonAlert,
  TriangleAlert,
} from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Tone } from "../lib/format";
import { RollText } from "./fx";

type Variant = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ""}`}
    >
      {busy ? <LoaderCircle className="spin" size={16} aria-hidden /> : icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={`icon-btn${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
  if (label) return <span className={`dot dot-${tone}`} role="img" aria-label={label} />;
  return <span className={`dot dot-${tone}`} aria-hidden />;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle className="spin" size={size} aria-hidden />;
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`toggle-row${disabled ? " is-disabled" : ""}`}>
      <div className="toggle-text">
        <label htmlFor={id} className="toggle-label">
          {label}
        </label>
        {description ? (
          <p className="hint" id={`${id}-d`}>
            {description}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        className="switch"
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  id,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  id: string;
}) {
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input${props.className ? ` ${props.className}` : ""}`} />;
}

export function SecretInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret">
      <input
        {...props}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className="input mono"
      />
      <IconButton label={shown ? "Hide token" : "Show token"} onClick={() => setShown((v) => !v)}>
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
      </IconButton>
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "ok" | "warn" | "bad";
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <CalloutIcon tone={tone} />
      <div className="callout-body">
        <p className="callout-title">{title}</p>
        {children ? <div className="callout-text">{children}</div> : null}
      </div>
      {action ? <div className="callout-action">{action}</div> : null}
    </div>
  );
}

function CalloutIcon({ tone }: { tone: "info" | "ok" | "warn" | "bad" }) {
  const Icon =
    tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : tone === "bad" ? OctagonAlert : Info;
  return <Icon className="callout-icon" size={18} strokeWidth={2} aria-hidden />;
}

export function CopyLine({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="copy-line">
      <code className="selectable">{text}</code>
      <IconButton
        label={copied ? "Copied" : (label ?? "Copy")}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            timer.current = window.setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? <Check key="y" size={16} /> : <Copy key="n" size={16} />}
      </IconButton>
    </div>
  );
}

export function Meter({ value }: { value: number | null }) {
  return (
    <div
      className={`meter${value === null ? " is-indeterminate" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
    >
      <span style={value === null ? undefined : { width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}

export function PageHead({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <RollText as="h1" className="page-title" text={title} />
        {lead ? <p className="page-lead">{lead}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-text">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
