type SkeletonKind = "projects" | "services" | "table" | "service" | "metrics";

function ServiceCards({ count = 3 }: { count?: number }) {
  return <div className="dashboard-services-grid">{Array.from({length: count}, (_, index) =>
    <div className="skeleton-service" key={index}><span className="skeleton-block skeleton-icon" /><span className="skeleton-copy"><span className="skeleton-block skeleton-title" /><span className="skeleton-block skeleton-caption" /></span><span className="skeleton-block skeleton-badge" /></div>
  )}</div>;
}

export function Skeleton({ kind, label }: { kind: SkeletonKind; label: string }) {
  return <div className={`skeleton skeleton-${kind}`} role="status" aria-label={label}>
    <span className="sr-only">{label}</span>
    <div aria-hidden="true">
      {kind === "projects" ? [0, 1].map(index => <div className="skeleton-group" key={index}><div className="skeleton-heading"><span className="skeleton-block skeleton-project-title" /><span className="skeleton-block skeleton-caption" /></div><ServiceCards /></div>) : null}
      {kind === "services" ? <ServiceCards /> : null}
      {kind === "table" ? <div className="surface skeleton-table">{[0,1,2,3].map(index => <div className="skeleton-row" key={index}><span className="skeleton-block skeleton-title" /><span className="skeleton-block skeleton-caption" /><span className="skeleton-block skeleton-badge" /></div>)}</div> : null}
      {kind === "metrics" ? <div className="service-metrics-grid skeleton-inline-metrics">{[0,1,2,3].map(index => <span className="skeleton-copy" key={index}><span className="skeleton-block skeleton-caption" /><span className="skeleton-block skeleton-title" /></span>)}</div> : null}
      {kind === "service" ? <><div className="skeleton-service-heading"><span className="skeleton-block skeleton-icon" /><span className="skeleton-copy"><span className="skeleton-block skeleton-project-title" /><span className="skeleton-block skeleton-title" /></span></div><div className="surface skeleton-metrics">{[0,1,2,3].map(index => <span className="skeleton-copy" key={index}><span className="skeleton-block skeleton-caption" /><span className="skeleton-block skeleton-title" /></span>)}</div><div className="skeleton-details"><div className="surface skeleton-panel"><span className="skeleton-block skeleton-project-title" /><span className="skeleton-block skeleton-line" /><span className="skeleton-block skeleton-line" /></div><div className="surface skeleton-panel"><span className="skeleton-block skeleton-project-title" /><span className="skeleton-block skeleton-line" /><span className="skeleton-block skeleton-line" /></div></div></> : null}
    </div>
  </div>;
}
