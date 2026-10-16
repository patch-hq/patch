// JobMenuItem — the ⋯ menu entry of a chat a job created, opening that job
// (spec/14 § Main chat panel — Job link). Names the job: `Run by "x" job`.
//
// `jobId` is set once at spawn (spec/08 § Action) and never changes. Chats no
// job created have no entry. A header row of its own was too much chrome.

import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Zap } from 'lucide-react';
import type { Job } from '@patch/wire/jobs';
import { api } from '../api/rest.js';

export function JobMenuItem({ jobId, onDone }: { jobId: string; onDone: () => void }): JSX.Element {
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
    <button
      type="button"
      className="head-menu-item"
      data-testid="job-bar-link"
      role="menuitem"
      title="Open job"
      onClick={() => {
        onDone();
        navigate(`/jobs/${jobId}`);
      }}
    >
      <Zap size={14} aria-hidden />
      {label}
    </button>
  );
}
