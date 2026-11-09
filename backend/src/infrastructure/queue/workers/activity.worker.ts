import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { writeFile, rm } from 'node:fs/promises';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis';
import { ActivityService } from '../../../modules/activity/services/activity.service';
import { DomainEvent } from '../../../shared/interfaces';

@Injectable()
export class ActivityWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActivityWorker.name);
  private worker: Worker;
  private heartbeat?: NodeJS.Timeout;
  private checking = false;
  private readonly healthFile = '/tmp/taskforge-worker-health';

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly activityService: ActivityService,
    private readonly database: DataSource,
  ) {}

  async onModuleInit() {
    this.worker = new Worker(
      'activity',
      async (job: Job<DomainEvent>) => {
        const start = Date.now();
        await this.activityService.log(job.data);
        const duration = Date.now() - start;
        this.logger.debug(
          `Job ${job.id} processed: ${job.data.type} (${duration}ms)`,
        );
      },
      {
        connection: this.redis,
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${error.message}`,
      );
    });
    this.worker.on('error', () => {
      this.logger.error('Worker queue connection error; check Redis connectivity');
    });

    await this.worker.waitUntilReady();
    await this.updateHeartbeat();
    this.heartbeat = setInterval(() => void this.updateHeartbeat(), 10000);
    this.heartbeat.unref();

    this.logger.log('Activity worker started (concurrency: 5)');
  }

  async onModuleDestroy() {
    clearInterval(this.heartbeat);
    await rm(this.healthFile, { force: true });
    if (this.worker) {
      this.logger.log('Shutting down activity worker...');
      await this.worker.close();
      this.logger.log('Activity worker stopped');
    }
  }

  private async updateHeartbeat() {
    if (this.checking) return;
    this.checking = true;
    try {
      if (!this.worker.isRunning() || this.worker.isPaused()) return;
      await Promise.all([this.redis.ping(), this.database.query('SELECT 1')]);
      await writeFile(this.healthFile, String(Date.now()), { mode: 0o600 });
    } catch {
      // Leave the old heartbeat stale; the container health check then fails.
    } finally {
      this.checking = false;
    }
  }
}
