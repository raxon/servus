import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import type { BuildConcurrencySettings as BuildConcurrencyData } from "../shared/workspace-extras.js";
import { api } from "./api.js";
import { FeatureError, FeatureLoading } from "./feature-ui.js";

export function BuildConcurrencySettings() {
  const id = useId();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["build-concurrency"],
    queryFn: () => api<BuildConcurrencyData>("/settings/build-concurrency"),
  });
  const [limit, setLimit] = useState(1);
  useEffect(() => {
    if (query.data) setLimit(query.data.maxConcurrentBuilds);
  }, [query.data]);
  const save = useMutation({
    mutationFn: (maxConcurrentBuilds: number) =>
      api<BuildConcurrencyData>("/settings/build-concurrency", { method: "PUT", body: { maxConcurrentBuilds } }),
    onSuccess: (data) => {
      setLimit(data.maxConcurrentBuilds);
      void client.invalidateQueries({ queryKey: ["build-concurrency"] });
    },
  });

  return (
    <section id="build-concurrency" className="surface details-card" aria-labelledby="build-concurrency-heading">
      <div className="settings-card-header">
        <div className="settings-card-intro">
          <div className="card-heading">
            <Layers size={19} aria-hidden="true" />
            <h3 id="build-concurrency-heading">Build concurrency</h3>
          </div>
          <p>Limit how many deployments and source builds the worker executes simultaneously (1 to 8). Use 1 on small VPS instances to avoid CPU/RAM contention.</p>
        </div>
        <span className="subtle-count mono">Active jobs: {query.data?.activeJobs ?? 0}</span>
      </div>
      <FeatureError error={query.error || save.error} />
      {query.isPending ? (
        <FeatureLoading label="Loading build concurrency" />
      ) : (
        <form
          className="concurrency-form"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(limit);
          }}
        >
          <div className="servus-field">
            <label htmlFor={`${id}-limit`}>Maximum concurrent builds/deployments</label>
            <div className="concurrency-input-group">
              <input
                id={`${id}-limit`}
                className="servus-input mono"
                type="number"
                min={1}
                max={8}
                disabled={save.isPending}
                value={limit}
                onChange={(e) => setLimit(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
              />
              <span className="servus-help">Allowed range: 1 - 8 parallel worker slots</span>
            </div>
          </div>
          <button type="submit" className="button button-primary" disabled={save.isPending}>
            {save.isPending ? "Saving..." : save.isSuccess ? "Saved" : "Save concurrency limit"}
          </button>
        </form>
      )}
    </section>
  );
}
