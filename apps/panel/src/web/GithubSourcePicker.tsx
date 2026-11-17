import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { FeatureError, FeatureLoading } from './feature-ui.js';
import './github-source-picker.css';

interface GithubRepository { owner: string; name: string; fullName: string; defaultBranch: string; private: boolean }
interface RepositoryPage { repositories: GithubRepository[]; page: number; nextPage: number | null }
interface BranchPage { branches: string[]; page: number; nextPage: number | null }

/** Optional browsing complements the manual repository and ref inputs. */
export function GithubSourcePicker({ repository, branch, disabled = false, onChange }: {
  repository: string; branch: string; disabled?: boolean;
  onChange: (selection: { repository: string; branch: string }) => void;
}) {
  const id = useId(), [open, setOpen] = useState(false), [page, setPage] = useState(1);
  const [branchPagination, setBranchPagination] = useState({ repository, page: 1 });
  const branchPage = branchPagination.repository === repository ? branchPagination.page : 1;
  const repositoryValid = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository);
  const repositories = useQuery({
    queryKey: ['github-repositories', page], enabled: open && !disabled, retry: false,
    queryFn: ({ signal }) => api<RepositoryPage>(`/integrations/github/repositories?page=${page}`, { signal }),
  });
  const branches = useQuery({
    queryKey: ['github-branches', repository, branchPage], enabled: open && !disabled && repositoryValid, retry: false,
    queryFn: ({ signal }) => api<BranchPage>(`/integrations/github/repositories/${repository.split('/').map(encodeURIComponent).join('/')}/branches?page=${branchPage}`, { signal }),
  });
  const items = repositories.data?.repositories ?? [], refs = branches.data?.branches ?? [];
  return <div className="source-build-advanced github-source-picker">
    <button type="button" className="button" disabled={disabled} aria-expanded={open} aria-controls={`${id}-picker`} onClick={() => setOpen(value => !value)}>
      {open ? 'Hide GitHub browser' : 'Browse GitHub repositories'}
    </button>
    {open ? <div id={`${id}-picker`}>
      <p>Choose a repository and branch, or enter them manually in the fields below. Choosing an item does not deploy it.</p>
      <div className="form-grid">
        <div aria-busy={repositories.isFetching}>
          <label htmlFor={`${id}-repository`}>Available GitHub repositories
          <select id={`${id}-repository`} name="github-repository-picker" value={repository} disabled={disabled || repositories.isFetching || Boolean(repositories.error)} onChange={event => {
            const item = items.find(entry => entry.fullName === event.target.value);
            if (item) { setBranchPagination({ repository: item.fullName, page: 1 }); onChange({ repository: item.fullName, branch: item.defaultBranch }); }
          }}>
            {!repository ? <option value="">Choose a repository</option> : !items.some(item => item.fullName === repository) ? <option value={repository}>Current: {repository}</option> : null}
            {items.map(item => <option key={item.fullName} value={item.fullName}>{item.fullName}{item.private ? ' (private)' : ''}</option>)}
          </select>
          </label>
          {repositories.isFetching ? <FeatureLoading label="Loading repositories" /> : repositories.isSuccess && items.length === 0 ? <p>No repositories are available on this page.</p> : null}
          <FeatureError error={repositories.error} />
          {repositories.error ? <button type="button" className="button" onClick={() => void repositories.refetch()}>Retry repository list</button> : null}
          <div className="heading-actions">
            <button type="button" className="button" aria-label="Previous repositories" disabled={page === 1 || repositories.isFetching} onClick={() => setPage(value => value - 1)}>Previous</button>
            <span>Page {page}</span>
            <button type="button" className="button" aria-label="Next repositories" disabled={!repositories.data?.nextPage || repositories.isFetching} onClick={() => setPage(repositories.data!.nextPage!)}>Next</button>
          </div>
        </div>
        <div aria-busy={branches.isFetching}>
          <label htmlFor={`${id}-branch`}>Available GitHub branches
          <select id={`${id}-branch`} name="github-branch-picker" value={branch} disabled={disabled || !repositoryValid || branches.isFetching || Boolean(branches.error)} onChange={event => onChange({ repository, branch: event.target.value })}>
            {!branch ? <option value="">Choose a branch</option> : !refs.includes(branch) ? <option value={branch}>Current: {branch}</option> : null}
            {refs.map(ref => <option key={ref} value={ref}>{ref}</option>)}
          </select>
          </label>
          {branches.isFetching ? <FeatureLoading label="Loading branches" /> : !repositoryValid ? <p>Choose or enter a repository to load its branches.</p> : branches.isSuccess && refs.length === 0 ? <p>No branches are available on this page.</p> : null}
          <FeatureError error={branches.error} />
          {branches.error ? <button type="button" className="button" onClick={() => void branches.refetch()}>Retry branch list</button> : null}
          <div className="heading-actions">
            <button type="button" className="button" aria-label="Previous branches" disabled={branchPage === 1 || branches.isFetching || !repositoryValid} onClick={() => setBranchPagination({ repository, page: branchPage - 1 })}>Previous</button>
            <span>Page {branchPage}</span>
            <button type="button" className="button" aria-label="Next branches" disabled={!branches.data?.nextPage || branches.isFetching || !repositoryValid} onClick={() => setBranchPagination({ repository, page: branches.data!.nextPage! })}>Next</button>
          </div>
        </div>
      </div>
    </div> : <div id={`${id}-picker`} hidden />}
  </div>;
}
