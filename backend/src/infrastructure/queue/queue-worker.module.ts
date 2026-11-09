import { Module } from '@nestjs/common';
import { QueueProducerModule } from './queue-producer.module';
import { ActivityWorker } from './workers/activity.worker';
import { ActivityModule } from '../../modules/activity/activity.module';
import { ProjectReportWorker } from '../../modules/reports/report.worker';
import { WorkerHealthService } from './worker-health.service';

@Module({
  imports: [ActivityModule, QueueProducerModule],
  providers: [ActivityWorker, ProjectReportWorker, WorkerHealthService],
})
export class QueueWorkerModule {}
