import { Queue, UnrecoverableError } from 'bullmq';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ReportsService } from '../src/modules/reports/reports.service';
import { ProjectsService } from '../src/modules/projects/services/projects.service';
import { ProjectReportData, ProjectReportResult } from '../src/modules/reports/report.types';
import { ProjectReportWorker } from '../src/modules/reports/report.worker';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

const result: ProjectReportResult = {
  project: { id: 'project-a', name: 'Example' }, generatedAt: '2026-01-01T00:00:00.000Z',
  totalTasks: 3, byStatus: { todo: 2, done: 1 }, byPriority: { high: 1, medium: 2 }, completionPercent: 33,
};
function job(state = 'waiting', extra: Record<string, unknown> = {}) {
  return {
    id: 'job-a', data: { projectId: 'project-a', organizationId: 'org-a', requestedBy: 'user-a' },
    getState: jest.fn().mockResolvedValue(state), progress: 0, attemptsMade: 0, opts: { attempts: 3 },
    timestamp: 1, processedOn: undefined, finishedOn: undefined, returnvalue: null,
    failedReason: 'private database connection details', stacktrace: ['private stack'], ...extra,
  };
}

describe('project report submission and access', () => {
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let projects: { findOne: jest.Mock };
  let service: ReportsService;
  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue({}), getJob: jest.fn() };
    projects = { findOne: jest.fn().mockResolvedValue({ id: 'project-a' }) };
    service = new ReportsService(queue as unknown as Queue<ProjectReportData, ProjectReportResult>, projects as unknown as ProjectsService);
  });

  it('authorizes the project before enqueueing only trusted context and a bounded retry policy', async () => {
    const submitted = await service.submit('project-a', 'org-a', 'user-a');
    expect(projects.findOne).toHaveBeenCalledWith('project-a', 'org-a');
    expect(submitted.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(submitted).not.toHaveProperty('state');
    expect(queue.add).toHaveBeenCalledWith('project-summary', {
      projectId: 'project-a', organizationId: 'org-a', requestedBy: 'user-a',
    }, expect.objectContaining({
      jobId: submitted.id, attempts: 3, backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 604800, count: 1000 },
    }));
  });

  it('does not enqueue an unauthorized or deleted project', async () => {
    projects.findOne.mockRejectedValue(new NotFoundException());
    await expect(service.submit('project-a', 'other-org', 'user-a')).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not leak a queue error on submission', async () => {
    queue.add.mockRejectedValue(new Error('private Redis credential'));
    await expect(service.submit('project-a', 'org-a', 'user-a')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    ['other-project', 'org-a', 'user-a'], ['project-a', 'other-org', 'user-a'], ['project-a', 'org-a', 'other-user'],
  ])('hides report existence for mismatched project/org/requester', async (projectId, orgId, userId) => {
    const privateJob = job('completed', { returnvalue: result });
    queue.getJob.mockResolvedValue(privateJob);
    await expect(service.status(projectId, 'job-a', orgId, userId)).rejects.toBeInstanceOf(NotFoundException);
    expect(privateJob.getState).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('returns 404 for missing or retained-out jobs', async value => {
    queue.getJob.mockResolvedValue(value);
    await expect(service.status('project-a', 'missing', 'org-a', 'user-a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('handles removal during a status read', async () => {
    queue.getJob.mockResolvedValueOnce(job('completed')).mockResolvedValueOnce(undefined);
    await expect(service.status('project-a', 'job-a', 'org-a', 'user-a')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['waiting', 0, 'queued'], ['paused', 0, 'queued'], ['active', 0, 'processing'],
    ['delayed', 1, 'retrying'], ['waiting', 1, 'retrying'], ['completed', 1, 'completed'], ['failed', 3, 'failed'],
  ])('maps real BullMQ state %s and attempts %i to %s', async (state, attemptsMade, expected) => {
    queue.getJob.mockResolvedValue(job(state, { attemptsMade, progress: 40, returnvalue: result }));
    const response = await service.status('project-a', 'job-a', 'org-a', 'user-a');
    expect(response.state).toBe(expected);
    expect(response.progress).toBe(40);
    expect(response.result).toEqual(state === 'completed' ? result : null);
    expect(response.error).toEqual(state === 'failed' ? 'This report could not be generated. Please try again.' : null);
    expect(JSON.stringify(response)).not.toMatch(/private|stacktrace|requestedBy|organizationId/);
  });

  it('reloads the result when a job completes during the status read', async () => {
    queue.getJob.mockResolvedValueOnce(job('completed')).mockResolvedValueOnce(job('completed', { progress: 100, returnvalue: result }));
    expect((await service.status('project-a', 'job-a', 'org-a', 'user-a')).result).toEqual(result);
  });

  it('permits the original requester to read a terminal failure after the project is removed', async () => {
    queue.getJob.mockResolvedValue(job('failed', { attemptsMade: 1 }));
    expect((await service.status('project-a', 'job-a', 'org-a', 'user-a')).state).toBe('failed');
    expect(projects.findOne).not.toHaveBeenCalled();
  });

  it('returns a service-unavailable error when status cannot be read from Redis', async () => {
    queue.getJob.mockRejectedValue(new Error('private Redis details'));
    await expect(service.status('project-a', 'job-a', 'org-a', 'user-a')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not invent a failure state if reading the BullMQ state fails', async () => {
    const value = job();
    value.getState.mockRejectedValue(new Error('private Redis details'));
    queue.getJob.mockResolvedValue(value);
    await expect(service.status('project-a', 'job-a', 'org-a', 'user-a')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns 404 if BullMQ no longer knows the state', async () => {
    queue.getJob.mockResolvedValue(job('unknown'));
    await expect(service.status('project-a', 'job-a', 'org-a', 'user-a')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('report worker failure classification', () => {
  it('does not persist raw SQL errors as queue failures', async () => {
    const privateError = new Error('password=private; SELECT sensitive_schema');
    const database = { transaction: jest.fn().mockRejectedValue(privateError) };
    const worker = new ProjectReportWorker({} as Redis, database as unknown as DataSource);
    const work = { updateProgress: jest.fn().mockResolvedValue(undefined) };
    // Exercise the processor without starting its Redis consumer.
    await expect((worker as any).process(work)).rejects.toThrow('Project summary generation failed.');
  });

  it('preserves permanent errors so BullMQ does not spend retry attempts on removed projects', async () => {
    const error = new UnrecoverableError('Project is no longer available.');
    const database = { transaction: jest.fn().mockRejectedValue(error) };
    const worker = new ProjectReportWorker({} as Redis, database as unknown as DataSource);
    await expect((worker as any).process({ updateProgress: jest.fn() })).rejects.toBe(error);
  });
});
