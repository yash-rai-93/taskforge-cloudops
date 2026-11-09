import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Queue, Job, JobState } from 'bullmq';
import { PROJECT_REPORT_QUEUE } from '../../infrastructure/queue/queue.constants';
import { ProjectsService } from '../projects/services/projects.service';
import { ProjectReportData, ProjectReportResult, ProjectReportStatus, ReportState } from './report.types';

type ReportJob = Job<ProjectReportData, ProjectReportResult>;

@Injectable()
export class ReportsService {
  constructor(
    @Inject(PROJECT_REPORT_QUEUE) private readonly queue: Queue<ProjectReportData, ProjectReportResult>,
    private readonly projects: ProjectsService,
  ) {}

  async submit(projectId: string, organizationId: string, userId: string) {
    // Only IDs derived from the authenticated organization context enter the queue.
    await this.projects.findOne(projectId, organizationId);
    const id = randomUUID();
    try {
      await this.queue.add('project-summary', { projectId, organizationId, requestedBy: userId }, {
        jobId: id, attempts: 3, backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 1000 },
      });
    } catch {
      throw new ServiceUnavailableException('The report queue is temporarily unavailable. Please retry.');
    }
    // No optimistic queue state: the caller reads the real state via statusUrl.
    return { id, projectId, statusUrl: `/api/v1/projects/${projectId}/reports/${id}` };
  }

  async status(projectId: string, id: string, organizationId: string, userId: string): Promise<ProjectReportStatus> {
    const job = await this.loadOwned(id, projectId, organizationId, userId);
    let state: JobState | 'unknown';
    try { state = await job.getState(); }
    catch { throw new ServiceUnavailableException('Report status is temporarily unavailable.'); }
    if (state === 'unknown') throw new NotFoundException('Report not found or expired.');
    // Completion and returnvalue are stored atomically by BullMQ. Reload after
    // reading state so a fast completion cannot return a stale, empty result.
    const current = await this.loadOwned(id, projectId, organizationId, userId);
    return {
      id, projectId, state: this.publicState(state, current.attemptsMade),
      progress: typeof current.progress === 'number' ? Math.max(0, Math.min(100, current.progress)) : 0,
      attemptsMade: current.attemptsMade, maxAttempts: current.opts.attempts ?? 1,
      createdAt: new Date(current.timestamp).toISOString(),
      startedAt: current.processedOn ? new Date(current.processedOn).toISOString() : null,
      finishedAt: current.finishedOn ? new Date(current.finishedOn).toISOString() : null,
      result: state === 'completed' ? current.returnvalue : null,
      // Never expose database errors, stack traces, queue connection data or job payloads.
      error: state === 'failed' ? 'This report could not be generated. Please try again.' : null,
    };
  }

  private async loadOwned(id: string, projectId: string, organizationId: string, userId: string): Promise<ReportJob> {
    let job: ReportJob | undefined;
    try { job = await this.queue.getJob(id); }
    catch { throw new ServiceUnavailableException('Report status is temporarily unavailable.'); }
    if (!job || job.data.projectId !== projectId || job.data.organizationId !== organizationId || job.data.requestedBy !== userId) {
      throw new NotFoundException('Report not found or expired.');
    }
    return job;
  }

  private publicState(state: JobState, attemptsMade: number): ReportState {
    if (state === 'completed' || state === 'failed') return state;
    if (state === 'active') return 'processing';
    if (state === 'delayed' || attemptsMade > 0) return 'retrying';
    return 'queued';
  }
}
