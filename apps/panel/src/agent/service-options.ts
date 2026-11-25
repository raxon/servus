import type Docker from 'dockerode';
import type { Service, ServiceHealthcheckConfig } from '../shared/types.js';

export function compileApplicationEndpointSpec(service: Pick<Service, 'ports' | 'endpointMode'>): Docker.EndpointSpec | undefined {
  if (service.endpointMode === 'dnsrr') {
    return { Mode: 'dnsrr' };
  }
  if (service.ports?.length) {
    return {
      Mode: 'vip',
      Ports: service.ports.map(port => ({
        Protocol: port.protocol ?? 'tcp',
        PublishedPort: port.publishedPort,
        TargetPort: port.targetPort,
        PublishMode: 'host',
      })),
    };
  }
  return undefined;
}

export function compileHealthCheck(healthcheck?: ServiceHealthcheckConfig): Docker.HealthConfig | undefined {
  if (!healthcheck) return undefined;
  return {
    Test: ['CMD', ...healthcheck.command],
    Interval: (healthcheck.intervalSeconds ?? 30) * 1e9,
    Timeout: (healthcheck.timeoutSeconds ?? 5) * 1e9,
    Retries: healthcheck.retries ?? 3,
    StartPeriod: (healthcheck.startPeriodSeconds ?? 0) * 1e9,
  };
}

export function compileUpdateConfig(service: Pick<Service, 'deploymentStrategy'>, isStateful: boolean): Docker.UpdateConfig {
  const strategy = service.deploymentStrategy;
  return {
    Parallelism: isStateful ? 1 : (strategy?.parallelism ?? 1),
    Order: isStateful ? 'stop-first' : (strategy?.order ?? 'start-first'),
    FailureAction: strategy?.failureAction ?? 'rollback',
    Monitor: (strategy?.monitorSeconds ?? 15) * 1e9,
  };
}
