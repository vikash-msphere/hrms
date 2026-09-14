import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, CalendarPlus, ChevronLeft, ChevronRight, HeartPulse, Network, Pencil, Sparkles,
  UserRound, Contact, Briefcase, CalendarDays, IdCard, Landmark, ShieldCheck, Wallet, Package, FileText, History,
} from "lucide-react";
import { useEmployee } from "@/hooks/useEmployee";
import { useCollection } from "@/hooks/useCollection";
import { usePresence } from "@/hooks/usePresence";
import { get, patch } from "@/api";
import { formatDate, formatMonthYear, humanize, idOf, probationLabel, tenureDuration } from "@/lib/utils";
import { navigate } from "@/router";
import { fireIntent } from "@/lib/intent";
import { usePermission, useCanSeeActivity, useIsSuperAdmin } from "@/lib/perm";
import type { Department, Employee, LeaveBalance, LeaveRequest, LeaveType, Me, PersonalDetails } from "@/types";
import { StatusBadge } from "@/components/common/StatusBadge";
import { DataState } from "@/components/common/DataState";
import { ProfileView, ProfileFact, HEADER_BTN, HEADER_BTN_PRIMARY } from "@/components/common/ProfileView";
import { PresencePill, PresenceNote } from "@/components/common/PresencePill";
import { PeopleList } from "@/components/common/PeopleList";
import { ProfileStickyBar } from "@/components/common/ProfileStickyBar";
import { EditBioDialog } from "@/components/common/EditBioDialog";
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
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { AccessTab } from "@/components/common/AccessTab";
import { SettingsButton } from "@/components/common/SettingsButton";
import { useToast } from "@/components/ui/use-toast";
import { useSplitStaleness } from "@/hooks/useSplitStaleness";

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

// `sub` is the URL's third segment (…#/employees/<id>/<sub>): the active tab, so tabs are
// deep-linkable and survive refresh. Absent/unknown/not-permitted values fall back to "profile".
export default function EmployeeProfile({ id, me, sub }: { id: string; me: Me; sub?: string }) {
  const empPath = `employees/${id}`;
  // Core profile + employment fields are HR/super_admin only (not self-service).
  const canManage = usePermission("employees.write");
  const canActivity = useCanSeeActivity("employees"); // gates the Activity tab (server ANDs with employee read)
  // The org-wide audit grant, which is what `?subject` needs - see the note on that panel below.
  const canOrgActivity = useCanSeeActivity();
  // Personal/bank details are visible to the employee themselves and super_admin only - these are the
  // field-precise sub-resources (src/domain/grants.ts OWN_PII), never reached by the broad `employees.write`
  // grant HR/manager hold for the directory (that's `canManage`, deliberately not used here).
  const isSuperAdmin = useIsSuperAdmin();
  const canBank = me.employee_id === id || isSuperAdmin;
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
  const { rows: depts } = useCollection<Department>("departments", { all: true });
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: types } = useCollection<LeaveType>("leave-types");
  // This person's balances, narrowed server-side. Filtering a page of the whole collection in the browser was
  // both dearer and blind to anything past the cursor.
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances", { params: { employee: `employees/${id}` } });
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
  const { rows: leaveReqs } = useCollection<LeaveRequest>("leave-requests", { params: { employee: `employees/${id}` } });
  const myLeaves = useMemo(() => [...leaveReqs].sort((a, b) => b.start_date.localeCompare(a.start_date)), [leaveReqs]);

  const onProbation = !!emp?.probation_end_date && Date.parse(emp.probation_end_date) >= Date.now();

  // Which tabs THIS viewer gets (mirrors the render gates below) - guards the URL's tab segment.
  const tabValues = useMemo(() => {
    const t = new Set(["profile", "employment", "documents"]);
    if (canBank) { t.add("contact"); t.add("identity"); t.add("bank"); }
    if (myBalances.length > 0 || myLeaves.length > 0) t.add("leave");
    if (canTax) t.add("tax");
    if (canComp || canBonuses || canSettlement) t.add("compensation");
    if (canAssets) t.add("assets");
    if (canActivity) t.add("activity");
    return t;
  }, [canBank, myBalances.length, myLeaves.length, canTax, canComp, canBonuses, canSettlement, canAssets, canActivity]);
  const tab = sub && tabValues.has(sub) ? sub : "profile";
  const setTab = (v: string) => navigate(v === "profile" ? `employees/${id}` : `employees/${id}/${v}`);

  // Org relations + prev/next stepping, all from the already-cached employees collection.
  const liveEmployees = useMemo(() => employees.filter((e) => !e.delete_time), [employees]);
  const empIdx = liveEmployees.findIndex((e) => idOf(e.path) === id);
  const prevEmp = empIdx > 0 ? liveEmployees[empIdx - 1] : undefined;
  const nextEmp = empIdx >= 0 ? liveEmployees[empIdx + 1] : undefined;
  const directReports = useMemo(() => liveEmployees.filter((e) => e.manager && idOf(e.manager) === id), [liveEmployees, id]);
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
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  // What the sticky bar watches: while this header is off screen, the bar carries the identity instead.
  const headerRef = useRef<HTMLDivElement | null>(null);
  // Derived reachability for the status pill and the on-leave note. Lazy and failure-silent: see
  // hooks/usePresence.ts for why it is not a field on the record.
  const presence = usePresence(id);
  // The phone for the facts band. Only fetched when the viewer may see it at all (`canBank` is owner-or-
  // super, the same gate the server gives the encrypted blob), so a colleague's profile makes no request
  // that could only come back redacted. Failure-silent for the same reason presence is: the cell is a
  // convenience on a page that has already loaded.
  const [personal, setPersonal] = useState<PersonalDetails | null>(null);
  useEffect(() => {
    setPersonal(null);
    if (!canBank) return;
    let active = true;
    get<PersonalDetails>(`employees/${id}/personal-info`)
      .then((p) => active && setPersonal(p))
      .catch(() => undefined);
    return () => { active = false; };
  }, [id, canBank]);
  // Completeness chips jump to the section where the data is filled in (mirrors /profile's gotoItem).
  function gotoRecordItem(key: CompletenessKey) {
    if (key === "photo") setPhotoOpen(true);
    else if (key === "emergency") setEmergencyOpen(true);
    else if (key === "personal") setTab("profile");
    else setTab(key); // contact / identity / bank are tabs of the same name
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
  const [empForm, setEmpForm] = useState({ start_date: "", probation_end_date: "", epf_enrolled: false, eps_excluded: false });
  // Offer to re-solve pay splits when a change here moves one (EPF enrolment). Silent for everything else.
  const { promptReapply } = useSplitStaleness({ auto: false });
  function openEmp() {
    setEmpForm({ start_date: emp?.start_date ?? "", probation_end_date: emp?.probation_end_date ?? "", epf_enrolled: !!emp?.epf_enrolled, eps_excluded: !!emp?.eps_excluded });
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
    await savePatch(
      { start_date: empForm.start_date || null, probation_end_date: empForm.probation_end_date || null, epf_enrolled: empForm.epf_enrolled, eps_excluded: empForm.eps_excluded },
      "Employment updated",
    );
    if (enrolmentChanged) await promptReapply();
  };

  // Right-aligned gear row for a tab's inline settings; nothing renders when the caller can't configure.
  // `ml-auto` rather than a `justify-between` on the parent: below `sm` the parent's row wraps and the strip
  // takes the whole first line, where `justify-between` would have nothing to push against (see the tab band).
  const tabGears = (tab: string) => {
    const keys = TAB_SETTINGS[tab];
    if (!canSettings || !keys?.length) return null;
    return (
      <div className="order-1 ml-auto flex shrink-0 items-center gap-2 sm:order-2">
        {keys.map((k) => <SettingsButton key={k} me={me} settingKey={k} />)}
      </div>
    );
  };

  return (
    <div>
      <DataState state={state} error={error} rows={2}>
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
              avatar={<PhotoAvatar className="h-[68px] w-[68px] rounded-[14px] sm:h-[92px] sm:w-[92px] sm:rounded-[18px]" employeeId={id} name={`${emp.first_name} ${emp.last_name}`} photo={emp.photo} editable={canBank} onChanged={reload} open={photoOpen} onOpenChange={setPhotoOpen} />}
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
                  {canBank && personal?.personal_phone && (
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
                  {!emp.disabled && onProbation && <Badge variant="warning">{probationLabel(emp.probation_end_date!) || "On probation"}</Badge>}
                </>
              }
              actions={
                /* Every action visible and every one labelled. The row used to mix a labelled button, a
                   second labelled button and a bare red icon; the fix is one weight, not fewer actions -
                   emergency details in particular is the last thing to hide behind a menu. */
                <>
                  {/* Recognition is person-shaped: the top bar's global button lands on the board with an
                      empty recipient picker, so the praise you meant to give starts with finding the person
                      again. Here they are already in hand - the intent carries them, and the composer opens
                      filled in. Same route the "say well done" button on a completed goal takes. Hidden on
                      your own profile: there is no self-kudos flow. */}
                  {me.employee_id !== id && (
                    <AccessAction collection="announcements" verb="giveKudos" label="Give kudos">
                      <button type="button" className={HEADER_BTN} title={`Give kudos to ${emp.first_name}`} onClick={() => { navigate("announcements"); fireIntent("give-kudos", `employees/${id}`); }}>
                        <Sparkles className="h-[15px] w-[15px] text-amber-500" /> Kudos
                      </button>
                    </AccessAction>
                  )}
                  {canBank && (
                    <button type="button" className={HEADER_BTN} onClick={() => setEmergencyOpen(true)}>
                      <HeartPulse className="h-[15px] w-[15px] text-destructive" /> Emergency
                    </button>
                  )}
                  <button type="button" className={HEADER_BTN} onClick={() => navigate(`org-chart/${id}`)}>
                    <Network className="h-[15px] w-[15px]" /> Org chart
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
                /* Below `sm` the gear cannot share the line. Eleven tabs are already wider than a phone, so
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
                    {canBank && <AccessTab value="contact" target={{ collection: "employees", objectPath: empPath, field: "personal-info", label: "Contact" }}><Contact className="h-4 w-4" /> Contact</AccessTab>}
                    <AccessTab value="employment" target={{ collection: "employees", objectPath: empPath, label: "Employment" }}><Briefcase className="h-4 w-4" /> Employment</AccessTab>
                    {(myBalances.length > 0 || myLeaves.length > 0) && <AccessTab value="leave" target={{ collection: "leave-requests", label: "Leave" }}><CalendarDays className="h-4 w-4" /> Leave</AccessTab>}
                    {canBank && <AccessTab value="identity" target={{ collection: "employees", objectPath: empPath, field: "identity", label: "Identity" }}><IdCard className="h-4 w-4" /> Identity</AccessTab>}
                    {canBank && <AccessTab value="bank" target={{ collection: "employees", objectPath: empPath, field: "bank-account", label: "Bank details" }}><Landmark className="h-4 w-4" /> Bank details</AccessTab>}
                    {canTax && <AccessTab value="tax" target={{ collection: "employees", objectPath: empPath, field: "tax", label: "Tax" }}><ShieldCheck className="h-4 w-4" /> Tax</AccessTab>}
                    {(canComp || canBonuses || canSettlement) && <AccessTab value="compensation" target={{ collection: "compensation", label: "Compensation" }}><Wallet className="h-4 w-4" /> Compensation</AccessTab>}
                    {canAssets && <AccessTab value="assets" target={{ collection: "assets", label: "Assets" }}><Package className="h-4 w-4" /> Assets</AccessTab>}
                    <AccessTab value="documents" target={{ collection: "personal-documents", label: "Documents" }}><FileText className="h-4 w-4" /> Documents</AccessTab>
                    {canActivity && <AccessTab value="activity" target={{ collection: "employees", objectPath: empPath, label: "Activity" }}><History className="h-4 w-4" /> Activity</AccessTab>}
                  </TabsList>
                  {tabGears(tab)}
                </div>
              }
            />
            {/* Triggerless: the labelled button above is this dialog's affordance now. Mounted out here
                beside the other header dialogs rather than inside `actions`, which holds controls only. */}
            {canBank && <EmergencyQuickView employeeId={id} canEdit={canBank} open={emergencyOpen} onOpenChange={setEmergencyOpen} onSaved={reload} triggerless />}
            <EditBioDialog employeeId={id} current={emp.bio} open={bioOpen} onOpenChange={setBioOpen} onSaved={reload} />

              <TabsContent value="profile" className="space-y-4">
                {/* Server sends the flags to the owner + HR only. Signature is stripped client-side too:
                    it has no section on this page (managed on /profile), so a chip would dead-end. */}
                {emp.profile_completeness && (
                  <ProfileCompleteness variant="record" flags={{ ...emp.profile_completeness, signature: undefined }} onItem={gotoRecordItem} />
                )}
                {/* No "Profile" card here: the header's facts band is that card, one screen higher and
                    without the second copy of every value. Its edit pencil moved up with it. */}
                {canBank && <EmployeeProfilePersonal employeeId={id} canEdit={canBank} />}
              </TabsContent>

              {canBank && (
                <TabsContent value="contact">
                  <EmployeePersonalDetails employeeId={id} canEdit={canBank} />
                </TabsContent>
              )}

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
                  <EmployeeAssets employeeId={id} employeeName={`${emp.first_name} ${emp.last_name}`} canAssign={canAssetsEdit} isSelf={id === me.employee_id} />
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
                      options={[{ value: NONE, label: "None" }, ...employees.filter((e) => !e.disabled && idOf(e.path) !== id).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))]}
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
  );
}
