import * as React from "react";
import { Mail, Briefcase, Building2, UserCog, Hash } from "lucide-react";
import { colorFromString, initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { FieldAccess } from "@/components/access/FieldAccess";

// Identity header: a compact card with the avatar and the name / title · department beside it.
export function ProfileView({
  name,
  email,
  jobTitle,
  department,
  avatar,
  actions,
}: {
  name: string;
  email?: string;
  jobTitle?: string;
  department?: string;
  avatar?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const seed = name || email || "?";
  const subtitle = [jobTitle, department].filter(Boolean).join(" · ");
  return (
    <Card className="flex items-center gap-4 p-4">
      {avatar ?? (
        <Avatar className="h-14 w-14 shrink-0">
          <AvatarFallback className="text-lg font-semibold text-white" style={{ backgroundColor: colorFromString(seed) }}>
            {initials(seed)}
          </AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold">{name || email}</h2>
        {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
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
}: {
  employeeNumber?: string;
  email?: string;
  jobTitle?: string;
  department?: string;
  manager?: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {/* Only protected fields (employee_number/department/manager) get FIELD-scope management; the rest manage
          at object scope (the body-field gate only runs on protected fields, so a field grant elsewhere is inert). */}
      <Detail icon={Hash} label="Employee ID" value={employeeNumber} field="employee_number" mono />
      <Detail icon={Mail} label="Work email" value={email} />
      <Detail icon={Briefcase} label="Job title" value={jobTitle} />
      <Detail icon={Building2} label="Department" value={department} field="department" />
      <Detail icon={UserCog} label="Manager" value={manager} field="manager" />
    </div>
  );
}

function Detail({ icon: Icon, label, value, field, mono }: { icon: typeof Mail; label: string; value?: string; field?: string; mono?: boolean }) {
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
