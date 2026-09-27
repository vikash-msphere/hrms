// The day-one role set, seeded once into `roles`, read from the role files (bootstrap/authz/roles/*.json).
// SEED DATA ONLY: after that the rows are the role set, and Access Management adds, relabels and removes roles.
// The running app never imports this file.
//
// `protected`: the management API refuses to delete it (lockout guard). `provisioned`: the role a new account
// is given on hire and at first sign-in - at most one role carries it (a partial unique index enforces that).
import { ROLE_FILES } from "./grants";

export type SeedRole = { name: string; label: string; protected: boolean; provisioned: boolean };

export const ROLES: readonly SeedRole[] = ROLE_FILES.map((f) => ({ name: f.role, label: f.label, protected: f.protected, provisioned: f.provisioned }));
