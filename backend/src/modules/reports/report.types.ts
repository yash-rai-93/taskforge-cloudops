export interface ProjectReportData {
  projectId: string;
  organizationId: string;
  requestedBy: string;
}

export interface ProjectReportResult {
  project: { id: string; name: string };
  generatedAt: string;
  totalTasks: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  completionPercent: number;
}

export type ReportState = 'queued' | 'processing' | 'retrying' | 'completed' | 'failed';

export interface ProjectReportStatus {
  id: string;
  projectId: string;
  state: ReportState;
  progress: number;
  attemptsMade: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: ProjectReportResult | null;
  error: string | null;
}
