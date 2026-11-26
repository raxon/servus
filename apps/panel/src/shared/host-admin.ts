export interface DockerImageSummary {
  id: string;
  tags: string[];
  sizeBytes: number;
  inUse: boolean;
  createdAt: string;
}

export interface DockerDiskUsage {
  sampledAt: string;
  images: {
    count: number;
    totalSizeBytes: number;
    reclaimableBytes: number;
    items: DockerImageSummary[];
  };
  containers: {
    count: number;
    runningCount: number;
    stoppedCount: number;
    totalSizeBytes: number;
    reclaimableBytes: number;
  };
  volumes: {
    count: number;
    activeCount: number;
    totalSizeBytes: number;
  };
  buildCache: {
    count: number;
    totalSizeBytes: number;
    reclaimableBytes: number;
  };
  totalBytes: number;
  totalReclaimableBytes: number;
}

export interface DockerPruneRequest {
  danglingImages?: boolean;
  unusedImages?: boolean;
  buildCache?: boolean;
  stoppedContainers?: boolean;
}

export interface DockerPruneResult {
  imagesDeleted: number;
  containersDeleted: number;
  buildCacheReclaimedBytes: number;
  totalReclaimedBytes: number;
  completedAt: string;
}

export interface HostAuditEvent {
  id: string;
  operation: string;
  resourceId: string;
  actorId: string;
  actorEmail: string | null;
  createdAt: string;
}

export interface HostExecResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface SourceUploadRecord {
  id: string;
  projectId: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}
