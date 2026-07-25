import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  children?: ReactNode;
}

/**
 * Generic placeholder for "nothing to show here" states. Deliberately has no
 * overview- or site-page-specific copy baked in — callers supply the title
 * and description, so this can be reused wherever a section has no data.
 */
export default function EmptyState({ title, description, children }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 py-6 text-center">
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description ? <p className="text-xs text-muted-foreground/70">{description}</p> : null}
      {children}
    </div>
  );
}
