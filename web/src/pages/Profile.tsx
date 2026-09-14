import { useEffect, useMemo, useState } from "react";
import { UserRound, Contact, IdCard, Landmark, ShieldCheck, PenLine, FileText, HeartPulse, Network, Package, Wallet } from "lucide-react";
import { navigate } from "@/router";
import { get } from "@/api";
import { useToast } from "@/components/ui/use-toast";
import { useEmployee } from "@/hooks/useEmployee";
import { useCollection } from "@/hooks/useCollection";
import { usePresence } from "@/hooks/usePresence";
import { useIntent } from "@/lib/intent";
import { formatMonthYear, humanize, idOf, probationLabel, tenureDuration } from "@/lib/utils";
import { todayStr } from "@/lib/orgDay";
import type { Department, Employee, Me, PersonalDetails } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { ProfileView, ProfileFact, HEADER_BTN } from "@/components/common/ProfileView";
import { PresencePill, PresenceNote } from "@/components/common/PresencePill";
import { PeopleList } from "@/components/common/PeopleList";
import { EmployeeAssets } from "@/components/common/EmployeeAssets";
import { EmployeeDocuments } from "@/components/common/EmployeeDocuments";
import { EmployeeBankDetails } from "@/components/common/EmployeeBankDetails";
import { EmployeeIdentityDetails } from "@/components/common/EmployeeIdentityDetails";
import { EmployeePersonalDetails } from "@/components/common/EmployeePersonalDetails";
import { EmployeeProfilePersonal } from "@/components/common/EmployeeProfilePersonal";
import { EmployeeTaxDetails } from "@/components/common/EmployeeTaxDetails";
import { MyCompensation } from "@/components/common/MyCompensation";
import { EmergencyQuickView } from "@/components/common/EmergencyQuickView";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { SignatureField } from "@/components/common/SignatureField";
import { ProfileCompleteness, type CompletenessKey } from "@/components/common/ProfileCompleteness";
import { EditBioDialog } from "@/components/common/EditBioDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { AccessTab } from "@/components/common/AccessTab";
import { AccessScope } from "@/components/access/AccessScope";
import { usePermission } from "@/lib/perm";

export default function Profile({ me }: { me: Me }) {
  const { emp, state, error, reload } = useEmployee(me.employee_id);
  const { rows: depts } = useCollection<Department>("departments", { all: true });
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
  // Controlled so the completeness meter's chips can jump to a section / open its dialog.
  const [tab, setTab] = useState("profile");
  // The kit I hold. The assets list is scoped server-side (assignedTo = me), so the tab appears only once
  // someone has granted the employee assets.read - otherwise it would show an empty, 403-ing panel. Being able
  // to ASK for kit is reason enough for the tab too, even in an org that hides the inventory from employees.
  // Read both, then combine: `||` short-circuits, which would make the second hook conditional on the first
  // (see the note in Documents.tsx).
  const canReadAssets = usePermission("assets.read");
  const canRequestAssets = usePermission("asset-requests.write");
  const canAssets = canReadAssets || canRequestAssets;
  // Whether an employee may see their own salary is org policy, not a given (plenty of orgs keep pay off
  // self-service and let the payslip speak). So the tab follows the grant: absent compensation.read it never
  // appears, and an admin opens it from the tab's own access affordance. The rows are scoped to the caller
  // server-side, and a self-service read carries no grade or band.
  const canComp = usePermission("compensation.read");
  // "+ New → Request an asset" from anywhere lands here: switch to the tab and let the card open its dialog.
  const [requestAsset, setRequestAsset] = useState(false);
  useIntent("new-asset-request", () => { setTab("assets"); setRequestAsset(true); });
  const [photoOpen, setPhotoOpen] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  // Your own presence and your own phone - both lazy, both failure-silent (hooks/usePresence.ts).
  const presence = usePresence(me.employee_id || null);
  const [personal, setPersonal] = useState<PersonalDetails | null>(null);
  useEffect(() => {
    if (!me.employee_id) return;
    let active = true;
    get<PersonalDetails>(`employees/${me.employee_id}/personal-info`)
      .then((p) => active && setPersonal(p))
      .catch(() => undefined);
    return () => { active = false; };
  }, [me.employee_id]);
  const [bioOpen, setBioOpen] = useState(false);

  function gotoItem(key: CompletenessKey) {
    if (key === "photo") setPhotoOpen(true);
    else if (key === "emergency") setEmergencyOpen(true);
    else if (key === "personal") setTab("profile");
    else setTab(key);
  }

  const deptName = useMemo(() => {
    const m = new Map(depts.map((d) => [idOf(d.path), d.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [depts]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [employees]);

  const name = me.email.split("@")[0] ?? me.email;
  const selfPath = `employees/${me.employee_id}`;

  const directReports = useMemo(
    () => employees.filter((e) => !e.delete_time && e.manager && idOf(e.manager) === me.employee_id),
    [employees, me.employee_id],
  );
  // The same team, in the shape the hover panel takes.
  const reportPeople = useMemo(
    () => directReports.map((e) => ({ id: idOf(e.path), name: `${e.first_name} ${e.last_name}`, photo: e.photo })),
    [directReports],
  );

  return (
    <div>
      <PageHeader title="My Profile" description="Keep your contact, identity, bank and tax details up to date." />
      {!me.employee_id ? (
        <>
          {/* No employee record to draw, so the band carries the one thing this account does have.
              `name` is the email's local part, so the heading is never empty here. */}
          <ProfileView name={name} facts={<ProfileFact label="Account email" value={me.email} copy={me.email} />} />
          <Card className="mt-4">
            <CardContent className="py-6 text-sm text-muted-foreground sm:py-6">
              Your account isn't linked to an employee record yet. Ask an HR admin to connect it.
            </CardContent>
          </Card>
        </>
      ) : (
        <DataState state={state} error={error} rows={2}>
          {emp && (
            /* The route key ("profile") is not a collection - the page shows the caller's OWN employee
               record. Rebind the ambient scope so every field/section affordance targets it, exactly like
               the same sections do on employees/<id>. */
            <AccessScope collection="employees" objectPath={selfPath}>
              <ProfileView
                name={`${emp.first_name} ${emp.last_name}`}
                jobTitle={emp.job_title}
                department={deptName(emp.department)}
                employmentType={emp.employment_type ? humanize(emp.employment_type) : undefined}
                workMode={emp.work_mode ? humanize(emp.work_mode) : undefined}
                location={emp.location}
                bio={emp.bio}
                onEditBio={() => setBioOpen(true)}
                avatar={<PhotoAvatar className="h-[68px] w-[68px] rounded-[14px] sm:h-[92px] sm:w-[92px] sm:rounded-[18px]" employeeId={me.employee_id} name={`${emp.first_name} ${emp.last_name}`} photo={emp.photo} editable onChanged={reload} open={photoOpen} onOpenChange={setPhotoOpen} />}
                note={<PresenceNote presence={presence} coveredByName={presence?.covered_by ? empName(presence.covered_by) : undefined} />}
                /* The record, labelled - the band that replaced the detail grid the Profile tab used to
                   draw underneath this card. Reports-to and direct reports are cells here rather than
                   chips: they still navigate, and they say who rather than only how many. */
                facts={
                  <>
                    <ProfileFact label="Work email" value={emp.work_email} copy={emp.work_email} />
                    {/* Your own phone, so there is no gate to check - it is the same encrypted blob the
                        Contact tab edits. */}
                    {personal?.personal_phone && (
                      <ProfileFact label="Phone" value={personal.personal_phone} copy={personal.personal_phone} field="personal-info" />
                    )}
                    <ProfileFact
                      label="Reports to"
                      value={emp.manager ? empName(emp.manager) : undefined}
                      field="manager"
                      onClick={emp.manager ? () => navigate(`employees/${idOf(emp.manager!)}`) : undefined}
                    />
                    <ProfileFact
                      label="Direct reports"
                      hoverContent={<PeopleList people={reportPeople} />}
                      value={directReports.length > 0 ? `${directReports.length} ${directReports.length === 1 ? "person" : "people"}` : undefined}
                      onClick={directReports.length > 0 ? () => navigate(`org-chart/${me.employee_id}`) : undefined}
                    />
                    <ProfileFact label="Employee ID" value={emp.employee_number} copy={emp.employee_number} field="employee_number" mono />
                    <ProfileFact
                      label="Joined"
                      value={emp.start_date ? formatMonthYear(emp.start_date) : undefined}
                      hint={emp.start_date ? tenureDuration(emp.start_date) : undefined}
                    />
                  </>
                }
                /* Probation isn't shown anywhere else on the self profile, so it surfaces here - beside the
                   name, which is who it is about. */
                status={
                  <>
                    <PresencePill presence={presence} />
                    {/* The badge's own gate, on the ORG's day: `Date.parse` of a date-only value is UTC
                        midnight, so this and the label inside it disagreed about the last day of probation
                        for part of it. A day-string comparison has no offset to lose. */}
                    {!!emp.probation_end_date && emp.probation_end_date.slice(0, 10) >= todayStr() && (
                      <Badge variant="warning">{probationLabel(emp.probation_end_date) || "On probation"}</Badge>
                    )}
                  </>
                }
                actions={
                  /* Both visible and both labelled, same as the employee page. There is no primary action
                     on your own profile - the tabs and the field pencils are where you edit yourself. */
                  <>
                    <button type="button" className={HEADER_BTN} onClick={() => setEmergencyOpen(true)}>
                      <HeartPulse className="h-[15px] w-[15px] text-destructive" /> Emergency
                    </button>
                    <button type="button" className={HEADER_BTN} onClick={() => navigate(`org-chart/${me.employee_id}`)}>
                      <Network className="h-[15px] w-[15px]" /> Org chart
                    </button>
                  </>
                }
              />
              {/* Triggerless: the labelled button above is this dialog's affordance now. The completeness
                  meter's "Emergency contact" chip opens the same controlled state. */}
              <EmergencyQuickView employeeId={me.employee_id} canEdit open={emergencyOpen} onOpenChange={setEmergencyOpen} onSaved={reload} triggerless />
              {emp.profile_completeness && <ProfileCompleteness flags={emp.profile_completeness} onItem={gotoItem} />}
              <EditBioDialog employeeId={me.employee_id} current={emp.bio} open={bioOpen} onOpenChange={setBioOpen} onSaved={reload} />
              <Tabs value={tab} onValueChange={setTab} className="mt-6">
                {/* Each tab carries the access key for the section it manages (the sub-resource field or
                    collection), scoped to this employee record - the affordance lives on the tab bar. */}
                <TabsList variant="underline">
                  <AccessTab value="profile" target={{ collection: "employees", objectPath: selfPath, label: "Profile" }}><UserRound className="h-4 w-4" /> Profile</AccessTab>
                  <AccessTab value="contact" target={{ collection: "employees", objectPath: selfPath, field: "personal-info", label: "Contact" }}><Contact className="h-4 w-4" /> Contact</AccessTab>
                  <AccessTab value="identity" target={{ collection: "employees", objectPath: selfPath, field: "identity", label: "Identity" }}><IdCard className="h-4 w-4" /> Identity</AccessTab>
                  <AccessTab value="bank" target={{ collection: "employees", objectPath: selfPath, field: "bank-account", label: "Bank details" }}><Landmark className="h-4 w-4" /> Bank details</AccessTab>
                  <AccessTab value="tax" target={{ collection: "employees", objectPath: selfPath, field: "tax", label: "Tax" }}><ShieldCheck className="h-4 w-4" /> Tax</AccessTab>
                  {canComp && <AccessTab value="compensation" target={{ collection: "compensation", label: "Compensation" }}><Wallet className="h-4 w-4" /> Compensation</AccessTab>}
                  <AccessTab value="signature" target={{ collection: "employees", objectPath: selfPath, field: "signature", label: "Signature" }}><PenLine className="h-4 w-4" /> Signature</AccessTab>
                  {canAssets && <AccessTab value="assets" target={{ collection: "assets", label: "Assets" }}><Package className="h-4 w-4" /> Assets</AccessTab>}
                  <AccessTab value="documents" target={{ collection: "personal-documents", label: "Documents" }}><FileText className="h-4 w-4" /> Documents</AccessTab>
                </TabsList>
                <TabsContent value="profile" className="space-y-4">
                  {/* No detail grid here: the header's facts band is that grid, one screen higher and
                      without the second copy of every value. */}
                  <EmployeeProfilePersonal employeeId={me.employee_id} canEdit onSaved={reload} />
                </TabsContent>
                <TabsContent value="contact">
                  <EmployeePersonalDetails employeeId={me.employee_id} canEdit onSaved={reload} />
                </TabsContent>
                <TabsContent value="identity">
                  <EmployeeIdentityDetails employeeId={me.employee_id} canEdit title="My identity details" onSaved={reload} />
                </TabsContent>
                <TabsContent value="bank">
                  <EmployeeBankDetails employeeId={me.employee_id} canEdit title="My bank details" onSaved={reload} />
                </TabsContent>
                <TabsContent value="tax">
                  <EmployeeTaxDetails employeeId={me.employee_id} canEdit />
                </TabsContent>
                {canComp && (
                  <TabsContent value="compensation">
                    <MyCompensation employeeId={me.employee_id} />
                  </TabsContent>
                )}
                <TabsContent value="signature">
                  <SignatureField employeeId={me.employee_id} signature={emp.signature} canEdit onChanged={reload} />
                </TabsContent>
                {canAssets && (
                  <TabsContent value="assets">
                    {/* Read-only on the self page for the kit itself: handing out or reclaiming it is an
                        inventory action on the Assets page. Asking for kit IS self-service, so the card's
                        request affordance lives here. */}
                    <EmployeeAssets
                      employeeId={me.employee_id}
                      employeeName={`${emp.first_name} ${emp.last_name}`}
                      title="My assets"
                      isSelf
                      requestNow={requestAsset}
                      onRequestHandled={() => setRequestAsset(false)}
                    />
                  </TabsContent>
                )}
                <TabsContent value="documents">
                  <EmployeeDocuments employeeId={me.employee_id} title="My documents" />
                </TabsContent>
              </Tabs>
            </AccessScope>
          )}
        </DataState>
      )}
    </div>
  );
}
