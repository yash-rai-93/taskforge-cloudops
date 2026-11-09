import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job, UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.module';
import { PROJECT_REPORT_QUEUE_NAME } from '../../infrastructure/queue/queue.constants';
import { Project } from '../projects/entities/project.entity';
import { Task } from '../tasks/entities/task.entity';
import { ProjectReportData, ProjectReportResult } from './report.types';

@Injectable()
export class ProjectReportWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectReportWorker.name);
  private worker?: Worker<ProjectReportData, ProjectReportResult>;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis, private readonly database: DataSource) {}

  async onModuleInit() {
    this.worker = new Worker<ProjectReportData, ProjectReportResult>(PROJECT_REPORT_QUEUE_NAME, job => this.process(job), {
      connection: this.redis, concurrency: 2,
    });
    this.worker.on('error', () => this.logger.error('Report queue connection error; check Redis connectivity'));
    this.worker.on('completed', job => this.logger.log(`Report ${job.id} completed`));
    this.worker.on('failed', job => this.logger.warn(`Report ${job?.id} failed attempt ${job?.attemptsMade}; see queue status`));
    await this.worker.waitUntilReady();
    this.logger.log('Project report worker ready (concurrency: 2)');
  }

  isReady(): boolean { return !!this.worker?.isRunning() && !this.worker.isPaused(); }

  async onModuleDestroy() { await this.worker?.close(); }

  private async process(job: Job<ProjectReportData, ProjectReportResult>): Promise<ProjectReportResult> {
    try {
      await job.updateProgress(10);
      const result = await this.database.transaction('REPEATABLE READ', async manager => {
        // Bound both a slow aggregation and lock waits, without artificial work delays.
        await manager.query("SET LOCAL statement_timeout = '15s'");
        const project = await manager.getRepository(Project).findOneBy({
          id: job.data.projectId, organizationId: job.data.organizationId,
        });
        if (!project) throw new UnrecoverableError('Project is no longer available.');
        await job.updateProgress(40);
        const rows = await manager.getRepository(Task).createQueryBuilder('task')
          .select('task.status', 'status').addSelect('task.priority', 'priority').addSelect('COUNT(*)', 'count')
          .where('task.projectId = :projectId AND task.organizationId = :organizationId', job.data)
          .groupBy('task.status').addGroupBy('task.priority')
          .getRawMany<{ status: string; priority: string; count: string }>();
        await job.updateProgress(80);
        const byStatus: Record<string, number> = { todo: 0, in_progress: 0, done: 0 };
        const byPriority: Record<string, number> = { low: 0, medium: 0, high: 0, urgent: 0 };
        let totalTasks = 0;
        for (const row of rows) {
          const count = Number(row.count);
          totalTasks += count;
          byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
          byPriority[row.priority] = (byPriority[row.priority] ?? 0) + count;
        }
        return {
          project: { id: project.id, name: project.name }, generatedAt: new Date().toISOString(), totalTasks,
          byStatus, byPriority, completionPercent: totalTasks ? Math.round(byStatus.done / totalTasks * 100) : 0,
        };
      });
      await job.updateProgress(100);
      return result;
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      // BullMQ persists this sanitized reason and retries; do not persist SQL/credentials.
      throw new Error('Project summary generation failed.');
    }
  }
}
