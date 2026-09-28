import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, CalendarPlus, ChevronLeft, ChevronRight, Clock, Network, Pencil, Sparkles,
  UserRound, Briefcase, CalendarDays, IdCard, Landmark, ShieldCheck, Target, Wallet, FileText, History, MessageSquare,
} from "lucide-react";
import { useEmployee } from "@/hooks/useEmployee";
import { useCollection } from "@/hooks/useCollection";
import { usePresence } from "@/hooks/usePresence";
import { get, patch } from "@/api";
import { formatDate, formatMonthYear, humanize, idOf, probationLabel, reportsUnder, tenureDuration } from "@/lib/utils";
import { navigate } from "@/router";
import { fireIntent, useIntent } from "@/lib/intent";
import { usePermission, useCanSeeActivity, subjectScopesOf, SubjectScopesContext } from "@/lib/perm";
import type { Department, Employee, LeaveBalance, LeaveRequest, LeaveType, Me, PersonalDetails } from "@/types";
import { StatusBadge } from "@/components/common/StatusBadge";
import { DataState } from "@/components/common/DataState";
import { ProfileView, ProfileFact, HEADER_BTN, HEADER_BTN_PRIMARY, HEADER_BTN_LABEL } from "@/components/common/ProfileView";
import { PresencePill, PresenceNote } from "@/components/common/PresencePill";
import { PeopleList } from "@/components/common/PeopleList";
import { ProfileStickyBar } from "@/components/common/ProfileStickyBar";
import { EditBioDialog } from "@/components/common/EditBioDialog";
import { EmployeeDocuments } from "@/components/common/EmployeeDocuments";
import { GenerateLetterButton } from "@/components/common/GenerateLetterButton";
import { GenerateForm16Button } from "@/components/common/GenerateForm16Button";
import { UploadForm16Button } from "@/components/common/UploadForm16Button";
import { UploadInsuranceButton } from "@/components/common/UploadInsuranceButton";
import { EmployeeRoleHistory } from "@/components/common/EmployeeRoleHistory";
import { AttendanceHistory } from "@/components/common/AttendanceHistory";
import { useAttendanceWindow } from "@/hooks/useAttendanceWindow";
import { useClock } from "@/lib/clock";
import { useCanExport } from "@/lib/perm";
import { localDay, trackedFromOf } from "@/lib/attendance";
import { ActivityFeed } from "@/components/common/ActivityFeed";
import { EmployeeBonuses } from "@/components/common/EmployeeBonuses";
import { EmployeeAssets } from "@/components/common/EmployeeAssets";
import { EmployeeSettlement } from "@/components/common/EmployeeSettlement";
import { EmployeePayslips } from "@/components/common/EmployeePayslips";
import { EmployeeBankDetails } from "@/components/common/EmployeeBankDetails";
import { EmployeePosts } from "@/components/common/EmployeePosts";
import { EmployeePerformance } from "@/components/common/EmployeePerformance";
import { RevealCard } from "@/components/common/RevealCard";
import { EmployeeIdentityDetails } from "@/components/common/EmployeeIdentityDetails";
import { SignatureField } from "@/components/common/SignatureField";
import { MyCompensation } from "@/components/common/MyCompensation";
import { MyViewers } from "@/components/common/MyViewers";
import { AppLockSettings } from "@/components/lock/AppLockSettings";
import { EmployeeTaxDetails } from "@/components/common/EmployeeTaxDetails";
import EmployeeCompensation from "@/components/common/EmployeeCompensation";
import { EmployeePersonalDetails } from "@/components/common/EmployeePersonalDetails";
import { EmployeeProfilePersonal } from "@/components/common/EmployeeProfilePersonal";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessScope } from "@/components/access/AccessScope";
import { EmployeeEmergencyDetails } from "@/components/common/EmployeeEmergencyDetails";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { ProfileCompleteness, type CompletenessKey } from "@/components/common/ProfileCompleteness";
import { IconEdit } from "@/components/common/IconEdit";
import { Field, FieldRow } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessTab } from "@/components/common/AccessTab";
import { SettingsMenu } from "@/components/common/SettingsButton";
import { useToast } from "@/components/ui/use-toast";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";

const NONE = "__none__";

// Which org-settings panels surface as inline gears on each profile tab. The gear opens the SAME panel as the
// central Settings hub (org singletons, not per-employee config) - it just puts the relevant knob where HR is
// already looking. Data, not scattered JSX; a tab with no row here (activity) shows no gears.
const TAB_SETTINGS: Record<string, string[]> = {
  profile: ["employee-ids", "departments", "defaults"],
  // Employment carries the assigned-assets panel, so the asset tag/category knobs come with it.
  employment: ["defaults", "payroll-policy", "asset-tags"],
  leave: ["leave-policy", "leave-types", "attendance"],
  attendance: ["attendance"],
  // Identity carries the bank panel too, so it carries the bank knobs with it.
  identity: ["employee-fields", "banks-currency", "bank-formats"],
  // The competency framework and rating scale the reviews on this tab are scored on.
  performance: ["performance"],
  // Compensation carries the tax panel; tax's own knobs (payroll-policy, pay-components) are already here.
  compensation: ["salary-structures", "pay-grades", "pay-components", "payroll-policy"],
  documents: ["letters", "letter-defaults", "esign"],
};

// `sub` is the URL's third segment (/employees/<id>/<sub>): the active tab, so tabs are
// deep-linkable and survive refresh. Absent/unknown/not-permitted values fall back to "profile".
export default function EmployeeProfile({ id, me, sub, basePath }: { id: string; me: Me; sub?: string; basePath?: string }) {
  const empPath = `employees/${id}`;
  // ONE RECORD PAGE, TWO ADDRESSES. `/profile` and `/employees/<id>` used to be two components with two tab
  // sets, two orders and two names for the same sections - Assets was a tab on one and a card inside
  // Employment on the other, the signature existed only on one, and the self page kept its open tab in
  // component state so it could not be linked to at all. Same record, two products.
  //
  // They are the same page now, and the difference between them is exactly what the engine says this caller
  // may see about this person (`access.subject`) - which, on one's own record, is whatever the `me`-scoped
  // rules grant. `basePath` is only the address to write tab links against.
  const base = basePath ?? empPath;
  // Core profile + employment fields are HR/super_admin only (not self-service).
  const canManage = usePermission("employees.write");
  const canSeeEmpActivity = useCanSeeActivity("employees"); // the activity capability itself (server ANDs it with employee read)
  // The org-wide audit grant, which is what `?subject` needs - see the note on that panel below.
  const canOrgActivity = useCanSeeActivity();
  // Personal/bank details are visible to the employee themselves and super_admin only - these are the
  // field-precise sub-resources (src/domain/grants.ts OWN_PII), never reached by the broad `employees.write`
  // grant HR/manager hold for the directory (that's `canManage`, deliberately not used here).
  // This person, on their own record. Not a permission - reading your own sensitive data is never audited
  // (domain/auditAccess.ts), and the empty states read differently ("You have no goals" / "No goals set") -
  // so `isSelf` still decides copy and audit-free reveals. It decides NO gate; see below.
  const isSelf = me.employee_id === id;
  const { emp, state, error, reload } = useEmployee(id);

  // ===== EVERY PER-RECORD GATE ON THIS PAGE, AND NOT ONE LINE OF POLICY AMONG THEM =====
  //
  // `access.subject` is the server's answer to "what may this caller reach ABOUT THIS PERSON", decided by the
  // engine against the subject's own employee code (src/domain/access.ts `subjectScopes`, carried on the
  // employee item). Every key here is read from that answer. Nothing on this page knows that an employee sees
  // their own record, that a manager sees their team, or that HR sees everyone: those are rows in
  // `access_rules`, editable at runtime through the ACL, and the roles a real deployment defines will look
  // nothing like the seeded ones.
  //
  // Two earlier shapes were both wrong, and both wrong in the same way - policy restated on the client:
  //
  //   1. `usePermission("attendance.read")`. The capability set is scope-STRIPPED (domain/permissions.ts
  //      stripScope), so `attendance.me.**` and `attendance.**` arrive identical. Every employee clocks in, so
  //      the string is true for EVERYBODY, and the tab rendered on every colleague's record.
  //   2. `useCanReadFor(collection, isSelf)` over a per-collection BREADTH. Better, still policy: the `isSelf`
  //      branch hardcoded "your own record is always yours", and a breadth is a TIER, not a relationship - it
  //      is probed with synthetic codes belonging to nobody, so `my-reports` / `my-org` could only report as
  //      the blanket string `dept` (tab on everyone, rows for nobody) and a per-object SHARE vanished entirely.
  //
  // Asking the engine about the subject's real code makes all of it fall out with no branching here: `me`
  // answers for the owner, `my-dept` / `my-reports` / `my-org` for the team, `<code>-*` for a granted branch,
  // and a per-object share for the single record - because the item request merged it (`ctx.objectGrant`).
  //
  // `canManage` above stays on `usePermission`, and correctly: it is an ORG-level question ("may I edit employee
  // records at all"), not a question about this person.
  const subject = useMemo(() => subjectScopesOf(emp?.access), [emp]);
  const canRead = (key: string) => subject.read.has(key);
  const canWrite = (key: string) => subject.write.has(key);

  // The employee record's field-precise sub-resources. Each is its OWN grant - the broad `employees` grant HR
  // holds for the directory reaches none of them - so each is asked for by name.
  const canPersonal = canRead("employees.personal-info");
  const canPersonalEdit = canWrite("employees.personal-info");
  const canIdentity = canRead("employees.identity");
  const canIdentityEdit = canWrite("employees.identity");
  const canBankDetails = canRead("employees.bank-account");
  const canBankEdit = canWrite("employees.bank-account");
  // Identity is the proof-of-who-you-are tab: government IDs and the account pay lands in. Either half is
  // reason enough for the tab; each panel inside carries its own gate.
  const canIdentityTab = canIdentity || canBankDetails;
  const canTax = canRead("employees.tax");
  const canTaxEdit = canWrite("employees.tax");
  // VERIFYING a declaration is not editing one. Maker-checker is structural on the server
  // (services/taxDetails.ts refuses a verification by the subject employee), so on your own record the button
  // could only ever 400 - and `employees.me.tax.**` is a WRITE grant, so the write key alone says yes there.
  // This is the one gate that reads `isSelf`, and it is subtracting from what the engine allowed rather than
  // adding to it: the server's refusal is the rule, and this stops offering a button that cannot work.
  const canTaxVerify = canTaxEdit && !isSelf;
  const canComp = canRead("compensation");
  const canCompEdit = canWrite("compensation");
  const canPositions = canRead("positions");
  const canPositionsEdit = canWrite("positions");
  const canBonuses = canRead("bonuses");
  const canBonusesEdit = canWrite("bonuses");
  const canSettlement = canRead("settlements");
  const canSettlementEdit = canWrite("settlements");
  const canPayslips = canRead("payslips");
  // Reading the kit this person holds - or, on one's OWN record, asking for some. A plain employee holds no
  // `assets` grant (the register is IT's), so without the second half they lost the only place the app offers
  // "Request an asset"; the panel renders the ask for `isSelf` alone, which is why the self branch is here and
  // not a second reading of the grant. `canWrite("asset-requests")` is the engine's answer ABOUT THIS PERSON,
  // so it is true on one's own record via the `me` rule every employee holds and false about anybody else -
  // no capability string, and nothing here deciding who may ask for what.
  const canAssets = canRead("assets") || (isSelf && canWrite("asset-requests"));
  const canAssetsEdit = canWrite("assets");
  // The board and the box, as this person wrote them. Either is reason enough for the tab; the panel reads
  // both and contributes nothing for the one the caller cannot see.
  const canPosts = canRead("announcements") || canRead("suggestions");
  // How this person is doing. Any ONE of the three is a tab worth having - an org that runs goals but no
  // boards still gets the goals half.
  const canGoals = canRead("goals");
  const canTasks = canRead("cards");
  const canReviews = canRead("reviews");
  const canPerformance = canGoals || canTasks || canReviews;
  // Somebody ELSE's leave and attendance, read on their record - the HR/manager errand. On one's own record
  // both are cut: a person reads their own days and balances on the Attendance and Leaves pages, which carry
  // the affordances this record cannot (clocking in, filing a request, asking for a correction), so the two
  // tabs here were a second, poorer copy of a page the same person already has in the nav.
  const canLeave = !isSelf && (canRead("leave-requests") || canRead("leave-balances"));
  const canAttendance = !isSelf && canRead("attendance");
  const canExportAttendance = useCanExport("attendance");
  const canDocs = canRead("personal-documents");
  // Filing a document on this person's record - the grant behind the insurance e-card's upload, which sits
  // with the rest of their documents on the Documents tab. Its own key, not `canManage` and not the
  // personal-info write: an org that lets a manager correct an emergency contact has said nothing about
  // letting them file documents.
  const canDocsEdit = canWrite("personal-documents");
  // The avatar's editor. A VERB (`employees.<code>.uploadPhoto`), granted on its own - own photo via
  // `employees.me.uploadPhoto`, everybody's via HR's broad rule - so the row's server-computed `access.can` is
  // the answer, not a level on the personal-info sub-resource. The two coincide for the seeded roles and part
  // company the moment an org grants one without the other: the old gate offered a pencil that could only 403,
  // or hid one that would have worked.
  const canPhoto = !!emp?.access?.can?.includes("uploadPhoto");
  // The trail is TWO gates, and the server ANDs them: the `activity` capability (org-level - may I see trails
  // at all) and read on the record. The second half is scoped per subject like everything else here.
  const canActivity = canSeeEmpActivity && canRead("activity.employees");
  // The inline settings gears open ORG singletons (the department list, the pay-component catalogue) that happen
  // to be shown where HR is already looking. Which of them the caller may open is decided per panel by
  // SettingsMenu itself (it renders nothing when none is theirs), so there is no page-level settings gate here.
  const { rows: depts } = useCollection<Department>("departments", { all: true });
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: types } = useCollection<LeaveType>("leave-types", { enabled: canLeave });
  // This person's balances, narrowed server-side. Filtering a page of the whole collection in the browser was
  // both dearer and blind to anything past the cursor.
  // `enabled`: the capability `useCollection` gates on is scope-stripped, so on a colleague's record it fires
  // for every caller and comes back empty. The per-subject answer is the one that knows, and a read nobody can
  // use is a D1 read nobody should pay for (docs/architecture-decisions.md, read minimization).
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances", { enabled: canLeave, params: { employee: `employees/${id}` } });
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
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Unknown type" : "-");
  }, [types]);
  const myBalances = balances;
  // This employee's leave requests (scoped by the viewer's leave-requests access), newest first - narrowed to
  // this person server-side, so the profile shows their whole history rather than whichever of their requests
  // happened to land on the first page of the collection.
  const { rows: leaveReqs } = useCollection<LeaveRequest>("leave-requests", { enabled: canLeave, params: { employee: `employees/${id}` } });
  const myLeaves = useMemo(() => [...leaveReqs].sort((a, b) => b.start_date.localeCompare(a.start_date)), [leaveReqs]);

  const onProbation = !!emp?.probation_end_date && Date.parse(emp.probation_end_date) >= Date.now();

  // The attendance tab's window. The hook is keyed on the record, so the view choice (list or month grid) is
  // remembered per person rather than bleeding between the people an HR reader steps through. It has to be
  // called unconditionally, so it is here rather than inside the tab panel.
  // "+ New -> Request an asset" from anywhere lands here: switch to the tab the kit card lives on and let
  // the card open its own dialog. Only ever fires for the caller's own record - asking for kit is
  // self-service, and the quick action does not exist on somebody else's profile.
  const [requestAsset, setRequestAsset] = useState(false);
  useIntent("new-asset-request", () => { setTab("employment"); setRequestAsset(true); });
  const { sched } = useClock();
  const orgToday = localDay(new Date().toISOString(), sched.timezone);
  const attendanceWin = useAttendanceWindow(`emp:${id}`, orgToday);

  // Which tabs THIS viewer gets (mirrors the render gates below) - guards the URL's tab segment.
  const tabValues = useMemo(() => {
    const t = new Set(["profile", "employment"]);
    if (canDocs) t.add("documents");
    if (canIdentityTab) t.add("identity");
    if (canLeave) t.add("leave");
    if (canAttendance) t.add("attendance");
    if (canPerformance) t.add("performance");
    if (canPosts) t.add("posts");
    if (canTax || canComp || canBonuses || canSettlement || canPayslips) t.add("compensation");
    if (canActivity) t.add("activity");
    // Who can see me, asked from the subject's side. Deliberately not access-governed and deliberately
    // self-only: a person finding out who reads their bank details is the point, not a grant to hand out.
    if (isSelf) t.add("privacy");
    return t;
  }, [canIdentityTab, canDocs, canLeave, isSelf, canAttendance, canPerformance, canPosts, canTax, canComp, canBonuses, canSettlement, canPayslips, canActivity]);
  const tab = sub && tabValues.has(sub) ? sub : "profile";
  const setTab = (v: string) => navigate(v === "profile" ? base : `${base}/${v}`);

  // Org relations + prev/next stepping, all from the already-cached employees collection.
  const liveEmployees = useMemo(() => employees.filter((e) => !e.delete_time), [employees]);
  const empIdx = liveEmployees.findIndex((e) => idOf(e.path) === id);
  const prevEmp = empIdx > 0 ? liveEmployees[empIdx - 1] : undefined;
  const nextEmp = empIdx >= 0 ? liveEmployees[empIdx + 1] : undefined;
  const directReports = useMemo(() => liveEmployees.filter((e) => e.manager && idOf(e.manager) === id), [liveEmployees, id]);
  /** Everyone under this person - the manager picker must not offer any of them (see `reportsUnder`). */
  const managerCycleIds = useMemo(() => reportsUnder(liveEmployees, id), [liveEmployees, id]);
  // The same team, in the shape the hover panel takes. Memoized so hovering the cell
  // does not rebuild the array (and with it every avatar) on each render.
  const reportPeople = useMemo(
    () => directReports.map((e) => ({ id: idOf(e.path), name: `${e.first_name} ${e.last_name}`, photo: e.photo })),
    [directReports],
  );


  // --- edit: core profile fields ---
  const [docsKey, setDocsKey] = useState(0); // bump to refetch the documents tab after generating a letter
  const [bioOpen, setBioOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  // What the sticky bar watches: while this header is off screen, the bar carries the identity instead.
  const headerRef = useRef<HTMLDivElement | null>(null);
  // Derived reachability for the status pill and the on-leave note. Lazy and failure-silent: see
  // hooks/usePresence.ts for why it is not a field on the record. Asked for only where the engine would answer
  // it (`access.subject`): presence is read off leave and attendance, which not every viewer may see.
  const presence = usePresence(canRead("employees.presence") ? id : null);
  // The phone for the facts band. Only fetched when the viewer may see it at all (`canPersonal` is the
  // super, the same gate the server gives the encrypted blob), so a colleague's profile makes no request
  // that could only come back redacted. Failure-silent for the same reason presence is: the cell is a
  // convenience on a page that has already loaded.
  const [personal, setPersonal] = useState<PersonalDetails | null>(null);
  useEffect(() => {
    setPersonal(null);
    if (!canPersonal) return;
    let active = true;
    get<PersonalDetails>(`employees/${id}/personal-info`)
      .then((p) => active && setPersonal(p))
      .catch(() => undefined);
    return () => { active = false; };
  }, [id, canPersonal]);
  /**
   * Which checklist tiles are a JUMP for this viewer, and which are just a fact.
   *
   * The flags are deliberately broader than the data: the server sends HR "is there an emergency contact on
   * file" as a record-quality signal while the contents stay owner-only (routes/employees.ts). So the count
   * stays whole - HR is exactly who chases an empty record - and the tiles whose section this page will not
   * render for them stop being buttons. Offered as buttons they landed on the Profile tab with none of those
   * cards on it, or on an Identity tab that does not exist for them and bounces straight back.
   */
  const canOpenSection = useCallback(
    (key: CompletenessKey) =>
      key === "photo" ? canPhoto
      : key === "personal" || key === "contact" || key === "emergency" ? canPersonal
      : key === "identity" ? canIdentity
      : key === "bank" ? canBankDetails
      // Owner-only at the service level, whatever the grant says (services/employeePhoto.ts assertOwner).
      : isSelf,
    [canPhoto, canPersonal, canIdentity, canBankDetails, isSelf],
  );
  // Completeness chips jump to the section where the data is filled in (mirrors /profile's gotoItem).
  function gotoRecordItem(key: CompletenessKey) {
    if (key === "photo") setPhotoOpen(true);
    else if (key === "personal" || key === "contact" || key === "emergency") setTab("profile"); // all three panels live on Profile
    else setTab("identity"); // identity + bank share the Identity tab
  }
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
  const [empForm, setEmpForm] = useState({ start_date: "", probation_end_date: "", tracked_from: "", epf_enrolled: false, eps_excluded: false });
  // Offer to re-solve pay splits when a change here moves one (EPF enrolment). Silent for everything else.
  const { promptReapply } = useSplitStaleness({ auto: false });
  function openEmp() {
    setEmpForm({ start_date: emp?.start_date ?? "", probation_end_date: emp?.probation_end_date ?? "", tracked_from: emp?.tracked_from ?? "", epf_enrolled: !!emp?.epf_enrolled, eps_excluded: !!emp?.eps_excluded });
    setEmpOpen(true);
  }

  // Throws on failure: the WriteDialog that called it shows the reason and stays open.
  async function savePatch(body: Record<string, unknown>, done: string) {
    await patch(`employees/${id}`, body, emp?.etag);
    toast({ title: done, variant: "success" });
    reload();
  }
  const coreEmailOk = core.work_email.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(core.work_email.trim());
  const coreValid = !!core.first_name.trim() && !!core.last_name.trim() && coreEmailOk;
  const coreWhyNot = !core.first_name.trim() || !core.last_name.trim() ? "A first and last name are required." : !coreEmailOk ? "That work email isn't a valid address." : undefined;
  const saveCore = () =>
    savePatch(
      {
        first_name: core.first_name,
        last_name: core.last_name,
        legal_name: core.legal_name.trim(),
        employee_number: core.employee_number.trim() || undefined,
        work_email: core.work_email,
        job_title: core.job_title,
        department: core.department === NONE ? "" : core.department,
        manager: core.manager === NONE ? "" : core.manager,
      },
      "Profile updated",
    );
  // Value-based check: only complain once both dates are set and out of order.
  const empDatesOk = !empForm.start_date || !empForm.probation_end_date || empForm.probation_end_date >= empForm.start_date;
  // EPF enrolment is a split INPUT for this employee: enrolling adds the employer PF share to their CTC build-up
  // (un-enrolling removes it), so their cached basic / Special Allowance no longer solves the CTC they were
  // promised. Prompt to propagate the moment it changes, instead of leaving the profile quietly inconsistent.
  const saveEmp = async () => {
    const enrolmentChanged = !!emp?.epf_enrolled !== empForm.epf_enrolled;
    // Probation end date only when it was edited. It is a redacted field (policy.redacted_fields), and a redacted
    // value reaches the client exactly as an unset one does - absent - so an editor whose grant does not reach
    // it loads a blank here, and sending that blank back as `null` would erase a date they were never shown.
    const probationEdited = empForm.probation_end_date !== (emp?.probation_end_date ?? "");
    // Sent only when changed, like the probation date: it moves which days payroll may dock, so a save that
    // was about something else must not re-send it.
    const trackedEdited = empForm.tracked_from !== (emp?.tracked_from ?? "");
    await savePatch(
      {
        start_date: empForm.start_date || null,
        ...(probationEdited ? { probation_end_date: empForm.probation_end_date || null } : {}),
        ...(trackedEdited ? { tracked_from: empForm.tracked_from || null } : {}),
        epf_enrolled: empForm.epf_enrolled,
        eps_excluded: empForm.eps_excluded,
      },
      "Employment updated",
    );
    if (enrolmentChanged) await promptReapply();
  };

  // Right-aligned settings gear (one menu) for a tab's inline settings; nothing renders when the caller can't configure.
  // `ml-auto` rather than a `justify-between` on the parent: below `sm` the parent's row wraps and the strip
  // takes the whole first line, where `justify-between` would have nothing to push against (see the tab band).
  const tabGears = (tab: string) => {
    const keys = TAB_SETTINGS[tab];
    if (!keys?.length) return null;
    return (
      <div className="order-1 ml-auto flex shrink-0 items-center gap-2 sm:order-2">
        <SettingsMenu me={me} items={keys.map((key) => ({ key }))} />
      </div>
    );
  };

  return (
    // Every panel inside reads the SAME per-subject answer this page's own gates read, so a card nested three
    // components deep cannot reach a different conclusion about whose record this is (or fall back to a
    // scope-stripped capability, which is how they all went wrong the first time).
    <SubjectScopesContext.Provider value={subject}>
    {/* The page declares what it is ABOUT rather than inheriting it from whichever route reached it: at
        `/employees/<id>` the route scope says the same thing, but at `/profile` the route provides none
        (ROUTE_SCOPE marks it null, being a page key rather than a collection) and every key icon inside would
        target nothing. Binding it here is what lets one component serve both addresses. */}
    <AccessScope collection="employees" objectPath={empPath}>
    <div>
      <DataState state={state} error={error} rows={2} onRetry={reload}>
        {emp && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => navigate("employees")}>
                {/* "Back to directory" plus the prev/next pager is wider than a phone; the label shortens
                    rather than the pager disappearing. */}
                <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Back to directory</span><span className="sm:hidden">Back</span>
              </Button>
              {empIdx >= 0 && liveEmployees.length > 1 && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {/* Named for a screen reader, hinted by name for a pointer: the tooltip says WHO is next,
                      which the label cannot (it would read the person's name as the button's purpose). */}
                  <Button
                    variant="ghost" size="sm" className="h-7 px-1.5" disabled={!prevEmp}
                    aria-label="Previous employee"
                    title={prevEmp ? `${prevEmp.first_name} ${prevEmp.last_name}` : undefined}
                    onClick={() => prevEmp && navigate(`employees/${idOf(prevEmp.path)}`)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="tabular-nums">{empIdx + 1} of {liveEmployees.length}</span>
                  <Button
                    variant="ghost" size="sm" className="h-7 px-1.5" disabled={!nextEmp}
                    aria-label="Next employee"
                    title={nextEmp ? `${nextEmp.first_name} ${nextEmp.last_name}` : undefined}
                    onClick={() => nextEmp && navigate(`employees/${idOf(nextEmp.path)}`)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
            {/* `Tabs` wraps the header card, because the tab strip is now the card's last band and
                `TabsList` needs the context. The panels stay where they were, below it. */}
            {/* The gap between the card and whichever panel is open. It lived on the tab list's `mb-6`,
                which no longer exists here (the list is inside the card now), so it is set once on every
                panel instead of eleven times. 14px, tight enough that the panel reads as hanging from the
                tab that names it rather than as the next thing down the page. */}
            <Tabs value={tab} onValueChange={setTab} className="[&>[role=tabpanel]]:mt-3.5">
            <ProfileStickyBar
              watch={headerRef}
              employeeId={id}
              name={`${emp.first_name} ${emp.last_name}`}
              subtitle={[emp.job_title, deptName(emp.department)].filter(Boolean).join(" · ")}
              photo={emp.photo}
              presence={presence}
              actions={
                <button type="button" className={HEADER_BTN} onClick={() => navigate(`org-chart/${id}`)}>
                  <Network className="h-[15px] w-[15px]" /> Org chart
                </button>
              }
            />
            <ProfileView
              identityRef={headerRef}
              // The person's name IS this page's title - there is no PageHeader above it - so it carries the
              // page's only `h1`.
              heading="h1"
              name={`${emp.first_name} ${emp.last_name}`}
              jobTitle={emp.job_title}
              department={deptName(emp.department)}
              // Mirrored from the current position row, so a transfer or a contract-to-permanent conversion
              // updates the line without anything here re-reading the history.
              employmentType={emp.employment_type ? humanize(emp.employment_type) : undefined}
              workMode={emp.work_mode ? humanize(emp.work_mode) : undefined}
              location={emp.location}
              bio={emp.bio}
              // Bio is personal: the "Add a short bio" prompt is owner-only. HR still gets the edit
              // pencil once a bio EXISTS (moderation), just not the empty-state nudge.
              onEditBio={me.employee_id === id || (canManage && !!emp.bio) ? () => setBioOpen(true) : undefined}
              avatar={<PhotoAvatar className="h-[68px] w-[68px] rounded-full sm:h-[92px] sm:w-[92px]" employeeId={id} name={`${emp.first_name} ${emp.last_name}`} photo={emp.photo} editable={canPhoto} onChanged={reload} open={photoOpen} onOpenChange={setPhotoOpen} />}
              /* Where they sit, as the only two chips - both go somewhere. The pill shape is the promise
                 that pressing it does something, so facts with nothing behind them are cells in the band
                 below instead. The manager's field-access icon rides along here, since this chip is the
                 only place the manager appears. */
              /* Who is covering while they are away. Only renders on an actual absence. */
              note={<PresenceNote presence={presence} coveredByName={presence?.covered_by ? empName(presence.covered_by) : undefined} />}
              /* The record, labelled. This band is what the Profile tab used to draw as a six-card grid a
                 hundred pixels below the header - both on screen at once, saying the same things twice.
                 Reports-to and direct reports are cells here rather than chips: with a face beside each one
                 they say who, not just how many, and they still navigate. */
              facts={
                <>
                  <ProfileFact label="Work email" value={emp.work_email} copy={emp.work_email} />
                  {/* Phone lives in the encrypted personal-info blob and is gated to the owner and HR, so a
                      colleague never sees this cell at all - it is not rendered empty, it is not rendered. */}
                  {canPersonal && personal?.personal_phone && (
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
                    // The cell stays a plain count; the faces and names live in the hover panel, where each
                    // row is a way to that person. "5 people" answers how many, and the panel answers who.
                    hoverContent={<PeopleList people={reportPeople} />}
                    value={directReports.length > 0 ? `${directReports.length} ${directReports.length === 1 ? "person" : "people"}` : undefined}
                    onClick={directReports.length > 0 ? () => navigate(`org-chart/${id}`) : undefined}
                  />
                  <ProfileFact
                    label="Employee ID"
                    value={emp.employee_number}
                    copy={emp.employee_number}
                    field="employee_number"
                    mono
                    addLabel="Add ID"
                    onAdd={canManage ? openCore : undefined}
                  />
                  {/* Joined and tenure in one cell: "Mar 2022" alone makes the reader do the subtraction, and
                      the duration alone loses the date HR is actually looking up. */}
                  <ProfileFact
                    label="Joined"
                    value={emp.start_date ? formatMonthYear(emp.start_date) : undefined}
                    hint={emp.start_date ? tenureDuration(emp.start_date) : undefined}
                  />
                </>
              }
              factsAction={
                canManage ? (
                  <AccessAction collection="employees" objectPath={`employees/${id}`} label="Profile">
                    <IconEdit onClick={openCore} />
                  </AccessAction>
                ) : undefined
              }
              /* Surfaced here so HR doesn't have to open the Employment tab to learn the person is on
                 their way out or not started yet. Only exception states earn badge chrome. */
              status={
                <>
                  {/* Derived reachability, and the record's own exception states. Different questions, so
                      both can be true at once: someone on probation can also be on leave today. */}
                  <PresencePill presence={presence} />
                  {emp.disabled && <Badge variant="secondary">Inactive</Badge>}
                  {!emp.disabled && onProbation && <Badge variant="warning" data-sentry-mask>{probationLabel(emp.probation_end_date!) || "On probation"}</Badge>}
                </>
              }
              actions={
                /* Every action VISIBLE - none of them behind an overflow menu. They are one weight, so the row
                   does not mix a labelled button with a bare icon. On a phone the secondary ones drop to their
                   icons (HEADER_BTN_LABEL) so they still fit one line - still present, still reachable, still
                   named to a screen reader; only the primary keeps its text. */
                <>
                  {/* Recognition is person-shaped: the top bar's global button lands on the board with an
                      empty recipient picker, so the praise you meant to give starts with finding the person
                      again. Here they are already in hand - the intent carries them, and the composer opens
                      filled in. Same route the "say well done" button on a completed goal takes. Hidden on
                      your own profile: there is no self-kudos flow. */}
                  {me.employee_id !== id && (
                    <AccessAction collection="announcements" verb="giveKudos" label="Give kudos">
                      <button type="button" className={HEADER_BTN} title={`Give kudos to ${emp.first_name}`} onClick={() => { navigate("announcements"); fireIntent("give-kudos", `employees/${id}`); }}>
                        <Sparkles className="h-[15px] w-[15px] text-amber-500" /> <span className={HEADER_BTN_LABEL}>Kudos</span>
                      </button>
                    </AccessAction>
                  )}
                  <button type="button" className={HEADER_BTN} title="Org chart" onClick={() => navigate(`org-chart/${id}`)}>
                    <Network className="h-[15px] w-[15px]" /> <span className={HEADER_BTN_LABEL}>Org chart</span>
                  </button>
                  {/* The mock's one filled action. "Schedule a 1:1" is the check-ins module, which is what a
                      1:1 already is here - not a new meeting feature. On your own record the equivalent is
                      editing it, which is the same dialog the facts band's pencil opens. */}
                  {me.employee_id === id ? (
                    canManage && (
                      <button type="button" className={HEADER_BTN_PRIMARY} onClick={openCore}>
                        <Pencil className="h-[15px] w-[15px]" /> Edit profile
                      </button>
                    )
                  ) : (
                    <AccessAction collection="check-ins" create>
                      <button type="button" className={HEADER_BTN_PRIMARY} onClick={() => { navigate("check-ins"); fireIntent("new-checkin", `employees/${id}`); }}>
                        <CalendarPlus className="h-[15px] w-[15px]" /> Schedule 1:1
                      </button>
                    </AccessAction>
                  )}
                </>
              }
              /* The record's sections, as the card's last band. They describe this record, so they belong to
                 its card rather than floating underneath it as a detached strip. */
              tabs={
                /* Below `sm` the gear cannot share the line. Seven tabs are already wider than a phone, so
                   the strip is scrolling at that width, and a `shrink-0` button beside it takes its width out
                   of the strip rather than out of the empty space there isn't any of - the last tab ends up
                   under the gear's edge. So the row WRAPS below `sm`: the gear takes a line of its own
                   (`order-1`, right-aligned) and the strip takes the full width under it (`order-2`), which
                   also keeps the strip's baseline directly above the panel it names. From `sm` up both are
                   back on one line, strip left and gear right, unchanged. */
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {/* `mb-0 border-b-0`: inside the card the bottom edge is this strip's baseline. */}
                  <TabsList variant="underline" className="order-2 mb-0 w-full min-w-0 border-b-0 sm:order-1 sm:w-auto">
                    <AccessTab value="profile" target={{ collection: "employees", objectPath: empPath, label: "Profile" }}><UserRound className="h-4 w-4" /> Profile</AccessTab>
                    <AccessTab value="employment" target={{ collection: "employees", objectPath: empPath, label: "Employment" }}><Briefcase className="h-4 w-4" /> Employment</AccessTab>
                    {/* `canLeave`/`canAttendance`, the same gates the panels and `tabValues` use - grants, and
                        not "are there rows": a caller who may read this person's leave and finds none still
                        gets the tab, and the empty state written for exactly that case. Both are false on
                        one's own record, where the Leaves and Attendance pages are the place instead. */}
                    {canLeave && <AccessTab value="leave" target={{ collection: "leave-requests", label: "Leave" }}><CalendarDays className="h-4 w-4" /> Leave</AccessTab>}
                    {canAttendance && <AccessTab value="attendance" target={{ collection: "attendance", label: "Attendance" }}><Clock className="h-4 w-4" /> Attendance</AccessTab>}
                    {canIdentityTab && <AccessTab value="identity" target={{ collection: "employees", objectPath: empPath, field: "identity", label: "Identity" }}><IdCard className="h-4 w-4" /> Identity</AccessTab>}
                    {/* Three collections behind one tab, so the key points at `goals` - the one of the three
                        whose grant an org actually tunes per person. */}
                    {canPerformance && <AccessTab value="performance" target={{ collection: "goals", label: "Performance" }}><Target className="h-4 w-4" /> Performance</AccessTab>}
                    {canPosts && <AccessTab value="posts" target={{ collection: "announcements", label: "Posts" }}><MessageSquare className="h-4 w-4" /> Posts</AccessTab>}
                    {(canTax || canComp || canBonuses || canSettlement || canPayslips) && <AccessTab value="compensation" target={{ collection: "compensation", label: "Compensation" }}><Wallet className="h-4 w-4" /> Compensation</AccessTab>}
                    {canDocs && <AccessTab value="documents" target={{ collection: "personal-documents", label: "Documents" }}><FileText className="h-4 w-4" /> Documents</AccessTab>}
                    {canActivity && <AccessTab value="activity" target={{ collection: "employees", objectPath: empPath, label: "Activity" }}><History className="h-4 w-4" /> Activity</AccessTab>}
                    {/* Not an AccessTab: this tab is ABOUT access rather than governed by one. `shrink-0` for
                        the reason AccessTab's own wrapper carries it - in a scrolling strip a shrinkable
                        trigger is squeezed narrower than its nowrap label and spills over the next. */}
                    {isSelf && <TabsTrigger value="privacy" className="shrink-0"><ShieldCheck className="h-4 w-4" /> Privacy</TabsTrigger>}
                  </TabsList>
                  {tabGears(tab)}
                </div>
              }
            />
            <EditBioDialog employeeId={id} current={emp.bio} open={bioOpen} onOpenChange={setBioOpen} onSaved={reload} />

              <TabsContent value="profile" className="space-y-4">
                {/* Server sends the flags to the owner + HR only. Two things follow from one page serving both
                    addresses: the wording is the reader's ("Finish your profile" on your own record, "This
                    record is incomplete" on somebody else's), and the SIGNATURE chip belongs again - it used
                    to be stripped because the signature lived on the other implementation of this page, and it
                    is on the Identity tab here, which is where `gotoRecordItem` sends it - on one's OWN
                    record. The signature panel is owner-only (the server refuses every other read of it), so
                    the chip is dropped for anybody else rather than jumping them to a tab with no signature on
                    it; the server strips that flag for non-owners too, and the two now say the same thing. */}
                {emp.profile_completeness && (
                  <ProfileCompleteness
                    variant={isSelf ? "self" : "record"}
                    flags={emp.profile_completeness}
                    canOpen={canOpenSection}
                    onItem={gotoRecordItem}
                  />
                )}
                {/* No "Profile" card here: the header's facts band is that card, one screen higher and
                    without the second copy of every value. Its edit pencil moved up with it. */}
                {/* Personal facts and how to reach the person are the same conversation, so Contact is a card
                    on this tab rather than a tab of its own. */}
                {canPersonal && <EmployeeProfilePersonal employeeId={id} canEdit={canPersonalEdit} />}
                {canPersonal && <EmployeePersonalDetails employeeId={id} canEdit={canPersonalEdit} />}
                {/* Emergency reads from the same encrypted blob and is asked for in the same sitting, so it is
                    the third card here rather than a button in the header - `reload` because the completeness
                    flags the meter above draws ride the employee row. */}
                {canPersonal && <EmployeeEmergencyDetails employeeId={id} canEdit={canPersonalEdit} onSaved={reload} />}
              </TabsContent>

              <TabsContent value="employment" className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
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
                        <dd className="mt-0.5 font-medium" data-sentry-mask>{emp.probation_end_date ? formatDate(emp.probation_end_date) : "-"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Status</dt>
                        <dd className="mt-0.5">
                          {emp.probation_end_date ? (
                            <Badge variant={onProbation ? "warning" : "success"} data-sentry-mask>{onProbation ? "On probation" : "Confirmed"}</Badge>
                          ) : (
                            "-"
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">EPF</dt>
                        <dd className="mt-0.5 font-medium">{emp.epf_enrolled ? "Enrolled" : "Not enrolled"}</dd>
                      </div>
                      {emp.tracked_from && (
                        <div>
                          <dt className="text-muted-foreground">HRMS records start</dt>
                          <dd className="mt-0.5 font-medium">{formatDate(emp.tracked_from)}</dd>
                        </div>
                      )}
                    </dl>
                  </CardContent>
                </Card>
                {canPositions && <EmployeeRoleHistory employeeId={id} canEdit={canPositionsEdit} />}
                {/* The kit the job came with. Its own collection grant still gates it, so a colleague who can
                    read the employment terms but not the asset register sees the cards above and no more. */}
                {canAssets && (
                  <EmployeeAssets
                    employeeId={id}
                    employeeName={`${emp.first_name} ${emp.last_name}`}
                    canAssign={canAssetsEdit}
                    isSelf={isSelf}
                    requestNow={requestAsset}
                    onRequestHandled={() => setRequestAsset(false)}
                  />
                )}
              </TabsContent>

              {canLeave && (
                <TabsContent value="leave" className="space-y-4">
                  {myBalances.length === 0 && myLeaves.length === 0 && (
                    <Card>
                      <CardContent className="py-6 text-center text-sm text-muted-foreground sm:py-6">
                        {`No leave recorded for ${emp.first_name} yet.`}
                      </CardContent>
                    </Card>
                  )}
                  {myBalances.length > 0 && (
                    <Card>
                      <CardHeader><CardTitle className="text-base">Leave balances</CardTitle></CardHeader>
                      <CardContent>
                        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
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
                        <div className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto">
                          {/* Five columns of dates: a labelled block per request on a phone. */}
                          <table className="table-stack w-full text-sm">
                            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Type</th><th className="py-2 pr-3 font-medium">From</th><th className="py-2 pr-3 font-medium">To</th><th className="py-2 pr-3 text-right font-medium">Days</th><th className="py-2 font-medium">Status</th></tr></thead>
                            <tbody>
                              {myLeaves.map((l) => (
                                <tr key={l.path} className="border-b last:border-0">
                                  <td className="py-1.5 pr-3 font-medium">{typeName(l.leave_type)}</td>
                                  <td data-label="From" className="py-1.5 pr-3 tabular-nums">{formatDate(l.start_date)}</td>
                                  <td data-label="To" className="py-1.5 pr-3 tabular-nums">{formatDate(l.end_date)}</td>
                                  <td data-label="Days" className="py-1.5 pr-3 text-right tabular-nums">{l.days}</td>
                                  <td data-label="Status" className="py-1.5"><StatusBadge state={l.state} /></td>
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

              {canAttendance && (
                <TabsContent value="attendance">
                  {/* The same history the person reads on their own Attendance page, over this record instead:
                      the day-by-day log, its punches, and why a day has none. Read-only - a correction is the
                      employee's to file and an approver's to answer, not something written into their record
                      from here. It reads its own window (`GET /v1/attendance?employee=`, scoped server-side),
                      so nothing is fetched until this tab is opened. */}
                  <AttendanceHistory
                    employeeId={id}
                    joinedYmd={emp.start_date}
                    trackedFromYmd={trackedFromOf(emp)}
                    win={attendanceWin}
                    sched={sched}
                    orgToday={orgToday}
                    title="Attendance"
                    // The server's answer about THIS person: an org that lets a team lead re-value their
                    // reports' days gets the affordance on exactly those records and nowhere else.
                    // A day mark is a decision about what a day is PAID as, and the server refuses it from the
                    // person whose day it is (services/attendanceDayMarks.ts `assertSomebodyElse`) however
                    // broad the grant - which this tab is already narrowed to, since it does not render on
                    // one's own record at all.
                    canMark={canWrite("attendance-day-marks")}
                    canExport={canExportAttendance}
                    exportName={`attendance-${emp.first_name} ${emp.last_name}`.toLowerCase().replace(/\s+/g, "-")}
                    emptyText={`No attendance recorded for ${emp.first_name} yet.`}
                  />
                </TabsContent>
              )}

              {canIdentityTab && (
                <TabsContent value="identity" className="space-y-4">
                  {/* Government IDs and the bank account are the same errand, so they share one tab - but they
                      are two grants, and an org is free to hand out one without the other. Each panel asks for
                      its own, so the tab can arrive with either half. */}
                  {canIdentity && <EmployeeIdentityDetails employeeId={id} canEdit={canIdentityEdit} />}
                  {/* Closed until asked for: sharing this tab would otherwise read the account number, and
                      write the audit row that says somebody read it, on every Identity open. */}
                  {canBankDetails && <RevealCard
                    title="Bank details"
                    icon={<Landmark className="h-4 w-4 text-primary" />}
                    hint="Opening this reads the account number, and records that you did."
                    defaultOpen={isSelf}
                    target={{ collection: "employees", objectPath: empPath, field: "bank-account", label: "Bank details" }}
                  >
                    <EmployeeBankDetails employeeId={id} canEdit={canBankEdit} />
                  </RevealCard>}
                  {/* The mark that stands in for their hand on a document. It lived only on the self page, so
                      an admin looking at why a letter would not e-sign could not see whether one existed. */}
                  {/* OWNER-ONLY, and not by a grant: `services/employeePhoto.ts assertOwner` refuses every
                      read, upload and clear of a signature that is not the caller's own, and the serializer
                      strips even the existence marker from anybody else (routes/employees.ts). So this is
                      `isSelf`, not an identity gate - an HR admin who holds `employees.*.identity` was being
                      shown an empty signature sheet with an Upload button that could only ever 403. A
                      person's signature is the whole input to forging the letters this app e-signs, which is
                      why that rule is structural rather than grantable. */}
                  {isSelf && <SignatureField employeeId={id} signature={emp.signature} canEdit onChanged={reload} />}
                </TabsContent>
              )}
              {canPerformance && (
                <TabsContent value="performance" className="space-y-4">
                  <EmployeePerformance employeeId={id} isSelf={isSelf} />
                </TabsContent>
              )}
              {canPosts && (
                <TabsContent value="posts" className="space-y-4">
                  <EmployeePosts employeeId={id} isSelf={isSelf} />
                </TabsContent>
              )}
              {(canTax || canComp || canBonuses || canSettlement || canPayslips) && (
                <TabsContent value="compensation" className="space-y-4">
                  {/* Two shapes of the same card, and the split is deliberate rather than legacy: a
                      self-service read carries no grade or band (those are the org's ladder, not your pay),
                      so reading one's own salary is a different resource from an admin reading it. */}
                  {canComp && (isSelf
                    ? <MyCompensation employeeId={id} />
                    : <EmployeeCompensation employeeId={id} canEdit={canCompEdit} epfEnrolled={!!emp.epf_enrolled} />)}
                  {/* Tax sits with pay: declarations and the withholding they change are read together. Its
                      own capability still gates it, so a payroll viewer without it sees the rest - and it is
                      closed until asked for, for the reason the bank card on Identity is. */}
                  {canTax && (
                    <RevealCard
                      title="Income tax (TDS)"
                      icon={<Landmark className="h-4 w-4 text-primary" />}
                      hint="Opening this reads their declarations and projection, and records that you did."
                      defaultOpen={isSelf}
                      target={{ collection: "employees", objectPath: empPath, field: "tax", label: "Tax" }}
                    >
                      <EmployeeTaxDetails employeeId={id} canEdit={canTaxEdit} canVerify={canTaxVerify} />
                    </RevealCard>
                  )}
                  {canBonuses && <EmployeeBonuses employeeId={id} canEdit={canBonusesEdit} />}
                  {/* What was actually PAID, under the contract above it: the published slips for this person.
                      Last in the tab because it is the historical record - the cards above are the current
                      state somebody opens this tab to change. */}
                  {canPayslips && <EmployeePayslips employeeId={id} />}
                  {canSettlement && <EmployeeSettlement employeeId={id} canEdit={canSettlementEdit} />}
                </TabsContent>
              )}
              {canDocs && (
                <TabsContent value="documents">
                  {/* Issuing a Form 16 or a letter is an HR act on somebody's record, not something every
                      reader of the tab can do - and on your own profile it was never offered at all. One rule
                      now, and it is the write grant rather than the read that opened the tab.
                      Filing the insurance e-card is NOT one of those acts: it is a document somebody files
                      about themselves, so it rides the personal-documents write grant for this person, which
                      the owner holds on their own record and HR does not automatically hold on anybody's. */}
                  {(canManage || canDocsEdit) && (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {canDocsEdit && <UploadInsuranceButton employeeId={id} onUploaded={() => setDocsKey((k) => k + 1)} />}
                      {canManage && (
                        <>
                          <GenerateForm16Button employeeId={id} onGenerated={() => setDocsKey((k) => k + 1)} />
                          <UploadForm16Button employeeId={id} onUploaded={() => setDocsKey((k) => k + 1)} />
                          <GenerateLetterButton employeeId={id} onGenerated={() => setDocsKey((k) => k + 1)} />
                        </>
                      )}
                    </div>
                  )}
                  <EmployeeDocuments key={docsKey} employeeId={id} />
                </TabsContent>
              )}
              {canActivity && (
                <TabsContent value="activity" className="space-y-6">
                  {/* Two different questions, and the tab used to answer only the first. `resource` is writes to
                      the EMPLOYEE RECORD - a bank detail, a manager change. `subject` is everything that
                      happened to this person anywhere: the leave they filed, the pay that was revised, the
                      asset they were issued. The second is what somebody opening an employee's activity
                      actually means, and it spans a dozen collections that the record's own trail never sees. */}
                  {/* Gated on the ORG-WIDE grant, not on employees-activity: `?subject` rides the org-wide
                      branch server-side (a person's cross-collection timeline reveals more than any single
                      record in it), so offering it to a caller who only holds `activity.employees.read` would
                      render a panel that can only 403. */}
                  {canOrgActivity && (
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Everything about this person</p>
                      <ActivityFeed global subject={empPath} />
                    </div>
                  )}
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Changes to the employee record</p>
                    <ActivityFeed resource={empPath} />
                  </div>
                </TabsContent>
              )}
              {isSelf && (
                <TabsContent value="privacy">
                  <div className="space-y-4">
                    {/* The person's own app lock (lib/appLock.ts): theirs to set, and nobody else's to see. */}
                    <section aria-label="App lock" className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
                      <AppLockSettings />
                    </section>
                    <MyViewers selfPath={empPath} />
                  </div>
                </TabsContent>
              )}
            </Tabs>

            <WriteDialog
              open={coreOpen}
              onClose={() => setCoreOpen(false)}
              title="Edit profile"
              description="Who they are and where they sit. Changes show up in the directory, org chart and approval routing straight away."
              collection="employees"
              objectPath={empPath}
              guardLabel="profile edit"
              form={core}
              submitLabel="Save changes"
              canSubmit={coreValid}
              whyNot={coreWhyNot}
              onSubmit={saveCore}
            >
                <FieldRow>
                  <Field label="First name"><Input value={core.first_name} onChange={(e) => setCore({ ...core, first_name: e.target.value })} autoFocus /></Field>
                  <Field label="Last name"><Input value={core.last_name} onChange={(e) => setCore({ ...core, last_name: e.target.value })} /></Field>
                </FieldRow>
                <Field label="Legal name" hint="As on official documents/IDs/bank. Used for signing and letter sign-off. Leave blank to use the display name."><Input value={core.legal_name} onChange={(e) => setCore({ ...core, legal_name: e.target.value })} placeholder={`${core.first_name} ${core.last_name}`.trim()} /></Field>
                <Field label="Employee ID" field="employee_number" hint="Shown on payslips and letters, e.g. EMP-0042. Must be unique."><Input value={core.employee_number} onChange={(e) => setCore({ ...core, employee_number: e.target.value })} className="font-mono" /></Field>
                <Field label="Work email" error={core.work_email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(core.work_email.trim()) ? "Enter a valid email address." : undefined}><Input type="email" value={core.work_email} onChange={(e) => setCore({ ...core, work_email: e.target.value })} /></Field>
                <Field label="Job title"><Input value={core.job_title} onChange={(e) => setCore({ ...core, job_title: e.target.value })} /></Field>
                <FieldRow>
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
                      // Self AND everyone under them: pointing somebody's manager at their own report closes
                      // the reporting line into a loop, which `assertNoManagerCycle` now refuses server-side.
                      // Excluding them here means the picker stops offering a move that will come back as an
                      // error. See `reportsUnder` on why this narrows rather than decides.
                      options={[{ value: NONE, label: "None" }, ...employees.filter((e) => !e.disabled && idOf(e.path) !== id && !managerCycleIds.has(idOf(e.path))).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))]}
                    />
                  </Field>
                </FieldRow>
            </WriteDialog>

            <WriteDialog
              open={empOpen}
              onClose={() => setEmpOpen(false)}
              title="Edit employment"
              description="Start date and probation drive leave accrual and the confirmation badge; EPF changes what payroll deducts from the next run."
              collection="employees"
              objectPath={empPath}
              guardLabel="employment edit"
              form={empForm}
              submitLabel="Save changes"
              canSubmit={empDatesOk}
              whyNot="Probation can't end before the start date."
              onSubmit={saveEmp}
            >
                <FieldRow>
                  <Field label="Start date" hint="Drives leave accrual."><Input type="date" value={empForm.start_date} onChange={(e) => setEmpForm({ ...empForm, start_date: e.target.value })} autoFocus /></Field>
                  <Field label="Probation ends" hint="Leave blank to clear." error={!empDatesOk ? "Probation can't end before the start date." : undefined}><Input type="date" min={empForm.start_date || undefined} value={empForm.probation_end_date} onChange={(e) => setEmpForm({ ...empForm, probation_end_date: e.target.value })} /></Field>
                </FieldRow>
                <Field
                  label="HRMS records start"
                  field="tracked_from"
                  hint="For someone who joined before your org started using HRMS. Days before this date with no punches, mark or leave are never counted as absences or docked. Leave blank for anyone hired since."
                >
                  <Input type="date" max={orgToday} value={empForm.tracked_from} onChange={(e) => setEmpForm({ ...empForm, tracked_from: e.target.value })} />
                </Field>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-input" checked={empForm.epf_enrolled} onChange={(e) => setEmpForm({ ...empForm, epf_enrolled: e.target.checked })} />
                  <span>Enrolled in EPF<span className="block text-xs text-muted-foreground">Opt-in. Adds the provident-fund deduction and the employer PF share within CTC.</span></span>
                </label>
                {empForm.epf_enrolled && (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-input" checked={empForm.eps_excluded} onChange={(e) => setEmpForm({ ...empForm, eps_excluded: e.target.checked })} />
                    <span>Excluded from EPS<span className="block text-xs text-muted-foreground">Tick when their pay was already above the pension wage ceiling when they first joined EPF. The whole employer share then stays in EPF instead of 8.33% going to the pension fund. Affects the statutory register and PF challan only, never take-home.</span></span>
                  </label>
                )}
                {!!emp.epf_enrolled !== empForm.epf_enrolled && (
                  <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                    {empForm.epf_enrolled
                      ? "Enrolling adds a PF deduction and the employer share to their CTC build-up. You'll be offered a re-split of their pay after saving."
                      : "Un-enrolling drops the PF lines, which changes take-home and the CTC they were promised. You'll be offered a re-split after saving."}
                  </p>
                )}
            </WriteDialog>
          </>
        )}
      </DataState>
    </div>
    </AccessScope>
    </SubjectScopesContext.Provider>
  );
}
