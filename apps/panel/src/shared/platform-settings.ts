export type SupportedLocale = 'en' | 'pl';

export interface PlatformBrandingSettings {
  brandName: string;
  accentColor: string;
  logoUrl: string | null;
  defaultLocale: SupportedLocale;
  maintenanceMode: boolean;
  maintenanceTitle: string;
  maintenanceMessage: string;
  customErrorTitle: string;
  customErrorMessage: string;
  updatedAt: string | null;
}

export const DEFAULT_BRANDING: PlatformBrandingSettings = {
  brandName: 'Servus',
  accentColor: '#2563eb',
  logoUrl: null,
  defaultLocale: 'en',
  maintenanceMode: false,
  maintenanceTitle: 'Scheduled maintenance',
  maintenanceMessage: 'This service is temporarily offline for maintenance. Please try again shortly.',
  customErrorTitle: 'Service temporarily unavailable',
  customErrorMessage: 'The upstream application did not respond in time. Please retry in a few moments.',
  updatedAt: null,
};

export interface ProjectExportBundle {
  schemaVersion: 'servus-project-export/v1';
  exportedAt: string;
  servusVersion: string;
  secretsIncluded: boolean;
  project: {
    name: string;
    description: string;
  };
  services: Array<{
    name: string;
    kind: string;
    image: string;
    port: number;
    hostname: string;
    replicas: number;
    source?: unknown;
    environment?: Array<{ name: string; value?: string; secret?: boolean; redacted?: boolean }>;
    domains?: unknown[];
    mounts?: unknown[];
    resources?: { cpu: number; memoryMb: number };
    database?: { database: string; user: string; password?: string };
    ports?: unknown[];
    endpointMode?: 'vip' | 'dnsrr';
    healthcheck?: unknown;
    deploymentStrategy?: unknown;
    notes?: string;
  }>;
  composeWorkloads: Array<{
    name: string;
    configuration: unknown;
  }>;
  projectEnv: Array<{ name: string; value?: string; secret: boolean; redacted?: boolean }>;
  projectScripts: Array<{ name: string; description: string; command: string; serviceName?: string | null }>;
}

export interface ProjectImportResult {
  projectId: string;
  projectName: string;
  importedServices: string[];
  importedCompose: string[];
  importedEnvCount: number;
  importedScriptCount: number;
  warnings: string[];
}

export type BoxRuntimePreset = 'node-22' | 'python-3.12' | 'alpine-tools' | 'ubuntu-24';

export interface DedicatedWordPressResult {
  databaseServiceId: string;
  databaseServiceName: string;
  appServiceId: string;
  appServiceName: string;
  hostname: string;
  actionIds: string[];
}

export interface DedicatedBoxResult {
  serviceId: string;
  serviceName: string;
  preset: BoxRuntimePreset;
  hostname: string;
  actionId: string;
}
