import { apiClient } from '@/lib/api/client';
import { ApiError, type ApiResponse } from '@/types';

export interface ProjectSummary {
  project: { id: string; name: string };
  generatedAt: string;
  totalTasks: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  completionPercent: number;
}

export interface ReportStatus {
  id: string;
  projectId: string;
  state: 'queued' | 'processing' | 'retrying' | 'completed' | 'failed';
  progress: number;
  attemptsMade: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: ProjectSummary | null;
  error: string | null;
}

export const reportsApi = {
  async submit(projectId: string) {
    try {
      const response = await apiClient.post<ApiResponse<{ id: string; projectId: string; statusUrl: string }>>(`/projects/${projectId}/reports`);
      if (!response.data.data) throw new Error('Report response was empty.');
      return response.data.data;
    } catch (error) { throw ApiError.from(error); }
  },
  async status(projectId: string, id: string) {
    try {
      const response = await apiClient.get<ApiResponse<ReportStatus>>(`/projects/${projectId}/reports/${id}`);
      if (!response.data.data) throw new Error('Report status was empty.');
      return response.data.data;
    } catch (error) { throw ApiError.from(error); }
  },
};
