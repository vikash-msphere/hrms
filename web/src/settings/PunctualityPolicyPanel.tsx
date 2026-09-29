import { useEffect, useMemo, useState } from "react";
import { AlarmClock, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessAction } from "@/components/access/AccessAction";
import { Field, FieldRow } from "@/components/common/Field";
import { PanelSkeleton } from "@/components/common/Skeletons";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { getSetting, saveSetting } from "@/lib/settingsStore";
import { useClock } from "@/lib/clock";
import { navigate } from "@/router";
import { describeError } from "@/lib/formError";
import { formatHHMM } from "@/lib/utils";
import { DEFAULT_PUNCTUALITY, fmtMinutes, policySummary, type PunctualityPolicy } from "@/lib/lateEarly";
import { penaltyUnitsFor, punctualityPolicyOf } from "../../../src/domain/punctuality";

// The org's late arrival / early departure policy (settings/punctuality). Everything it decides is data HR sets
// here: who may ask for what and when, what an approval does to the day, and what unexcused lateness costs.
// The server validates every leaf (domain/punctuality.ts#validatePunctuality) and every reader - the request
// form, the attendance grid, analytics, the payroll build - reads it through one normaliser, so what is saved
// here is what all of them act on.

type Section = keyof PunctualityPolicy;

// A blank box is "no limit": the nullable leaves are the ones whose absence is itself a rule.
const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Math.round(Number(s)));
const show = (n: number | null) => (n == null ? "" : String(n));

export function PunctualityPolicyPanel() {
  const { toast } = useToast();
  const { sched } = useClock();
  const [policy, setPolicy] = useState<PunctualityPolicy>(DEFAULT_PUNCTUALITY);
  const [version, setVersion] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSetting<unknown>("punctuality")
      .then((s) => { setPolicy(punctualityPolicyOf(s.value)); setVersion(s.version); })
      .catch(() => { /* nothing saved yet: the defaults stand, and they are what the server reads too */ })
      .finally(() => setReady(true));
  }, []);

  const set = <S extends Section, K extends keyof PunctualityPolicy[S]>(section: S, key: K, value: PunctualityPolicy[S][K]) =>
    setPolicy((p) => ({ ...p, [section]: { ...p[section], [key]: value } }));
  const r = policy.requests;
  const a = policy.attendance;
  const pen = policy.penalties;

  const { markSaved } = useUnsaved(policy, ready, save);
  async function save() {
    setSaving(true);
    try {
      // The WHOLE policy, every leaf explicit, against the version this panel read - so a save never leaves a
      // leaf to a default that could change under it, and never overwrites somebody else's save unseen.
      await saveSetting("punctuality", { value: policy }, version);
      const fresh = await getSetting<unknown>("punctuality");
      setVersion(fresh.version);
      markSaved();
      toast({ title: "Late & early policy saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save the policy", description: describeError(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // A worked example of the penalty ladder, so "every 3 marks after the first 2 docks half a day" is checked
  // against numbers before it reaches anybody's payslip.
  const example = useMemo(() => [3, 6, 10].map((marks) => ({ marks, days: penaltyUnitsFor(marks, { ...pen, enabled: true }) })), [pen]);
  const summary = policySummary(policy);
  const neither = r.enabled && !r.late_arrival && !r.early_departure;

  // Nothing editable until the stored policy is in. The fields start on DEFAULT_PUNCTUALITY, and a value typed
  // in that window was overwritten when the stored blob landed - so Save then wrote the stored value back.
  if (!ready) return <PanelSkeleton />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlarmClock className="h-4 w-4" />
          <AccessAction collection="settings" objectPath="settings/punctuality" label="Late & early policy"><span>Late & early policy</span></AccessAction>
        </CardTitle>
      </CardHeader>
      <CardContent className="max-w-2xl space-y-4">
        <Tabs defaultValue="requests">
          <TabsList variant="segmented">
            <TabsTrigger value="requests">Requests</TabsTrigger>
            <TabsTrigger value="attendance">Attendance</TabsTrigger>
            <TabsTrigger value="pay">Pay</TabsTrigger>
          </TabsList>

          <TabsContent value="requests" className="space-y-4">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={r.enabled} onCheckedChange={(v) => set("requests", "enabled", v === true)} />
              <span>
                <span className="font-medium">Employees can ask to arrive late or leave early</span>
                <span className="block text-xs text-muted-foreground">Off stops new requests. Requests already approved keep counting for their days.</span>
              </span>
            </label>
            {r.enabled && (
              <>
                <div className="flex flex-wrap gap-4 pl-6">
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={r.late_arrival} onCheckedChange={(v) => set("requests", "late_arrival", v === true)} /> Late arrivals</label>
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={r.early_departure} onCheckedChange={(v) => set("requests", "early_departure", v === true)} /> Early departures</label>
                </div>
                {neither && <p className="pl-6 text-xs text-destructive">Offer at least one, or switch requests off.</p>}

                <FieldRow>
                  <Field label="Longest single request (minutes)" hint="Blank for no cap. Longer than this is half-day leave, not a late arrival.">
                    <Input type="number" min={1} max={1440} placeholder="No cap" value={show(r.max_minutes)} onChange={(e) => set("requests", "max_minutes", numOrNull(e.target.value))} />
                  </Field>
                  <Field label="Approve automatically up to (minutes)" hint="Blank means a person always decides. Only inside the monthly allowance.">
                    <Input type="number" min={1} max={1440} placeholder="Never" value={show(r.auto_approve_minutes)} onChange={(e) => set("requests", "auto_approve_minutes", numOrNull(e.target.value))} />
                  </Field>
                </FieldRow>

                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">Monthly allowance</p>
                  <FieldRow>
                    <Field label="Requests per month" hint="Pending and approved ones both count. Blank for none.">
                      <Input type="number" min={1} max={100} placeholder="No limit" value={show(r.monthly_count)} onChange={(e) => set("requests", "monthly_count", numOrNull(e.target.value))} />
                    </Field>
                    <Field label="Minutes per month" hint="Blank for none.">
                      <Input type="number" min={1} max={44640} placeholder="No limit" value={show(r.monthly_minutes)} onChange={(e) => set("requests", "monthly_minutes", numOrNull(e.target.value))} />
                    </Field>
                  </FieldRow>
                  <FieldRow>
                    <Field label="Counted">
                      <Select value={r.limit_scope} onValueChange={(v) => set("requests", "limit_scope", v as PunctualityPolicy["requests"]["limit_scope"])}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="combined">Both kinds together</SelectItem>
                          <SelectItem value="per_kind">Each kind separately</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="A request past the allowance">
                      <Select value={r.over_limit} onValueChange={(v) => set("requests", "over_limit", v as PunctualityPolicy["requests"]["over_limit"])}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="refuse">Is refused</SelectItem>
                          <SelectItem value="allow">Goes in, flagged for the approver</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </FieldRow>
                </div>

                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">When a request can be made</p>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox className="mt-0.5" checked={r.before_time} onCheckedChange={(v) => set("requests", "before_time", v === true)} />
                    <span>
                      Only before the time it covers
                      <span className="block text-xs text-muted-foreground">A late arrival before the shift starts; an early departure before the time the person means to leave.</span>
                    </span>
                  </label>
                  <FieldRow>
                    <Field label="Days after the day" hint="0 = today or later only. Blank for any.">
                      <Input type="number" min={0} max={366} placeholder="Any" disabled={r.before_time} value={show(r.backdate_days)} onChange={(e) => set("requests", "backdate_days", numOrNull(e.target.value))} />
                    </Field>
                    <Field label="Days ahead" hint="Blank for any.">
                      <Input type="number" min={0} max={366} placeholder="Any" value={show(r.advance_days)} onChange={(e) => set("requests", "advance_days", numOrNull(e.target.value))} />
                    </Field>
                  </FieldRow>
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={r.reason_required} onCheckedChange={(v) => set("requests", "reason_required", v === true)} /> A reason is required</label>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="attendance" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              An approved late arrival moves that day&apos;s shift start to the approved time, and an approved early departure moves its end.
              The day is then judged against that window, so arriving by the approved time is on time and arriving after it is late by the
              minutes past it. The shift itself is {formatHHMM(sched.shift_start)} to {formatHHMM(sched.shift_end)} with {sched.grace_minutes} minutes of grace (Attendance schedule).
            </p>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={a.grace_on_top} onCheckedChange={(v) => set("attendance", "grace_on_top", v === true)} />
              <span>
                Grace still applies after the approved time
                <span className="block text-xs text-muted-foreground">Off makes the approved time exact: approved to arrive at 10:30 and in at 10:35 is late.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={a.credit_minutes} onCheckedChange={(v) => set("attendance", "credit_minutes", v === true)} />
              <span>
                Approved time counts as worked time
                <span className="block text-xs text-muted-foreground">
                  For the full-day and half-day thresholds, so an approved two-hour late start does not turn the day into a half day. Only the
                  part actually missed is counted, and only on a day the person clocked in. Off leaves the day judged on the hours worked.
                </span>
              </span>
            </label>
          </TabsContent>

          <TabsContent value="pay" className="space-y-4">
            {pen.enabled && !sched.lop_enabled && (
              <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  Penalties are charged as loss of pay, and automatic loss of pay is off, so none of this reaches a payslip yet.{" "}
                  <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => navigate("settings/attendance")}>Turn it on in the attendance schedule</button>.
                </span>
              </div>
            )}
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={pen.enabled} onCheckedChange={(v) => set("penalties", "enabled", v === true)} />
              <span>
                <span className="font-medium">Dock pay for unexcused late arrivals and early departures</span>
                <span className="block text-xs text-muted-foreground">
                  Counted per pay period. An approved request, a grace exception, a half spent on approved leave and a day HR has marked are never counted.
                </span>
              </span>
            </label>
            {pen.enabled && (
              <>
                <FieldRow>
                  <Field label="What counts as a mark">
                    <Select value={pen.counts} onValueChange={(v) => set("penalties", "counts", v as PunctualityPolicy["penalties"]["counts"])}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="both">Late arrivals and early departures</SelectItem>
                        <SelectItem value="late">Late arrivals only</SelectItem>
                        <SelectItem value="early">Early departures only</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Free marks per pay period">
                    <Input type="number" min={0} max={31} value={pen.free_marks} onChange={(e) => set("penalties", "free_marks", Math.max(0, Math.round(Number(e.target.value) || 0)))} />
                  </Field>
                </FieldRow>
                <FieldRow>
                  <Field label="Then every" hint="Marks per deduction.">
                    <Input type="number" min={1} max={31} value={pen.every} onChange={(e) => set("penalties", "every", Math.max(1, Math.round(Number(e.target.value) || 1)))} />
                  </Field>
                  <Field label="Docks">
                    <Select value={String(pen.deduct_days)} onValueChange={(v) => set("penalties", "deduct_days", Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0.5">Half a day of pay</SelectItem>
                        <SelectItem value="1">A full day of pay</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldRow>
                <FieldRow>
                  <Field label="At most (days per period)" hint="Blank for no cap. Half-day steps.">
                    <Input type="number" min={0.5} max={31} step={0.5} placeholder="No cap" value={show(pen.max_days)} onChange={(e) => set("penalties", "max_days", e.target.value.trim() === "" ? null : Number(e.target.value))} />
                  </Field>
                  <Field label="Severe lateness (minutes)" hint="A single one longer than this counts the day as at most half. Blank for off.">
                    <Input type="number" min={1} max={1440} placeholder="Off" value={show(pen.severe_minutes)} onChange={(e) => set("penalties", "severe_minutes", numOrNull(e.target.value))} />
                  </Field>
                </FieldRow>
                <p className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
                  With this ladder: {example.map((x) => `${x.marks} marks dock ${x.days} day${x.days === 1 ? "" : "s"}`).join(", ")}.
                  {pen.severe_minutes != null ? ` A single ${fmtMinutes(pen.severe_minutes)}+ lateness counts its day as at most half, and is not also a mark.` : ""}
                </p>
              </>
            )}
          </TabsContent>
        </Tabs>

        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">What employees are told</p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">{summary.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>

        <AccessAction collection="settings" objectPath="settings/punctuality" label="Save">
          <Button onClick={save} loading={saving} disabled={!ready || neither}>Save policy</Button>
        </AccessAction>
      </CardContent>
    </Card>
  );
}
