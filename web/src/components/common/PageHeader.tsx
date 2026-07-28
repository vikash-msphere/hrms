import * as React from "react";
import { AccessAction } from "@/components/access/AccessAction";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  accessCollection,
}: {
  // Optional small uppercase context line above the title (e.g. the section/workspace this page sits in), so
  // a page reads as situated rather than free-floating.
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  // When set, the page title carries a collection-level access icon (visible in access mode) so the whole
  // page's read/write/admin access can be managed right from its header.
  accessCollection?: string;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{eyebrow}</p>
        )}
        <h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground">
          {accessCollection ? (
            <AccessAction collection={accessCollection} label={title}><span>{title}</span></AccessAction>
          ) : (
            title
          )}
        </h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
