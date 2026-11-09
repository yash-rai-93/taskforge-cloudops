export const QUEUE_SERVICE = 'QUEUE_SERVICE';

export interface IQueueService {
  addJob<T>(name: string, data: T, opts?: JobOptions): Promise<void>;
}

export interface JobOptions {
  jobId?: string;
  delay?: number;
  attempts?: number;
  priority?: number;
}
