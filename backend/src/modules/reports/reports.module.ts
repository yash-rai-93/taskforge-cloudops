import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { QueueProducerModule } from '../../infrastructure/queue/queue-producer.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ imports: [ProjectsModule, QueueProducerModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
