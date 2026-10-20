// JobBar — the banner under the header of a chat a job created, opening that
// job (spec/14 § Main chat panel — Job bar). Names the job: `Run by "x" job`.
//
// `jobId` is set once at spawn (spec/08 § Action) and never changes. Chats no
// job created have no bar.

import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Zap } from 'lucide-react';
import type { Job } from '@patch/wire/jobs';
import { api } from '../api/rest.js';

export function JobBar({ jobId }: { jobId: string }): JSX.Element {
  const navigate = useNavigate();
  const { data, error } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.getJob(jobId) as Promise<Job>,
  });
  const label = error
    ? `Failed to load job: ${(error as Error).message}`
    : data
      ? `Run by "${data.name}" job`
      : 'Loading job…';
  return (
    <div className="archived-banner" data-testid="job-bar" role="status">
      <span className="archived-banner-label">
        <Zap size={14} aria-hidden />
        {label}
      </span>
      <button
        type="button"
        className="archived-unarchive-btn"
        data-testid="job-bar-link"
        title="Open job"
        onClick={() => navigate(`/jobs/${jobId}`)}
      >
        Open job
      </button>
    </div>
  );
}
