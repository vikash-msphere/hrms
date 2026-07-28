import * as React from "react";
import { type LucideIcon, Inbox } from "lucide-react";
import { type Illustration, illustrationSrc } from "@/lib/illustrations";

export function EmptyState({
  icon: Icon = Inbox,
  illustration,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  // Prefer an illustration on the page-level zero state a user is likely to meet first (a brand-new
  // module, no search results); the icon stays right for small in-card and in-tab emptiness.
  illustration?: Illustration;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 px-6 py-16 text-center">
      {illustration ? (
        <img
          src={illustrationSrc(illustration)}
          alt=""
          aria-hidden
          loading="lazy"
          className="mb-6 h-32 w-auto max-w-[15rem] opacity-90 sm:h-40"
        />
      ) : (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Icon className="h-6 w-6" />
        </div>
      )}
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
