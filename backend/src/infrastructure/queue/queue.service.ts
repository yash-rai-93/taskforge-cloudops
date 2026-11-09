import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { IQueueService, JobOptions } from './queue.interface';

export const ACTIVITY_QUEUE = 'ACTIVITY_QUEUE';
export const NOTIFICATIONS_QUEUE = 'NOTIFICATIONS_QUEUE';

@Injectable()
export class QueueService implements IQueueService, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @Inject(ACTIVITY_QUEUE) private readonly activityQueue: Queue,
    @Inject(NOTIFICATIONS_QUEUE) private readonly notificationsQueue: Queue,
  ) {}

  async addJob<T>(name: string, data: T, opts?: JobOptions): Promise<void> {
    const queue = this.resolveQueue(name);

    await queue.add(name, data, {
      jobId: opts?.jobId,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 604800, count: 1000 },
      delay: opts?.delay,
      attempts: opts?.attempts ?? 3,
      priority: opts?.priority,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    });

    this.logger.debug(`Job enqueued: ${name}`);
  }

  private resolveQueue(name: string): Queue {
    if (name.startsWith('notification')) return this.notificationsQueue;
    return this.activityQueue;
  }

  async onModuleDestroy() {
    await Promise.all([this.activityQueue.close(), this.notificationsQueue.close()]);
  }
}
