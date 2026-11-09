'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth.store';
import { ApiError } from '@/types';
import { reportsApi, type ReportStatus } from './reports.api';

const labels: Record<ReportStatus['state'], string> = {
  queued: 'Queued', processing: 'Processing', retrying: 'Retrying', completed: 'Completed', failed: 'Failed',
};

export function ProjectReportPanel({ projectId }: { projectId: string }) {
  const userId = useAuthStore(s => s.user?.id);
  const orgId = useAuthStore(s => s.currentOrganizationId);
  const storageKey = userId && orgId ? `project-report:${userId}:${orgId}:${projectId}` : '';
  const [selected, setSelected] = useState<{ key: string; id: string } | null>(null);
  const id = selected?.key === storageKey ? selected.id : null;

  useEffect(() => {
    let saved: string | null = null;
    try { saved = storageKey ? sessionStorage.getItem(storageKey) : null; } catch { /* memory-only fallback */ }
    setSelected(saved && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(saved) ? { key: storageKey, id: saved } : null);
  }, [storageKey]);

  const status = useQuery({
    queryKey: ['project-report', orgId, userId, projectId, id],
    queryFn: () => reportsApi.status(projectId, id!),
    enabled: !!id && !!storageKey,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: query => {
      const state = query.state.data?.state;
      if (state === 'completed' || state === 'failed') return false;
      if (query.state.error instanceof ApiError && query.state.error.status === 404) return false;
      return 2000;
    },
  });
  const submit = useMutation({
    mutationFn: () => reportsApi.submit(projectId),
    onSuccess: job => {
      setSelected({ key: storageKey, id: job.id });
      try { sessionStorage.setItem(storageKey, job.id); } catch { /* result remains available in memory */ }
    },
  });
  const report = status.data;
  const expired = status.error instanceof ApiError && status.error.status === 404;
  const busy = !!id && !expired && (!report || !['completed', 'failed'].includes(report.state));
  const summary = report?.state === 'completed' ? report.result : null;
  const label = expired ? 'Generate summary' : report?.state === 'failed' ? 'Try again' : summary ? 'Generate again' : 'Generate summary';

  return (
    <section aria-label="Project summary" className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900">Project summary</h2>
          <p className="mt-1 text-sm text-neutral-500">Generate a point-in-time summary of this project&apos;s tasks.</p>
        </div>
        <Button size="sm" disabled={!storageKey || busy || submit.isPending} loading={submit.isPending} onClick={() => submit.mutate()}>
          {label}
        </Button>
      </div>

      <p role="status" aria-live="polite" data-testid="report-state" className="mt-4 text-sm font-medium text-neutral-800">
        {submit.isPending ? 'Submitting request…' : expired ? 'Report unavailable or expired' : report ? labels[report.state] : id ? 'Loading job status…' : 'No summary generated yet'}
      </p>
      {report && !expired && ['queued', 'processing', 'retrying'].includes(report.state) && (
        <div className="mt-2 text-sm text-neutral-600">
          <progress aria-label="Report progress" max={100} value={report.progress} className="h-2 w-full accent-primary-600" />
          <p>{report.state === 'queued' ? 'Waiting for a worker. Your request will be processed when one is available.' : report.state === 'retrying' ? `Retrying automatically: ${report.attemptsMade} of ${report.maxAttempts} attempts used.` : `Worker progress: ${report.progress}%`}</p>
        </div>
      )}
      {report?.state === 'failed' && <p role="alert" className="mt-2 text-sm text-red-600">{report.error} Attempts used: {report.attemptsMade} of {report.maxAttempts}.</p>}
      {submit.error && <p role="alert" className="mt-2 text-sm text-red-600">{submit.error.message}</p>}
      {status.error && <div className="mt-2 text-sm text-red-600" role="alert">
        {expired ? 'Generate a new summary to continue.' : 'Could not load the latest status. Your job has not been cancelled.'}
        {!expired && <Button variant="secondary" size="sm" className="ml-2" onClick={() => void status.refetch()}>Check status</Button>}
      </div>}
      {summary && !expired && <div className="mt-4">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-neutral-500">Total tasks</dt><dd data-testid="report-total" className="text-xl font-semibold">{summary.totalTasks}</dd></div>
          <div><dt className="text-neutral-500">Completed tasks</dt><dd data-testid="report-done" className="text-xl font-semibold">{summary.byStatus.done ?? 0}</dd></div>
          <div><dt className="text-neutral-500">Task completion</dt><dd className="text-xl font-semibold">{summary.completionPercent}%</dd></div>
          <div><dt className="text-neutral-500">High / urgent priority</dt><dd className="text-xl font-semibold">{(summary.byPriority.high ?? 0) + (summary.byPriority.urgent ?? 0)}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-neutral-500">Generated {new Date(summary.generatedAt).toLocaleString()}. Generate again after changing tasks.</p>
      </div>}
    </section>
  );
}
