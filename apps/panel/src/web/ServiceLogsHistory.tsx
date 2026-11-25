import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { LogLevel, LogWindow, ServiceLogHistory } from '../shared/types.js';
import { api } from './api.js';
import { FeatureError } from './feature-ui.js';

export function ServiceLogsHistory({ serviceId }: { serviceId: string }) {
  const [window, setWindow] = useState<LogWindow>('24h');
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [draftQuery, setDraftQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');

  const params = new URLSearchParams({
    window,
    level,
    limit: '200',
    ...(submittedQuery ? { q: submittedQuery } : {}),
  });

  const history = useQuery({
    queryKey: ['runtime-logs-history', serviceId, window, level, submittedQuery],
    queryFn: ({ signal }) => api<ServiceLogHistory>(`/services/${serviceId}/logs/history?${params.toString()}`, { signal }),
    retry: false,
  });

  const entries = history.data?.entries ?? [];

  return (
    <section className="surface live-logs-card" aria-label="Archived logs search">
      <div className="feature-panel-heading">
        <div>
          <h3>Archived logs</h3>
          <p>
            Search redacted log lines collected over the last {history.data?.retentionDays ?? 7} days.
          </p>
        </div>
      </div>
      <form
        className="heading-actions"
        style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          setSubmittedQuery(draftQuery.trim());
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="sr-only">Search query</span>
          <input
            type="search"
            placeholder="Filter logs by text..."
            value={draftQuery}
            maxLength={200}
            onChange={(event) => setDraftQuery(event.target.value)}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="sr-only">Time window</span>
          <select aria-label="Archive time window" value={window} onChange={(event) => setWindow(event.target.value as LogWindow)}>
            <option value="1h">Last 1h</option>
            <option value="6h">Last 6h</option>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7d</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="sr-only">Log level</span>
          <select aria-label="Archive log level" value={level} onChange={(event) => setLevel(event.target.value as LogLevel | 'all')}>
            <option value="all">All levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
        </label>
        <button className="button button-small" type="submit" disabled={history.isFetching}>
          <Search size={14} />
          Search archive
        </button>
      </form>
      <FeatureError error={history.error} />
      {history.data?.truncated ? (
        <p className="feature-helper" role="status">
          Archive capacity reached; oldest log lines were trimmed.{history.data.earliestAvailableAt ? ` Earliest available: ${new Date(history.data.earliestAvailableAt).toLocaleString()}.` : ''}
        </p>
      ) : null}
      <pre className="runtime-log-output" role="log" aria-label="Archived application logs">
        {history.isPending
          ? 'Loading archived logs...'
          : entries.length
            ? entries.map((entry) => entry.line).join('\n')
            : 'No archived log lines match the current filter.'}
      </pre>
    </section>
  );
}
