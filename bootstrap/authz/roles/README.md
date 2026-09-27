# Role files

One JSON file per seeded role: the role row (`roles`) and every rule it starts with (`access_rules`). Seed
data only: `bootstrap/authz/grants.ts` loads these, `bootstrap/authz/accessRules.ts` compiles them into rows
for `bootstrap/bootstrap.sql` and `scripts/seed.sql`, and from then on the database rows are the policy,
edited in Access Management. The running app never reads these files. A change here reaches a fresh database
only; a live one needs a migration or an edit in the UI.

| File | Role |
|---|---|
| `everyone.json` | The reserved subject unioned into every caller except super admin. Never assignable. Only what every account needs whatever its role: the app shell (`users/me`, own preferences, own operations, `batch:run`), own notifications, and the assets the caller holds. |
| `employee.json` | The least-privilege baseline, and the role new accounts are given (`provisioned`). |
| `team_lead.json` | `extends: employee`, plus goals and 1:1s for their direct reports (`my-reports`). Decides no requests. |
| `manager.json` | `extends: employee`, plus the department subtree. |
| `hr_admin.json` | `extends: employee`, plus people operations and the HR setting keys. |
| `payroll_admin.json` | `extends: employee`, plus payroll, pay configuration, the payroll setting keys and finance. |
| `super_admin.json` | Break-glass `**`. Must stay exactly `levels ** admin` + `allow **`. |

Settings are granted per key (`settings.<key>`), never `settings.**` write to a role: each key has one owner
(HR's policies, payroll's pay configuration), and the governance switches - `access-approval`,
`access-review`, `payroll-approval`, `sign-in`, `ai`, `attachments` - stay with super admin, so the people they
restrain cannot turn them off. The Settings UI offers each panel to whoever can write what it edits
(`web/src/settings/registry.ts` `settingsEntryVisible`).

## Format

```jsonc
{
  "role": "employee",            // the role name (the roles.name key and the access-rule subject)
  "label": "Employee",           // display label
  "protected": true,             // the management API refuses to delete it
  "provisioned": true,           // given to new accounts; exactly one file sets it
  "description": "...",
  "extends": "employee",         // optional: the parent's rules are unioned in first
  "relies_on": ["..."],          // optional: what this role depends on that lives elsewhere
  "levels":  [{ "area": "leave", "pattern": "leave-requests.me.**", "level": "write", "why": "..." }],
  "allow":   [{ "area": "leave", "pattern": "leave-requests.me.cancel", "why": "..." }],
  "deny":    [{ "pattern": "...", "why": "..." }],
  "excluded": [{ "pattern": "...", "why": "..." }]
}
```

- `levels` are level rules (`read` < `write` < `admin`) on a resource pattern. `allow` are custom-method
  (verb) rules on the full key, `<collection>.<scope>.<verb>` or `<collection>.<verb>` for a collection verb.
  `deny` rules use the verb key shape and always win.
- Scopes: `me` is the caller's own rows, `my-dept` their department subtree, `*` / `**` every row. A bare
  `<collection>` is the list call only; which rows come back is decided by the object rules beside it.
- A level grant carries no custom methods. A verb has to be named in `allow` even where the role already
  writes the row, or its button reaches nobody.
- `excluded` is not rules: patterns deliberately left out, with the reason, so the next reader does not
  "fix" them back in. The generator ignores it. Add `"lane": "allow"` (or `"levels"`) when the pattern is right
  in the other lane - `cards.**` is the board's read-write level and excluded only as a wildcard verb.
  test/roleFiles.test.ts fails if a file grants a pattern it excludes.
- Every rule needs a `why`. The loader refuses a file with a rule without one, a repeated pattern, an unknown
  level, or an `extends` naming no file.
