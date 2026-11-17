import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

export function ReleaseNotes({tag}:{tag:string}) {
  const notes=useQuery({queryKey:['release-notes',tag],queryFn:()=>api<{tag:string;notes:string|null}>(`/updates/release-notes/${encodeURIComponent(tag)}`),retry:false,staleTime:300_000});
  return <section aria-label="Release notes">
    <h3>Changes in {tag}</h3>
    {notes.isPending?<p role="status">Loading release notes...</p>:notes.error?<p role="alert">Could not load release notes. <button className="button button-small" type="button" onClick={()=>void notes.refetch()}>Try again</button></p>:notes.data?.notes?<pre className="release-notes-text">{notes.data.notes}</pre>:<p>No release notes are published for this version.</p>}
    <p><a href={`https://github.com/raxon/servus/releases/tag/${encodeURIComponent(tag)}`} target="_blank" rel="noreferrer">View release on GitHub</a></p>
  </section>;
}
