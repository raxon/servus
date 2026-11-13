import { Component, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { FeatureError } from "./feature-ui.js";

export class TerminalBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      error:
        error instanceof Error ? error : new Error("Terminal failed to load."),
    };
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <section className="surface console-card">
        <div className="feature-panel-heading">
          <div>
            <h2>Terminal unavailable</h2>
            <p>
              The terminal could not load or initialize. Reload the application
              to load the current version.
            </p>
          </div>
        </div>
        <FeatureError error={this.state.error} />
        <button
          className="button button-primary"
          type="button"
          onClick={() => window.location.reload()}
        >
          <RefreshCw size={16} />
          Reload application
        </button>
      </section>
    );
  }
}
