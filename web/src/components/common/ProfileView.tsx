import * as React from "react";
import { Mail, Briefcase, Building2, UserCog, Hash, CalendarDays, Pencil, Plus } from "lucide-react";
import { colorFromString, initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { FieldAccess } from "@/components/access/FieldAccess";
import { CopyEmail } from "@/components/common/CopyEmail";

// Identity header: a brand-gradient cover band with the avatar overlapping it, then the
// name / title · department / email beside it. Shared by the self profile and employee pages.
export function ProfileView({
  name,
  email,
  jobTitle,
  department,
  bio,
  onEditBio,
  avatar,
  actions,
  meta,
}: {
  name: string;
  email?: string;
  jobTitle?: string;
  department?: string;
  // Public "about me" one-liner off the employee record; onEditBio adds the edit/add affordance
  // (owner on /profile, HR on the employee page).
  bio?: string;
  onEditBio?: () => void;
  avatar?: React.ReactNode;
  actions?: React.ReactNode;
  // Chip row under the email line (employee ID, reports-to, direct reports…).
  meta?: React.ReactNode;
}) {
  const seed = name || email || "?";
  const subtitle = [jobTitle, department].filter(Boolean).join(" · ");
  return (
    <Card className="overflow-hidden">
      <div className="brand-gradient h-16 sm:h-20" />
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 pb-4 sm:px-5 sm:pb-5">
        <div className="-mt-8 shrink-0 rounded-full bg-card p-1 shadow-sm">
          {avatar ?? (
            <Avatar className="h-16 w-16">
              <AvatarFallback className="text-lg font-semibold text-white" style={{ backgroundColor: colorFromString(seed) }}>
                {initials(seed)}
              </AvatarFallback>
            </Avatar>
          )}
        </div>
        <div className="min-w-0 flex-1 pt-2">
          <h2 className="truncate text-xl font-semibold leading-tight">{name || email}</h2>
          {subtitle && <p className="mt-0.5 truncate text-sm text-muted-foreground">{subtitle}</p>}
          {email && name && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <CopyEmail email={email} />
            </p>
          )}
          {meta}
          {(bio || onEditBio) && (
            <div className="mt-1.5 max-w-prose text-sm">
              {bio ? (
                <span className="text-foreground/80">
                  {bio}
                  {onEditBio && (
                    <button
                      type="button"
                      onClick={onEditBio}
                      aria-label="Edit bio"
                      className="ml-1.5 inline-flex align-middle text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={onEditBio}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <Plus className="h-3.5 w-3.5" /> Add a short bio
                </button>
              )}
              <FieldAccess field="bio" label="Bio" />
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 pt-2">{actions}</div>}
      </div>
    </Card>
  );
}

// The contact/org detail rows, shown in the Profile tab.
export function ProfileDetails({
  employeeNumber,
  email,
  jobTitle,
  department,
  manager,
  joined,
}: {
  employeeNumber?: string;
  email?: string;
  jobTitle?: string;
  department?: string;
  manager?: string;
  joined?: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {/* Only protected fields (employee_number/department/manager) get FIELD-scope management; the rest manage
          at object scope (the body-field gate only runs on protected fields, so a field grant elsewhere is inert). */}
      <Detail icon={Hash} label="Employee ID" value={employeeNumber} field="employee_number" mono />
      <Detail icon={Mail} label="Work email" value={email ? <CopyEmail email={email} /> : undefined} />
      <Detail icon={Briefcase} label="Job title" value={jobTitle} />
      <Detail icon={Building2} label="Department" value={department} field="department" />
      <Detail icon={UserCog} label="Manager" value={manager} field="manager" />
      {joined !== undefined && <Detail icon={CalendarDays} label="Joined" value={joined} />}
    </div>
  );
}

function Detail({ icon: Icon, label, value, field, mono }: { icon: typeof Mail; label: string; value?: React.ReactNode; field?: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/40">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
          <FieldAccess field={field} label={label} />
        </p>
        <p className={`truncate text-sm font-medium ${mono ? "font-mono" : ""}`}>{value || "-"}</p>
      </div>
    </div>
  );
}
