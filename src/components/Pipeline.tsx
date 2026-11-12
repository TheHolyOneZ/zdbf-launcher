export interface PipeStep {
  id: string;
  label: string;
  note: string;
}

export function Pipeline({ steps, at, back }: { steps: PipeStep[]; at: number | null; back?: boolean }) {
  return (
    <ol
      className={`pipeline${at === null ? " is-preview" : ""}${back ? " is-rollback" : ""}`}
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
    >
      {steps.map((p, i) => {
        const state = back ? "back" : at === null ? "next" : i < at ? "done" : i === at ? "now" : "next";
        return (
          <li key={p.id} className={`pipe pipe-${state}`} style={{ animationDelay: `${i * 70}ms` }}>
            <span className="pipe-node">
              <span className="pipe-core" />
            </span>
            <span className="pipe-label">{p.label}</span>
            <span className="pipe-note">{p.note}</span>
          </li>
        );
      })}
    </ol>
  );
}
