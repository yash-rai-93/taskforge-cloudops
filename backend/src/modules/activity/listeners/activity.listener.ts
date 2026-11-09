import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent } from '../../../shared/interfaces/domain-event.interface';
import { QUEUE_SERVICE, IQueueService } from '../../../infrastructure/queue/queue.interface';

/**
 * Activity persistence is owned by the dedicated BullMQ worker.
 */
@Injectable()
export class ActivityListener {
  constructor(@Inject(QUEUE_SERVICE) private readonly queue: IQueueService) {}

  private async enqueue(event: DomainEvent) {
    const eventId = event.eventId ?? randomUUID();
    await this.queue.addJob(event.type, { ...event, eventId }, { jobId: eventId });
  }

  @OnEvent('task.*')
  async handleTaskEvent(event: DomainEvent) {
    await this.enqueue(event);
  }

  @OnEvent('project.*')
  async handleProjectEvent(event: DomainEvent) {
    await this.enqueue(event);
  }

  @OnEvent('member.*')
  async handleMemberEvent(event: DomainEvent) {
    await this.enqueue(event);
  }

  @OnEvent('organization.*')
  async handleOrgEvent(event: DomainEvent) {
    await this.enqueue(event);
  }

  @OnEvent('invite.*')
  async handleInviteEvent(event: DomainEvent) {
    await this.enqueue(event);
  }

  @OnEvent('user.*')
  async handleUserEvent(event: DomainEvent) {
    await this.enqueue(event);
  }
}
