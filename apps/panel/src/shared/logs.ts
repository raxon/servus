export type LogLevel = 'error' | 'warn' | 'info';
export type LogWindow = '1h' | '6h' | '24h' | '7d';

export interface ArchivedLogEntry {
  id: number;
  observedAt: string;
  level: LogLevel;
  line: string;
}

export interface ServiceLogHistory {
  serviceId: string;
  window: LogWindow;
  query: string;
  level: LogLevel | 'all';
  retentionDays: number;
  earliestAvailableAt: string | null;
  truncated: boolean;
  entries: ArchivedLogEntry[];
}

export const LOG_WINDOW_MS: Record<LogWindow, number> = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export function classifyLogLevel(line: string): LogLevel {
  if (/\b(?:error|err|fatal|panic|exception|crit|critical|emerg|traceback|unhandled)\b/i.test(line)) {
    return 'error';
  }
  if (/\b(?:warn|warning|deprecated)\b/i.test(line)) {
    return 'warn';
  }
  return 'info';
}
