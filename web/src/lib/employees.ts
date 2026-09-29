import type { Employee } from "@/types";

// WHO IS STILL HERE, as one client-side rule - the twin of `isLiveEmployee` in src/services/liveEmployee.ts,
// which the server's own rosters use. Keep the two saying the same thing.
//
// Three fields, because each way out of the company sets a different one: the soft delete stamps
// `delete_time`, the Disable action sets `disabled`, and an exit (offboarding completed, notice marked exited,
// or the nightly sweep after the last working day) sets `status: "terminated"` along with `disabled`.
//
// For ROSTERS - the directory, the org chart, a team list, a people picker. The employees list itself is not
// filtered on the server, on purpose: pages still need a departed person's row to name them on an old
// approval, a payslip or a settlement.
export const isCurrentEmployee = (e: Pick<Employee, "delete_time" | "disabled" | "status">): boolean =>
  !e.delete_time && !e.disabled && e.status !== "terminated";

/** Someone who has left (as opposed to a record switched off or deleted): what the Directory's Exited view shows. */
export const hasExited = (e: Pick<Employee, "delete_time" | "status">): boolean => !e.delete_time && e.status === "terminated";
