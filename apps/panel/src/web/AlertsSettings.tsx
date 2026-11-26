import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Plus, Trash2 } from 'lucide-react';
import type { AlertChannelSummary, AlertChannelType, AlertDelivery, AlertMetric, AlertRule } from '../shared/alerts.js';
import { api } from './api.js';
import { FeatureError } from './feature-ui.js';

export function AlertsSettings() {
  const id = useId();
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
              : {
                  type: 'smtp',
                  name: channelName,
                  host: smtpHost,
                  port: smtpPort,
                  secure: smtpPort === 465,
                  from: smtpFrom,
                  to: smtpTo,
                  ...(smtpUser ? { username: smtpUser } : {}),
                  ...(smtpPass ? { password: smtpPass } : {}),
                };
      return api('/alerts/channels', { method: 'POST', body });
    },
    onSuccess: () => {
      setChannelName('');
      setUrl('');
      setSecret('');
      setBotToken('');
      setChatId('');
      setSmtpPass('');
      refresh();
    },
  });

  const deleteChannel = useMutation({
    mutationFn: (channelId: string) => api(`/alerts/channels/${channelId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const testChannel = useMutation({
    mutationFn: (channelId: string) => api<{ delivery: AlertDelivery }>(`/alerts/channels/${channelId}/test`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  const createRule = useMutation({
    mutationFn: () =>
      api('/alerts/rules', {
        method: 'POST',
        body: { name: ruleName, metric, serviceId: null, threshold, cooldownMinutes, maxPerHour: 4, channelIds: [selectedChannelId] },
      }),
    onSuccess: () => {
      setRuleName('');
      refresh();
    },
  });

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) => api(`/alerts/rules/${ruleId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  if (!Array.isArray(channelsQuery.data?.channels)) return null;
  const channels = channelsQuery.data.channels;
  const rules = Array.isArray(rulesQuery.data?.rules) ? rulesQuery.data.rules : [];
  const deliveries = Array.isArray(historyQuery.data?.deliveries) ? historyQuery.data.deliveries : [];

  return (
    <section className="surface details-card" id="alerts-settings" aria-label="Alerts and notifications">
      <div className="settings-card-header">
        <div className="settings-card-intro">
          <div className="card-heading">
            <Bell size={19} aria-hidden="true" />
            <h3>Alerts &amp; notifications</h3>
          </div>
          <p>Configure notification channels and threshold rules with deduplication and hourly rate limiting. Channel secrets are encrypted at rest.</p>
        </div>
      </div>

      <div className="module-card-fields" style={{ gap: 18 }}>
        <div className="alerts-subsection" style={{ borderTop: 0, paddingTop: 0 }}>
          <div className="alerts-subsection-header">
            <h4>Notification channels</h4>
            <span className="servus-help">{channels.length} configured</span>
          </div>

          {channels.length ? (
            <ul className="settings-list">
              {channels.map((ch) => (
                <li key={ch.id} className="settings-list-item">
                  <div className="settings-list-copy">
                    <strong>{ch.name}</strong>
                    <span className="mono">{ch.type} · {ch.targetSummary}</span>
                  </div>
                  <div className="settings-list-actions">
                    <button className="button button-small" type="button" disabled={testChannel.isPending} onClick={() => testChannel.mutate(ch.id)}>
                      Test
                    </button>
                    <button className="button button-small" type="button" aria-label={`Delete channel ${ch.name}`} onClick={() => deleteChannel.mutate(ch.id)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="settings-empty">
              <Bell size={18} aria-hidden="true" />
              <div>
                <strong>No notification channels yet</strong>
                <p>Add a signed webhook, Discord, Slack, Telegram, or SMTP target below.</p>
              </div>
            </div>
          )}

          <form
            className="servus-subpanel"
            onSubmit={(event) => {
              event.preventDefault();
              createChannel.mutate();
            }}
          >
            <div className="servus-grid-2">
              <div className="servus-field">
                <label htmlFor={`${id}-ch-name`}>Channel name</label>
                <input
                  id={`${id}-ch-name`}
                  className="servus-input"
                  required
                  maxLength={80}
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  placeholder="Ops webhook"
                />
              </div>
              <div className="servus-field">
                <label htmlFor={`${id}-ch-type`}>Type</label>
                <select
                  id={`${id}-ch-type`}
                  className="servus-select"
                  value={channelType}
                  onChange={(e) => setChannelType(e.target.value as AlertChannelType)}
                >
                  <option value="webhook">Signed webhook</option>
                  <option value="discord">Discord</option>
                  <option value="slack">Slack</option>
                  <option value="telegram">Telegram</option>
                  <option value="smtp">SMTP email</option>
                </select>
              </div>
            </div>

            {channelType === 'webhook' || channelType === 'discord' || channelType === 'slack' ? (
              <div className={channelType === 'webhook' ? 'servus-grid-2' : 'servus-field'}>
                <div className="servus-field">
                  <label htmlFor={`${id}-ch-url`}>HTTPS endpoint URL</label>
                  <input
                    id={`${id}-ch-url`}
                    className="servus-input mono"
                    type="url"
                    required
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://hooks.example.com/..."
                  />
                </div>
                {channelType === 'webhook' ? (
                  <div className="servus-field">
                    <label htmlFor={`${id}-ch-secret`}>Signing secret (optional, HMAC-SHA256)</label>
                    <input
                      id={`${id}-ch-secret`}
                      className="servus-input"
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {channelType === 'telegram' ? (
              <div className="servus-grid-2">
                <div className="servus-field">
                  <label htmlFor={`${id}-tg-token`}>Bot token</label>
                  <input id={`${id}-tg-token`} className="servus-input" type="password" required value={botToken} onChange={(e) => setBotToken(e.target.value)} autoComplete="new-password" />
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-tg-chat`}>Chat ID</label>
                  <input id={`${id}-tg-chat`} className="servus-input mono" required value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" />
                </div>
              </div>
            ) : null}

            {channelType === 'smtp' ? (
              <div className="servus-grid-2">
                <div className="servus-field">
                  <label htmlFor={`${id}-smtp-host`}>SMTP host</label>
                  <input id={`${id}-smtp-host`} className="servus-input mono" required value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-smtp-port`}>Port</label>
                  <input id={`${id}-smtp-port`} className="servus-input mono" type="number" min={1} max={65535} required value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))} />
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-smtp-from`}>From</label>
                  <input id={`${id}-smtp-from`} className="servus-input" type="email" required value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} />
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-smtp-to`}>To</label>
                  <input id={`${id}-smtp-to`} className="servus-input" type="email" required value={smtpTo} onChange={(e) => setSmtpTo(e.target.value)} />
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-smtp-user`}>Username (optional)</label>
                  <input id={`${id}-smtp-user`} className="servus-input" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-smtp-pass`}>Password (optional)</label>
                  <input id={`${id}-smtp-pass`} className="servus-input" type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} autoComplete="new-password" />
                </div>
              </div>
            ) : null}

            <FeatureError error={createChannel.error || testChannel.error || deleteChannel.error} />
            <div>
              <button className="button button-primary button-small" type="submit" disabled={createChannel.isPending}>
                <Plus size={14} aria-hidden="true" /> Add channel
              </button>
            </div>
          </form>
        </div>

        <div className="alerts-subsection">
          <div className="alerts-subsection-header">
            <h4>Host alert rules</h4>
            <span className="servus-help">{rules.length} active</span>
          </div>

          {rules.length ? (
            <ul className="settings-list">
              {rules.map((rule) => (
                <li key={rule.id} className="settings-list-item">
                  <div className="settings-list-copy">
                    <strong>{rule.name}</strong>
                    <span className="mono">{rule.metric} &gt;= {rule.threshold}% · cooldown {rule.cooldownMinutes}m</span>
                  </div>
                  <div className="settings-list-actions">
                    <button className="button button-small" type="button" aria-label={`Delete rule ${rule.name}`} onClick={() => deleteRule.mutate(rule.id)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="servus-help">No alert rules configured. Add a notification channel first to create threshold alerts.</p>
          )}

          {channels.length ? (
            <form
              className="servus-subpanel"
              onSubmit={(event) => {
                event.preventDefault();
                createRule.mutate();
              }}
            >
              <div className="servus-grid-2">
                <div className="servus-field">
                  <label htmlFor={`${id}-rule-name`}>Rule name</label>
                  <input id={`${id}-rule-name`} className="servus-input" required value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="High disk usage" />
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-rule-metric`}>Metric</label>
                  <select id={`${id}-rule-metric`} className="servus-select" value={metric} onChange={(e) => setMetric(e.target.value as AlertMetric)}>
                    <option value="host_disk_percent">Host disk used (%)</option>
                    <option value="host_memory_percent">Host memory used (%)</option>
                  </select>
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-rule-threshold`}>Threshold (%)</label>
                  <input id={`${id}-rule-threshold`} className="servus-input mono" type="number" min={1} max={100} required value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
                </div>
                <div className="servus-field">
                  <label htmlFor={`${id}-rule-cooldown`}>Cooldown (minutes)</label>
                  <input id={`${id}-rule-cooldown`} className="servus-input mono" type="number" min={1} max={1440} required value={cooldownMinutes} onChange={(e) => setCooldownMinutes(Number(e.target.value))} />
                </div>
              </div>
              <div className="servus-field">
                <label htmlFor={`${id}-rule-channel`}>Target channel</label>
                <select id={`${id}-rule-channel`} className="servus-select" required value={selectedChannelId} onChange={(e) => setSelectedChannelId(e.target.value)}>
                  <option value="">Select channel</option>
                  {channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>{ch.name}</option>
                  ))}
                </select>
              </div>
              <FeatureError error={createRule.error || deleteRule.error} />
              <div>
                <button className="button button-primary button-small" type="submit" disabled={createRule.isPending || !selectedChannelId}>
                  <Plus size={14} aria-hidden="true" /> Add alert rule
                </button>
              </div>
            </form>
          ) : null}
        </div>

        {deliveries.length ? (
          <details className="servus-subpanel">
            <summary style={{ cursor: 'pointer', fontWeight: 550, fontSize: 13 }}>Recent deliveries ({deliveries.length})</summary>
            <div className="host-events-list">
              {deliveries.map((d) => (
                <div key={d.id} className="detail-row">
                  <span>
                    <strong className="mono">[{d.status}] {d.ruleName} → {d.channelName}</strong>
                    <small className="host-event-meta">{d.message}</small>
                  </span>
                  <span className="host-event-time mono">{new Date(d.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}
