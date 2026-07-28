import { useMemo } from "react";
import { useEmployee } from "@/hooks/useEmployee";
import { useCollection } from "@/hooks/useCollection";
import { idOf, tenureLabel } from "@/lib/utils";
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
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { AccessTab } from "@/components/common/AccessTab";

export default function Profile({ me }: { me: Me }) {
  const { emp, state, error, reload } = useEmployee(me.employee_id);
  const { rows: depts } = useCollection<Department>("departments");
  const { rows: employees } = useCollection<Employee>("employees");

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

  return (
    <div>
      <PageHeader title="My Profile" description="Keep your contact, identity, bank and tax details up to date." />
      {!me.employee_id ? (
        <Card>
          <CardContent className="py-6">
            <ProfileView name={name} email={me.email} />
            <p className="mt-4 text-sm text-muted-foreground">
              Your account isn't linked to an employee record yet. Ask an HR admin to connect it.
            </p>
          </CardContent>
        </Card>
      ) : (
        <DataState state={state} error={error} rows={2}>
          {emp && (
            <>
              <ProfileView
                name={`${emp.first_name} ${emp.last_name}`}
                email={emp.work_email}
                jobTitle={emp.job_title}
                department={deptName(emp.department)}
                avatar={<PhotoAvatar employeeId={me.employee_id} name={`${emp.first_name} ${emp.last_name}`} photo={emp.photo} editable onChanged={reload} />}
                actions={
                  <>
                    {/* Employment status isn't shown anywhere else on the self profile - surface tenure + probation here. */}
                    {!!emp.start_date && <Badge variant="outline">{tenureLabel(emp.start_date)}</Badge>}
                    {!!emp.probation_end_date && Date.parse(emp.probation_end_date) >= Date.now() && <Badge variant="warning">On probation</Badge>}
                    <EmergencyQuickView employeeId={me.employee_id} canEdit />
                  </>
                }
              />
              <Tabs defaultValue="profile" className="mt-6">
                {/* Each tab carries the access key for the section it manages (the sub-resource field or
                    collection), scoped to this employee record - the affordance lives on the tab bar. */}
                <TabsList>
                  <AccessTab value="profile" target={{ collection: "employees", objectPath: selfPath, label: "Profile" }}>Profile</AccessTab>
                  <AccessTab value="contact" target={{ collection: "employees", objectPath: selfPath, field: "personal-info", label: "Contact" }}>Contact</AccessTab>
                  <AccessTab value="identity" target={{ collection: "employees", objectPath: selfPath, field: "identity", label: "Identity" }}>Identity</AccessTab>
                  <AccessTab value="bank" target={{ collection: "employees", objectPath: selfPath, field: "bank-account", label: "Bank details" }}>Bank details</AccessTab>
                  <AccessTab value="tax" target={{ collection: "employees", objectPath: selfPath, field: "tax", label: "Tax" }}>Tax</AccessTab>
                  <AccessTab value="signature" target={{ collection: "employees", objectPath: selfPath, field: "signature", label: "Signature" }}>Signature</AccessTab>
                  <AccessTab value="documents" target={{ collection: "personal-documents", label: "Documents" }}>Documents</AccessTab>
                </TabsList>
                <TabsContent value="profile" className="space-y-4">
                  <ProfileDetails
                    employeeNumber={emp.employee_number}
                    email={emp.work_email}
                    jobTitle={emp.job_title}
                    department={deptName(emp.department)}
                    manager={empName(emp.manager)}
                  />
                  <EmployeeProfilePersonal employeeId={me.employee_id} canEdit />
                </TabsContent>
                <TabsContent value="contact">
                  <EmployeePersonalDetails employeeId={me.employee_id} canEdit />
                </TabsContent>
                <TabsContent value="identity">
                  <EmployeeIdentityDetails employeeId={me.employee_id} canEdit title="My identity details" />
                </TabsContent>
                <TabsContent value="bank">
                  <EmployeeBankDetails employeeId={me.employee_id} canEdit title="My bank details" />
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
            </>
          )}
        </DataState>
      )}
    </div>
  );
}
