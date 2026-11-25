export type AlertChannelType = 'webhook' | 'discord' | 'slack' | 'telegram' | 'smtp';

export type AlertMetric =
  | 'service_cpu_percent'
  | 'service_memory_percent'
  | 'service_down'
  | 'host_disk_percent'
  | 'host_memory_percent';

export interface AlertChannelSummary {
  id: string;
  name: string;
  type: AlertChannelType;
  enabled: boolean;
  targetSummary: string;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  metric: AlertMetric;
  serviceId: string | null;
  threshold: number;
  cooldownMinutes: number;
  maxPerHour: number;
  channelIds: string[];
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertDelivery {
  id: string;
  ruleId: string | null;
  ruleName: string;
  channelId: string;
  channelName: string;
  metric: AlertMetric | 'test';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  status: 'sent' | 'failed' | 'suppressed';
  attempts: number;
  error: string | null;
  createdAt: string;
}
