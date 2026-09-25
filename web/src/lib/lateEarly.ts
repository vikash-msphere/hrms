import { useEffect, useState } from "react";
import { getSetting } from "@/lib/settingsStore";
import { subscribeInvalidations } from "@/lib/resourceStore";
import { idOf } from "@/lib/utils";
import type { LateEarlyRequest } from "@/types";
// The server's own rules, imported rather than mirrored (see the note at the top of lib/attendance.ts): the
// request form's verdict, the grid's judgement of a day and the payroll build all read one implementation.
import {
  DEFAULT_PUNCTUALITY, excusalsByDay, fmtMinutes, KIND_LABEL, punctualityPolicyOf,
  type DayExcusal, type LateEarlyKind, type PunctualityPolicy,
} from "../../../src/domain/punctuality";

export { KIND_LABEL, fmtMinutes, DEFAULT_PUNCTUALITY };
export type { DayExcusal, LateEarlyKind, PunctualityPolicy };

/**
 * The org's punctuality policy (settings/punctuality), read leaf by leaf and re-read whenever a settings write
 * lands - this tab's or a sibling's - so a form open while HR changes the rules does not keep judging by the old
 * ones. The defaults until it arrives, which is also what an org that never saved one is on.
 */
export function usePunctualityPolicy(): PunctualityPolicy {
  const [policy, setPolicy] = useState<PunctualityPolicy>(DEFAULT_PUNCTUALITY);
  useEffect(() => {
    let live = true;
    const read = () => {
      getSetting<unknown>("punctuality")
        .then((s) => { if (live) setPolicy(punctualityPolicyOf(s.value)); })
        .catch(() => { /* not configured -> defaults */ });
    };
    read();
    const off = subscribeInvalidations((collections) => { if (collections.includes("settings")) read(); });
    return () => { live = false; off(); };
  }, []);
  return policy;
}

const upper = (s?: string) => (s ?? "").toUpperCase();

/** One person's APPROVED windows by day, from the rows a surface already holds. */
export function excusalsFor(rows: readonly LateEarlyRequest[], employeeId: string): Map<string, DayExcusal> {
  return excusalsByDay(
    rows
      .filter((r) => upper(r.state) === "APPROVED" && !!r.employee && idOf(r.employee) === employeeId && !!r.date && !!r.kind && !!r.at)
      .map((r) => ({ date: r.date!, kind: r.kind as LateEarlyKind, at: r.at! })),
  );
}

/** Everyone's APPROVED windows, keyed by employee id then day - for a team view built from one list read. */
export function excusalsByEmployee(rows: readonly LateEarlyRequest[]): Map<string, Map<string, DayExcusal>> {
  const ids = new Set(rows.filter((r) => upper(r.state) === "APPROVED" && r.employee).map((r) => idOf(r.employee!)));
  return new Map([...ids].map((id) => [id, excusalsFor(rows, id)]));
}

/**
 * The policy as the sentences an employee reads before asking - what they may file and when, and what an
 * approval does. Only what is actually switched on is said; nothing here is a promise the server does not keep.
 */
export function policySummary(p: PunctualityPolicy): string[] {
  const r = p.requests;
  const out: string[] = [];
  if (!r.enabled) return ["Requests are switched off for now."];
  const kinds = [r.late_arrival && "late arrivals", r.early_departure && "early departures"].filter(Boolean).join(" and ");
  out.push(`You can ask for ${kinds}${r.max_minutes != null ? `, up to ${fmtMinutes(r.max_minutes)} each` : ""}.`);
  const limits = [
    r.monthly_count != null ? `${r.monthly_count} request${r.monthly_count === 1 ? "" : "s"}` : null,
    r.monthly_minutes != null ? fmtMinutes(r.monthly_minutes) : null,
  ].filter(Boolean);
  if (limits.length) {
    const scope = r.limit_scope === "per_kind" ? " of each kind" : "";
    out.push(`The monthly allowance is ${limits.join(" or ")}${scope}${r.over_limit === "allow" ? "; past it a request still goes in, flagged for your approver" : ""}.`);
  }
  if (r.before_time) out.push("A request has to be made before the time it covers.");
  else if (r.backdate_days != null) out.push(r.backdate_days === 0 ? "A request has to be for today or a later day." : `A request can be made up to ${r.backdate_days} day${r.backdate_days === 1 ? "" : "s"} after the day.`);
  if (r.reason_required) out.push("Say why when you ask.");
  if (r.auto_approve_minutes != null) out.push(`Requests of ${fmtMinutes(r.auto_approve_minutes)} or less inside the allowance are approved straight away.`);
  out.push(
    p.attendance.credit_minutes
      ? "Approved time counts as worked time, so the day is not short because of it."
      : "Approved time excuses the lateness; the day is still judged on the hours actually worked.",
  );
  if (p.penalties.enabled) {
    const pen = p.penalties;
    const which = pen.counts === "late" ? "late arrival" : pen.counts === "early" ? "early departure" : "late arrival or early departure";
    out.push(
      `Each unexcused ${which} is a mark. ${pen.free_marks ? `The first ${pen.free_marks} in a pay period are free; after that, ` : ""}every ${pen.every === 1 ? "" : `${pen.every} `}mark${pen.every === 1 ? "" : "s"} cost${pen.every === 1 ? "s" : ""} ${pen.deduct_days === 1 ? "a day" : "half a day"} of pay${pen.max_days != null ? `, at most ${pen.max_days} day${pen.max_days === 1 ? "" : "s"} a period` : ""}.`,
    );
    if (pen.severe_minutes != null) out.push(`Arriving or leaving more than ${fmtMinutes(pen.severe_minutes)} outside your approved time counts the day as at most a half day.`);
  }
  return out;
}
