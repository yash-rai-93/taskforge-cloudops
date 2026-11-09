import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { writeFile, rm } from 'node:fs/promises';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ActivityWorker } from './workers/activity.worker';
import { ProjectReportWorker } from '../../modules/reports/report.worker';

@Injectable()
export class WorkerHealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private checking = false;
  private closing = false;
  private readonly file = '/tmp/taskforge-worker-health';

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly database: DataSource,
    private readonly activity: ActivityWorker,
    private readonly reports: ProjectReportWorker,
  ) {}

  async onApplicationBootstrap() {
    await this.check();
    this.timer = setInterval(() => void this.check(), 10000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.closing = true;
    clearInterval(this.timer);
    await rm(this.file, { force: true });
  }

  private async check() {
    if (this.checking || this.closing) return;
    this.checking = true;
    try {
      if (!this.activity.isReady() || !this.reports.isReady()) return;
      await Promise.all([this.redis.ping(), this.database.query('SELECT 1')]);
      if (!this.closing) await writeFile(this.file, String(Date.now()), { mode: 0o600 });
    } catch {
      // An unhealthy consumer or dependency leaves the heartbeat stale.
    } finally { this.checking = false; }
  }
}
