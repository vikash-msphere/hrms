import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useEmployee } from "@/hooks/useEmployee";
import { useCollection } from "@/hooks/useCollection";
import { patch } from "@/api";
import { formatDate, idOf, tenureLabel } from "@/lib/utils";
import { navigate } from "@/router";
import { usePermission, useCanSeeActivity } from "@/lib/perm";
import type { Department, Employee, LeaveBalance, LeaveRequest, LeaveType, Me } from "@/types";
import { StatusBadge } from "@/components/common/StatusBadge";
import { DataState } from "@/components/common/DataState";
import { ProfileView, ProfileDetails } from "@/components/common/ProfileView";
import { EmployeeDocuments } from "@/components/common/EmployeeDocuments";
import { GenerateLetterButton } from "@/components/common/GenerateLetterButton";
import { GenerateForm16Button } from "@/components/common/GenerateForm16Button";
import { UploadForm16Button } from "@/components/common/UploadForm16Button";
import { EmployeeRoleHistory } from "@/components/common/EmployeeRoleHistory";
import { ActivityFeed } from "@/components/common/ActivityFeed";
import { EmployeeBonuses } from "@/components/common/EmployeeBonuses";
import { EmployeeAssets } from "@/components/common/EmployeeAssets";
import { EmployeeSettlement } from "@/components/common/EmployeeSettlement";
import { EmployeeBankDetails } from "@/components/common/EmployeeBankDetails";
import { EmployeeIdentityDetails } from "@/components/common/EmployeeIdentityDetails";
import { EmployeeTaxDetails } from "@/components/common/EmployeeTaxDetails";
import EmployeeCompensation from "@/components/common/EmployeeCompensation";
import { EmployeePersonalDetails } from "@/components/common/EmployeePersonalDetails";
import { EmployeeProfilePersonal } from "@/components/common/EmployeeProfilePersonal";
import { AccessAction } from "@/components/access/AccessAction";
import { EmergencyQuickView } from "@/components/common/EmergencyQuickView";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { IconEdit } from "@/components/common/IconEdit";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { AccessTab } from "@/components/common/AccessTab";
import { SettingsButton } from "@/components/common/SettingsButton";
import { useToast } from "@/components/ui/use-toast";

const NONE = "__none__";

// Which org-settings panels surface as inline gears on each profile tab. The gear opens the SAME panel as the
// central Settings hub (org singletons, not per-employee config) - it just puts the relevant knob where HR is
// already looking. Data, not scattered JSX; a tab with no row here (contact/assets/activity) shows no gears.
const TAB_SETTINGS: Record<string, string[]> = {
  profile: ["employee-ids", "departments", "defaults"],
  employment: ["defaults", "payroll-policy"],
  leave: ["leave-policy", "leave-types", "attendance"],
  identity: ["employee-fields"],
  bank: ["banks-currency", "bank-formats"],
  tax: ["payroll-policy", "pay-components"],
  compensation: ["salary-structures", "pay-grades", "pay-components", "payroll-policy"],
  documents: ["letters", "letter-defaults", "esign"],
};

export default function EmployeeProfile({ id, me }: { id: string; me: Me }) {
  const empPath = `employees/${id}`;
  // Core profile + employment fields are HR/super_admin only (not self-service).
  const canManage = usePermission("employees.write");
  const canActivity = useCanSeeActivity("employees"); // gates the Activity tab (server ANDs with employee read)
  // Personal/bank details are visible to the employee themselves, HR and super_admin.
  const canBank = me.employee_id === id || canManage;
  // Tax: owner, HR, payroll, super (anyone holding the employees.tax capability); the server still enforces.
  const canTax = usePermission("employees.tax.read");
  // Compensation (salary + revisions): payroll + super (the compensation collection grant).
  const canComp = usePermission("compensation.read");
  const canCompEdit = usePermission("compensation.write");
  // Role history (designation/department changes): HR + super (the positions collection grant).
  const canPositions = usePermission("positions.read");
  const canPositionsEdit = usePermission("positions.write");
  // Bonuses/incentives (one-off awards): HR + super (the bonuses collection grant).
  const canBonuses = usePermission("bonuses.read");
  const canBonusesEdit = usePermission("bonuses.write");
  // Full & final settlement (FnF): HR + super (the settlements collection grant).
  const canSettlement = usePermission("settlements.read");
  const canSettlementEdit = usePermission("settlements.write");
  // Assigned company assets: super + whoever's been granted assets.read via the ACL (and the employee for
  // their own, when granted). Read-only here; assignment happens on the Assets inventory page.
  const canAssets = usePermission("assets.read");
  const canAssetsEdit = usePermission("assets.write");
  // Inline settings gears are org-scoped: gated on settings.write (a per-key perm hides just that one gear).
  const canSettings = usePermission("settings.write");
  const { emp, state, error, reload } = useEmployee(id);
  const { rows: depts } = useCollection<Department>("departments");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: types } = useCollection<LeaveType>("leave-types");
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances");
  const { toast } = useToast();

  const deptName = useMemo(() => {
    const m = new Map(depts.map((d) => [idOf(d.path), d.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [depts]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [employees]);
  const typeName = useMemo(() => {
    const m = new Map(types.map((t) => [idOf(t.path), t.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [types]);
  const myBalances = useMemo(() => balances.filter((b) => b.employee && idOf(b.employee) === id), [balances, id]);
  // This employee's leave requests (scoped by the viewer's leave-requests access), newest first.
  const { rows: leaveReqs } = useCollection<LeaveRequest>("leave-requests");
  const myLeaves = useMemo(
    () => leaveReqs.filter((l) => l.employee && idOf(l.employee) === id).sort((a, b) => b.start_date.localeCompare(a.start_date)),
    [leaveReqs, id],
  );

  const onProbation = !!emp?.probation_end_date && Date.parse(emp.probation_end_date) >= Date.now();

  // --- edit: core profile fields ---
  const [docsKey, setDocsKey] = useState(0); // bump to refetch the documents tab after generating a letter
  const [tab, setTab] = useState("profile"); // controlled so the tab bar can carry the active tab's settings gears
  const [coreOpen, setCoreOpen] = useState(false);
  const [core, setCore] = useState({ first_name: "", last_name: "", legal_name: "", employee_number: "", work_email: "", job_title: "", department: NONE, manager: NONE });
  function openCore() {
    if (!emp) return;
    setCore({
      first_name: emp.first_name,
      last_name: emp.last_name,
      legal_name: emp.legal_name ?? "",
      employee_number: emp.employee_number ?? "",
      work_email: emp.work_email,
      job_title: emp.job_title ?? "",
      department: emp.department ? `departments/${idOf(emp.department)}` : NONE,
      manager: emp.manager ? `employees/${idOf(emp.manager)}` : NONE,
    });
    setCoreOpen(true);
  }

  // --- edit: employment dates ---
  const [empOpen, setEmpOpen] = useState(false);
  const [empForm, setEmpForm] = useState({ start_date: "", probation_end_date: "", epf_enrolled: false });
  function openEmp() {
    setEmpForm({ start_date: emp?.start_date ?? "", probation_end_date: emp?.probation_end_date ?? "", epf_enrolled: !!emp?.epf_enrolled });
    setEmpOpen(true);
  }

  const [saving, setSaving] = useState(false);
  async function savePatch(body: Record<string, unknown>, done: string, close: () => void) {
    setSaving(true);
    try {
      await patch(`employees/${id}`, body, emp?.etag);
      toast({ title: done, variant: "success" });
      close();
      reload();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }
  // Named submit handlers so both the footer button and Enter-to-submit share one definition.
  const coreEmailOk = core.work_email.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(core.work_email.trim());
  const coreValid = !!core.first_name.trim() && !!core.last_name.trim() && coreEmailOk;
  const saveCore = () =>
    savePatch(
      {
        first_name: core.first_name,
        last_name: core.last_name,
        legal_name: core.legal_name.trim() || null,
        employee_number: core.employee_number.trim() || undefined,
        work_email: core.work_email,
        job_title: core.job_title || null,
        department: core.department === NONE ? null : core.department,
        manager: core.manager === NONE ? null : core.manager,
      },
      "Profile updated",
      () => setCoreOpen(false),
    );
  // Value-based check: only complain once both dates are set and out of order.
  const empDatesOk = !empForm.start_date || !empForm.probation_end_date || empForm.probation_end_date >= empForm.start_date;
  const saveEmp = () =>
    savePatch(
      { start_date: empForm.start_date || null, probation_end_date: empForm.probation_end_date || null, epf_enrolled: empForm.epf_enrolled },
      "Employment updated",
      () => setEmpOpen(false),
    );

  // Right-aligned gear row for a tab's inline settings; nothing renders when the caller can't configure.
  const tabGears = (tab: string) => {
    const keys = TAB_SETTINGS[tab];
    if (!canSettings || !keys?.length) return null;
    return (
      <div className="flex shrink-0 items-center gap-2">
        {keys.map((k) => <SettingsButton key={k} me={me} settingKey={k} />)}
      </div>
    );
  };

  return (
    <div>
      <DataState state={state} error={error} rows={2}>
        {emp && (
          <>
            <Button variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground" onClick={() => navigate("employees")}>
              <ArrowLeft className="h-4 w-4" /> Back to directory
            </Button>
            <ProfileView
              name={`${emp.first_name} ${emp.last_name}`}
              email={emp.work_email}
              jobTitle={emp.job_title}
              department={deptName(emp.department)}
              avatar={<PhotoAvatar employeeId={id} name={`${emp.first_name} ${emp.last_name}`} photo={emp.photo} editable={canBank} onChanged={reload} />}
              actions={
                <>
                  {/* Surface the employment status up top so HR doesn't have to open the Employment tab for it. */}
                  {!!emp.start_date && <Badge variant="outline">{tenureLabel(emp.start_date)}</Badge>}
                  {emp.disabled && <Badge variant="secondary">Inactive</Badge>}
                  {!emp.disabled && onProbation && <Badge variant="warning">On probation</Badge>}
                  {canBank && <EmergencyQuickView employeeId={id} canEdit={canBank} />}
                </>
              }
            />

            <Tabs value={tab} onValueChange={setTab} className="mt-6">
              {/* Each tab carries the access key for the section/sub-resource it manages, scoped to this
                  employee record - the affordance lives on the tab bar. The active tab's inline settings gears
                  sit at the right end of the same bar, so no tab spends a whole row on them. */}
              <div className="flex items-center justify-between gap-2">
              <TabsList>
                <AccessTab value="profile" target={{ collection: "employees", objectPath: empPath, label: "Profile" }}>Profile</AccessTab>
                {canBank && <AccessTab value="contact" target={{ collection: "employees", objectPath: empPath, field: "personal-info", label: "Contact" }}>Contact</AccessTab>}
                <AccessTab value="employment" target={{ collection: "employees", objectPath: empPath, label: "Employment" }}>Employment</AccessTab>
                {(myBalances.length > 0 || myLeaves.length > 0) && <AccessTab value="leave" target={{ collection: "leave-requests", label: "Leave" }}>Leave</AccessTab>}
                {canBank && <AccessTab value="identity" target={{ collection: "employees", objectPath: empPath, field: "identity", label: "Identity" }}>Identity</AccessTab>}
                {canBank && <AccessTab value="bank" target={{ collection: "employees", objectPath: empPath, field: "bank-account", label: "Bank details" }}>Bank details</AccessTab>}
                {canTax && <AccessTab value="tax" target={{ collection: "employees", objectPath: empPath, field: "tax", label: "Tax" }}>Tax</AccessTab>}
                {(canComp || canBonuses || canSettlement) && <AccessTab value="compensation" target={{ collection: "compensation", label: "Compensation" }}>Compensation</AccessTab>}
                {canAssets && <AccessTab value="assets" target={{ collection: "assets", label: "Assets" }}>Assets</AccessTab>}
                <AccessTab value="documents" target={{ collection: "personal-documents", label: "Documents" }}>Documents</AccessTab>
                {canActivity && <AccessTab value="activity" target={{ collection: "employees", objectPath: empPath, label: "Activity" }}>Activity</AccessTab>}
              </TabsList>
                {tabGears(tab)}
              </div>

              <TabsContent value="profile" className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-base">Profile</CardTitle>
                    {canManage && (
                      <AccessAction collection="employees" objectPath={`employees/${id}`} label="Profile">
                        <IconEdit onClick={openCore} />
                      </AccessAction>
                    )}
                  </CardHeader>
                  <CardContent>
                    <ProfileDetails
                      employeeNumber={emp.employee_number}
                      email={emp.work_email}
                      jobTitle={emp.job_title}
                      department={deptName(emp.department)}
                      manager={empName(emp.manager)}
                    />
                  </CardContent>
                </Card>
                {canBank && <EmployeeProfilePersonal employeeId={id} canEdit={canBank} />}
              </TabsContent>

              {canBank && (
                <TabsContent value="contact">
                  <EmployeePersonalDetails employeeId={id} canEdit={canBank} />
                </TabsContent>
              )}

              <TabsContent value="employment" className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-base">
                      <AccessAction collection="employees" objectPath={`employees/${id}`} label="Employment">Employment</AccessAction>
                    </CardTitle>
                    {canManage && <IconEdit onClick={openEmp} />}
                  </CardHeader>
                  <CardContent>
                    <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                      <div>
                        <dt className="text-muted-foreground">Start date</dt>
                        <dd className="mt-0.5 font-medium">{emp.start_date ? formatDate(emp.start_date) : "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Probation ends</dt>
                        <dd className="mt-0.5 font-medium">{emp.probation_end_date ? formatDate(emp.probation_end_date) : "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Status</dt>
                        <dd className="mt-0.5">
                          {emp.probation_end_date ? (
                            <Badge variant={onProbation ? "warning" : "success"}>{onProbation ? "On probation" : "Confirmed"}</Badge>
                          ) : (
                            "-"
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">EPF</dt>
                        <dd className="mt-0.5 font-medium">{emp.epf_enrolled ? "Enrolled" : "Not enrolled"}</dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>
                {canPositions && <EmployeeRoleHistory employeeId={id} canEdit={canPositionsEdit} />}
              </TabsContent>

              {(myBalances.length > 0 || myLeaves.length > 0) && (
                <TabsContent value="leave" className="space-y-4">
                  {myBalances.length > 0 && (
                    <Card>
                      <CardHeader><CardTitle className="text-base">Leave balances</CardTitle></CardHeader>
                      <CardContent>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          {myBalances.map((b) => (
                            <div key={b.path} className="rounded-lg border p-3">
                              <div className="text-sm text-muted-foreground">{typeName(b.leave_type)}</div>
                              <div className="mt-1 text-xl font-semibold tabular-nums">{b.balance_days}<span className="ml-1 text-sm font-normal text-muted-foreground">days</span></div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {myLeaves.length > 0 && (
                    <Card>
                      <CardHeader><CardTitle className="text-base">Leave history</CardTitle></CardHeader>
                      <CardContent>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Type</th><th className="py-2 pr-3 font-medium">From</th><th className="py-2 pr-3 font-medium">To</th><th className="py-2 pr-3 text-right font-medium">Days</th><th className="py-2 font-medium">Status</th></tr></thead>
                            <tbody>
                              {myLeaves.map((l) => (
                                <tr key={l.path} className="border-b last:border-0">
                                  <td className="py-1.5 pr-3 font-medium">{typeName(l.leave_type)}</td>
                                  <td className="py-1.5 pr-3 tabular-nums">{formatDate(l.start_date)}</td>
                                  <td className="py-1.5 pr-3 tabular-nums">{formatDate(l.end_date)}</td>
                                  <td className="py-1.5 pr-3 text-right tabular-nums">{l.days}</td>
                                  <td className="py-1.5"><StatusBadge state={l.state} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>
              )}

              {canBank && (
                <TabsContent value="identity" className="space-y-4">
                  <EmployeeIdentityDetails employeeId={id} canEdit={canBank} />
                </TabsContent>
              )}
              {canBank && (
                <TabsContent value="bank" className="space-y-4">
                  <EmployeeBankDetails employeeId={id} canEdit={canBank} />
                </TabsContent>
              )}
              {canTax && (
                <TabsContent value="tax" className="space-y-4">
                  <EmployeeTaxDetails employeeId={id} canEdit={canTax} canVerify={canTax} />
                </TabsContent>
              )}
              {(canComp || canBonuses || canSettlement) && (
                <TabsContent value="compensation" className="space-y-4">
                  {canComp && <EmployeeCompensation employeeId={id} canEdit={canCompEdit} epfEnrolled={!!emp.epf_enrolled} />}
                  {canBonuses && <EmployeeBonuses employeeId={id} canEdit={canBonusesEdit} />}
                  {canSettlement && <EmployeeSettlement employeeId={id} canEdit={canSettlementEdit} />}
                </TabsContent>
              )}
              {canAssets && (
                <TabsContent value="assets">
                  <EmployeeAssets employeeId={id} employeeName={`${emp.first_name} ${emp.last_name}`} canAssign={canAssetsEdit} />
                </TabsContent>
              )}
              <TabsContent value="documents">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <GenerateForm16Button employeeId={id} onGenerated={() => setDocsKey((k) => k + 1)} />
                  <UploadForm16Button employeeId={id} onUploaded={() => setDocsKey((k) => k + 1)} />
                  <GenerateLetterButton employeeId={id} onGenerated={() => setDocsKey((k) => k + 1)} />
                </div>
                <EmployeeDocuments key={docsKey} employeeId={id} />
              </TabsContent>
              {canActivity && (
                <TabsContent value="activity">
                  <ActivityFeed resource={empPath} />
                </TabsContent>
              )}
            </Tabs>

            <Dialog open={coreOpen} onOpenChange={setCoreOpen}>
              <DialogContent onEnterSubmit={() => { if (!saving && coreValid) saveCore(); }}>
                <DialogHeader>
                  <DialogTitle>Edit profile</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="First name"><Input value={core.first_name} onChange={(e) => setCore({ ...core, first_name: e.target.value })} autoFocus /></Field>
                  <Field label="Last name"><Input value={core.last_name} onChange={(e) => setCore({ ...core, last_name: e.target.value })} /></Field>
                </div>
                <Field label="Legal name" hint="As on official documents/IDs/bank. Used for signing and letter sign-off. Leave blank to use the display name."><Input value={core.legal_name} onChange={(e) => setCore({ ...core, legal_name: e.target.value })} placeholder={`${core.first_name} ${core.last_name}`.trim()} /></Field>
                <Field label="Employee ID" field="employee_number" hint="Shown on payslips and letters, e.g. EMP-0042. Must be unique."><Input value={core.employee_number} onChange={(e) => setCore({ ...core, employee_number: e.target.value })} className="font-mono" /></Field>
                <Field label="Work email" error={core.work_email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(core.work_email.trim()) ? "Enter a valid email address." : undefined}><Input type="email" value={core.work_email} onChange={(e) => setCore({ ...core, work_email: e.target.value })} /></Field>
                <Field label="Job title"><Input value={core.job_title} onChange={(e) => setCore({ ...core, job_title: e.target.value })} /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Department" field="department">
                    <Select value={core.department} onValueChange={(v) => setCore({ ...core, department: v })}>
                      <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Unassigned</SelectItem>
                        {depts.filter((dep) => !dep.disabled).map((dep) => (
                          <SelectItem key={dep.path} value={`departments/${idOf(dep.path)}`}>{dep.display_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Manager" field="manager">
                    <Combobox
                      value={core.manager}
                      onValueChange={(v) => setCore({ ...core, manager: v })}
                      searchPlaceholder="Search people…"
                      options={[{ value: NONE, label: "None" }, ...employees.filter((e) => !e.disabled && idOf(e.path) !== id).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))]}
                    />
                  </Field>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCoreOpen(false)}>Cancel</Button>
                  <Button loading={saving} disabled={!coreValid} onClick={saveCore}>Save changes</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={empOpen} onOpenChange={setEmpOpen}>
              <DialogContent onEnterSubmit={() => { if (!saving && empDatesOk) saveEmp(); }}>
                <DialogHeader>
                  <DialogTitle>Edit employment</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Start date" hint="Drives leave accrual."><Input type="date" value={empForm.start_date} onChange={(e) => setEmpForm({ ...empForm, start_date: e.target.value })} autoFocus /></Field>
                  <Field label="Probation ends" hint="Leave blank to clear." error={!empDatesOk ? "Probation can't end before the start date." : undefined}><Input type="date" value={empForm.probation_end_date} onChange={(e) => setEmpForm({ ...empForm, probation_end_date: e.target.value })} /></Field>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-input" checked={empForm.epf_enrolled} onChange={(e) => setEmpForm({ ...empForm, epf_enrolled: e.target.checked })} />
                  <span>Enrolled in EPF<span className="block text-xs text-muted-foreground">Opt-in. Adds the provident-fund deduction and the employer PF share within CTC.</span></span>
                </label>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setEmpOpen(false)}>Cancel</Button>
                  <Button loading={saving} disabled={!empDatesOk} onClick={saveEmp}>Save changes</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </DataState>
    </div>
  );
}
