'use client';

import { Component, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  children: ReactNode;
  className?: string;
}

interface State {
  hasError: boolean;
}

export class AiSummaryErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[AiSummaryErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        className={cn(
          'rounded-lg border border-border border-l-4 border-l-destructive bg-card p-4 shadow-md md:p-6',
          this.props.className,
        )}
        role="region"
        aria-label="AI business summary"
      >
        <div aria-live="assertive">
          <p className="text-sm font-medium text-destructive">
            The analysis could not be displayed.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your data and charts are still available below.
          </p>
        </div>
        <button
          type="button"
          onClick={this.handleReset}
          className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Try again
        </button>
      </div>
    );
  }
}
