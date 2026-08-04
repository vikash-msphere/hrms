import { useMemo, useState } from "react";
import { UserRound, Contact, IdCard, Landmark, ShieldCheck, PenLine, FileText, Hash, UserCog, Users, Network } from "lucide-react";
import { navigate } from "@/router";
import { useToast } from "@/components/ui/use-toast";
import { useEmployee } from "@/hooks/useEmployee";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, idOf, probationLabel, tenureLabel } from "@/lib/utils";
import type { Department, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { ProfileView, ProfileDetails } from "@/components/common/ProfileView";
import { EmployeeDocuments } from "@/components/common/EmployeeDocuments";
import { EmployeeBankDetails } from "@/components/common/EmployeeBankDetails";
import { EmployeeIdentityDetails } from "@/components/common/EmployeeIdentityDetails";
import { EmployeePersonalDetails } from "@/components/common/EmployeePersonalDetails";
import { EmployeeProfilePersonal } from "@/components/common/EmployeeProfilePersonal";
import { EmployeeTaxDetails } from "@/components/common/EmployeeTaxDetails";
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

// Same chip style as the employee page header.
const CHIP = "inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export default function Profile({ me }: { me: Me }) {
  const { emp, state, error, reload } = useEmployee(me.employee_id);
  const { rows: depts } = useCollection<Department>("departments");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  // Controlled so the completeness meter's chips can jump to a section / open its dialog.
  const [tab, setTab] = useState("profile");
  const [photoOpen, setPhotoOpen] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
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
  const copyText = (text: string, done: string) =>
    navigator.clipboard.writeText(text).then(() => toast({ title: done, variant: "success" })).catch(() => {});

  return (
    <div>
      <PageHeader title="My Profile" description="Keep your contact, identity, bank and tax details up to date." />
      {!me.employee_id ? (
        <>
          <ProfileView name={name} email={me.email} />
          <Card className="mt-4">
            <CardContent className="py-6 text-sm text-muted-foreground">
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
                email={emp.work_email}
                jobTitle={emp.job_title}
                department={deptName(emp.department)}
                bio={emp.bio}
                onEditBio={() => setBioOpen(true)}
                avatar={<PhotoAvatar employeeId={me.employee_id} name={`${emp.first_name} ${emp.last_name}`} photo={emp.photo} editable onChanged={reload} open={photoOpen} onOpenChange={setPhotoOpen} />}
                meta={
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {emp.employee_number && (
                      <button type="button" className={CHIP} title="Copy employee ID" onClick={() => copyText(emp.employee_number!, "Employee ID copied")}>
                        <Hash className="h-3 w-3" /> <span className="font-mono">{emp.employee_number}</span>
                      </button>
                    )}
                    {emp.manager && empName(emp.manager) && (
                      <button type="button" className={CHIP} title="Open their profile" onClick={() => navigate(`employees/${idOf(emp.manager!)}`)}>
                        <UserCog className="h-3 w-3" /> Reports to {empName(emp.manager)}
                      </button>
                    )}
                    {directReports.length > 0 && (
                      <button type="button" className={CHIP} title="View your team in the org chart" onClick={() => navigate(`org-chart/${me.employee_id}`)}>
                        <Users className="h-3 w-3" /> {directReports.length} direct report{directReports.length === 1 ? "" : "s"}
                      </button>
                    )}
                  </div>
                }
                actions={
                  /* Stacked, right-aligned: status badges on top, action buttons underneath (matches the
                     employee page header). */
                  /* Kept quiet on purpose - the identity (left) side should out-rank this stack. */
                  <div className="flex flex-col items-end gap-1.5">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {/* Employment status isn't shown anywhere else on the self profile - surface tenure + probation here. */}
                      {!!emp.start_date && <span className="text-xs text-muted-foreground">{tenureLabel(emp.start_date)}</span>}
                      {!!emp.probation_end_date && Date.parse(emp.probation_end_date) >= Date.now() && (
                        <Badge variant="warning">{probationLabel(emp.probation_end_date) || "On probation"}</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" className="text-muted-foreground" title="See where you sit in the org chart" onClick={() => navigate(`org-chart/${me.employee_id}`)}>
                        <Network className="h-3.5 w-3.5" /> Org chart
                      </Button>
                      <EmergencyQuickView employeeId={me.employee_id} canEdit open={emergencyOpen} onOpenChange={setEmergencyOpen} onSaved={reload} />
                    </div>
                  </div>
                }
              />
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
                  <AccessTab value="signature" target={{ collection: "employees", objectPath: selfPath, field: "signature", label: "Signature" }}><PenLine className="h-4 w-4" /> Signature</AccessTab>
                  <AccessTab value="documents" target={{ collection: "personal-documents", label: "Documents" }}><FileText className="h-4 w-4" /> Documents</AccessTab>
                </TabsList>
                <TabsContent value="profile" className="space-y-4">
                  <ProfileDetails
                    employeeNumber={emp.employee_number}
                    email={emp.work_email}
                    jobTitle={emp.job_title}
                    department={deptName(emp.department)}
                    manager={empName(emp.manager)}
                    joined={emp.start_date ? formatDate(emp.start_date) : undefined}
                  />
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
                <TabsContent value="signature">
                  <SignatureField employeeId={me.employee_id} signature={emp.signature} canEdit onChanged={reload} />
                </TabsContent>
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
