import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Trash2 } from 'lucide-react';
import type { AlertChannelSummary, AlertChannelType, AlertDelivery, AlertMetric, AlertRule } from '../shared/alerts.js';
import { api } from './api.js';
import { FeatureError } from './feature-ui.js';

export function AlertsSettings() {
  const client = useQueryClient();
  const [channelType, setChannelType] = useState<AlertChannelType>('webhook');
  const [channelName, setChannelName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpTo, setSmtpTo] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');

  const [ruleName, setRuleName] = useState('');
  const [metric, setMetric] = useState<AlertMetric>('host_disk_percent');
  const [threshold, setThreshold] = useState(85);
  const [cooldownMinutes, setCooldownMinutes] = useState(15);
  const [selectedChannelId, setSelectedChannelId] = useState('');

  const channelsQuery = useQuery({
    queryKey: ['alert-channels'],
    queryFn: ({ signal }) => api<{ channels?: AlertChannelSummary[] }>('/alerts/channels', { signal }),
    retry: false,
  });
  const rulesQuery = useQuery({
    queryKey: ['alert-rules'],
    queryFn: ({ signal }) => api<{ rules?: AlertRule[] }>('/alerts/rules', { signal }),
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: ['alert-history'],
    queryFn: ({ signal }) => api<{ deliveries?: AlertDelivery[] }>('/alerts/history?limit=20', { signal }),
    retry: false,
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['alert-channels'] });
    void client.invalidateQueries({ queryKey: ['alert-rules'] });
    void client.invalidateQueries({ queryKey: ['alert-history'] });
  };

  const createChannel = useMutation({
    mutationFn: () => {
      const body =
        channelType === 'webhook'
          ? { type: 'webhook', name: channelName, url, ...(secret ? { secret } : {}) }
          : channelType === 'discord' || channelType === 'slack'
            ? { type: channelType, name: channelName, webhookUrl: url }
            : channelType === 'telegram'
              ? { type: 'telegram', name: channelName, botToken, chatId }
              : { type: 'smtp', name: channelName, host: smtpHost, port: smtpPort, secure: smtpPort === 465, from: smtpFrom, to: smtpTo, ...(smtpUser ? { username: smtpUser } : {}), ...(smtpPass ? { password: smtpPass } : {}) };
      return api('/alerts/channels', { method: 'POST', body });
    },
    onSuccess: () => {
      setChannelName(''); setUrl(''); setSecret(''); setBotToken(''); setChatId(''); setSmtpPass('');
      refresh();
    },
  });

  const deleteChannel = useMutation({
    mutationFn: (id: string) => api(`/alerts/channels/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const testChannel = useMutation({
    mutationFn: (id: string) => api<{ delivery: AlertDelivery }>(`/alerts/channels/${id}/test`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  const createRule = useMutation({
    mutationFn: () => api('/alerts/rules', {
      method: 'POST',
      body: { name: ruleName, metric, serviceId: null, threshold, cooldownMinutes, maxPerHour: 4, channelIds: [selectedChannelId] },
    }),
    onSuccess: () => { setRuleName(''); refresh(); },
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => api(`/alerts/rules/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  // Hide gracefully when mocked API returns empty object {}
  if (!Array.isArray(channelsQuery.data?.channels)) return null;
  const channels = channelsQuery.data.channels;
  const rules = Array.isArray(rulesQuery.data?.rules) ? rulesQuery.data.rules : [];
  const deliveries = Array.isArray(historyQuery.data?.deliveries) ? historyQuery.data.deliveries : [];

  return (
    <section className="surface details-card" id="alerts-settings" aria-label="Alerts and notifications">
      <div className="card-heading">
        <Bell size={19} />
        <h3>Alerts &amp; notifications</h3>
      </div>
      <p>Configure notification channels and threshold rules with deduplication and hourly rate limiting. Channel secrets are encrypted at rest.</p>

      <h4>Notification channels</h4>
      {channels.length ? (
        <ul>
          {channels.map(ch => (
            <li key={ch.id} className="detail-row">
              <span><strong>{ch.name}</strong> ({ch.type} - {ch.targetSummary})</span>
              <span className="heading-actions">
                <button className="button button-small" type="button" disabled={testChannel.isPending} onClick={() => testChannel.mutate(ch.id)}>Test</button>
                <button className="icon-button" type="button" aria-label={`Delete channel ${ch.name}`} onClick={() => deleteChannel.mutate(ch.id)}><Trash2 size={15} /></button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="feature-helper">No notification channels configured yet.</p>}

      <form onSubmit={event => { event.preventDefault(); createChannel.mutate(); }}>
        <div className="form-grid">
          <label>Channel name<input required maxLength={80} value={channelName} onChange={e => setChannelName(e.target.value)} placeholder="Ops webhook" /></label>
          <label>Type
            <select value={channelType} onChange={e => setChannelType(e.target.value as AlertChannelType)}>
              <option value="webhook">Signed webhook</option>
              <option value="discord">Discord</option>
              <option value="slack">Slack</option>
              <option value="telegram">Telegram</option>
              <option value="smtp">SMTP email</option>
            </select>
          </label>
        </div>
        {channelType === 'webhook' || channelType === 'discord' || channelType === 'slack' ? (
          <label>HTTPS endpoint URL<input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://hooks.example.com/..." /></label>
        ) : null}
        {channelType === 'webhook' ? (
          <label>Signing secret (optional, HMAC-SHA256)<input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="new-password" /></label>
        ) : null}
        {channelType === 'telegram' ? (
          <div className="form-grid">
            <label>Bot token<input type="password" required value={botToken} onChange={e => setBotToken(e.target.value)} autoComplete="new-password" /></label>
            <label>Chat ID<input required value={chatId} onChange={e => setChatId(e.target.value)} placeholder="-1001234567890" /></label>
          </div>
        ) : null}
        {channelType === 'smtp' ? (
          <div className="form-grid">
            <label>SMTP host<input required value={smtpHost} onChange={e => setSmtpHost(e.target.value)} placeholder="smtp.example.com" /></label>
            <label>Port<input type="number" min={1} max={65535} required value={smtpPort} onChange={e => setSmtpPort(Number(e.target.value))} /></label>
            <label>From<input type="email" required value={smtpFrom} onChange={e => setSmtpFrom(e.target.value)} /></label>
            <label>To<input type="email" required value={smtpTo} onChange={e => setSmtpTo(e.target.value)} /></label>
            <label>Username (optional)<input value={smtpUser} onChange={e => setSmtpUser(e.target.value)} /></label>
            <label>Password (optional)<input type="password" value={smtpPass} onChange={e => setSmtpPass(e.target.value)} autoComplete="new-password" /></label>
          </div>
        ) : null}
        <FeatureError error={createChannel.error || testChannel.error || deleteChannel.error} />
        <button className="button button-small" type="submit" disabled={createChannel.isPending}>Add channel</button>
      </form>

      <h4>Host alert rules</h4>
      {rules.length ? (
        <ul>
          {rules.map(rule => (
            <li key={rule.id} className="detail-row">
              <span><strong>{rule.name}</strong> ({rule.metric} &gt;= {rule.threshold}%, cooldown {rule.cooldownMinutes}m)</span>
              <button className="icon-button" type="button" aria-label={`Delete rule ${rule.name}`} onClick={() => deleteRule.mutate(rule.id)}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="feature-helper">No alert rules configured.</p>}

      {channels.length ? (
        <form onSubmit={event => { event.preventDefault(); createRule.mutate(); }}>
          <div className="form-grid">
            <label>Rule name<input required value={ruleName} onChange={e => setRuleName(e.target.value)} placeholder="High disk usage" /></label>
            <label>Metric
              <select value={metric} onChange={e => setMetric(e.target.value as AlertMetric)}>
                <option value="host_disk_percent">Host disk used (%)</option>
                <option value="host_memory_percent">Host memory used (%)</option>
              </select>
            </label>
            <label>Threshold (%)<input type="number" min={1} max={100} required value={threshold} onChange={e => setThreshold(Number(e.target.value))} /></label>
            <label>Cooldown (min)<input type="number" min={1} max={1440} required value={cooldownMinutes} onChange={e => setCooldownMinutes(Number(e.target.value))} /></label>
            <label>Channel
              <select required value={selectedChannelId} onChange={e => setSelectedChannelId(e.target.value)}>
                <option value="">Select channel</option>
                {channels.map(ch => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
              </select>
            </label>
          </div>
          <FeatureError error={createRule.error || deleteRule.error} />
          <button className="button button-small" type="submit" disabled={createRule.isPending || !selectedChannelId}>Add alert rule</button>
        </form>
      ) : null}

      {deliveries.length ? (
        <details>
          <summary>Recent deliveries ({deliveries.length})</summary>
          <ul>
            {deliveries.map(d => (
              <li key={d.id}>
                <code>{new Date(d.createdAt).toLocaleString()}</code> [{d.status}] {d.ruleName} -&gt; {d.channelName}: {d.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
