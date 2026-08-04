import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Skeleton } from "./components/ui/skeleton";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { api, setSessionExpiredHandler, setForbiddenHandler } from "./api";
import { useToast } from "./components/ui/use-toast";
import { useViewAs } from "./lib/viewAsStore";
import { useMe } from "./useMe";
import { useRoute } from "./router";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { CommandPalette } from "./components/layout/CommandPalette";
import { ShortcutLayer } from "./components/layout/ShortcutLayer";
import { Toaster } from "./components/ui/toaster";
import { ConfirmProvider } from "./components/common/confirm";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { AccessModeProvider } from "./components/access/AccessModeProvider";
import { AccessScope } from "./components/access/AccessScope";
import { CapabilitiesContext, hasCapability } from "./lib/perm";
import { OrgProvider } from "./lib/org";
import { setTablePrefsUser } from "./lib/tablePrefs";
import { syncThemeFromServer } from "./lib/theme";
import { syncTabSeenFromServer } from "./lib/tabActivity";
import { Workspace } from "./components/layout/Workspace";
import { ApprovalsProvider } from "./lib/approvals";
import { NotificationsProvider, NotificationClearOnLeave } from "./lib/notifications";
import { workspaceForKey, navPerm, APPROVAL_CAPS } from "./nav";
import { Building } from "lucide-react";
import { APP_NAME } from "./lib/brand";

// Route keys that are NOT 1:1 wire collections. A string rebinds the page-wide ambient access scope to the
// collection that page's content manages; null means the page has no single collection (cross-collection
// surfaces - dashboard, approvals, the settings hub - whose affordances all carry explicit targets), so NO
// ambient scope is provided: a forgotten explicit target then shows no icon rather than authoring rules on
// a phantom collection. Keys absent here match their collection already.
const ROUTE_SCOPE: Record<string, string | null> = {
  dashboard: null,
  approvals: null,
  documents: null, // org-documents + personal-documents tabs, each explicitly targeted
  settings: null, // hub of many collections; its :id is a tab name, not an object
  profile: null, // the page rebinds to the caller's own employees/<id>
  "org-chart": "employees",
  "leave-calendar": "leave-requests",
  benefits: "benefit-enrollments",
  schedule: "shift-assignments",
  timesheets: "time-entries",
  overtime: "overtime-requests",
  "remote-work": "remote-work-requests",
  delegations: "approval-delegations",
  kudos: "announcements",
  pipeline: "applications",
  compliance: "compliance-events",
  workflows: "automations",
  "recruiting-analytics": "applications",
  activity: "audit",
};
// Routes whose :id segment is a TAB name, not an object id - never pin the ambient scope to it.
const TAB_ID_ROUTES = new Set(["payroll-runs"]);

function RouteAccessScope({ page, id, children }: { page: string; id?: string | null; children: React.ReactNode }) {
  const collection = page in ROUTE_SCOPE ? ROUTE_SCOPE[page] : page;
  if (!collection) return <>{children}</>;
  // An object pin only makes sense when the ambient collection IS the route's own collection (a rebound
  // scope's object would belong to a different resource) and the id is a real object.
  const objectPath = id && collection === page && !TAB_ID_ROUTES.has(page) ? `${page}/${id}` : undefined;
  return <AccessScope collection={collection} objectPath={objectPath}>{children}</AccessScope>;
}

// Dashboard is the landing page - keep it in the main chunk so first paint needs no extra roundtrip.
// Every other page is its own chunk, fetched on first visit (route-level code splitting).
import Dashboard from "./pages/Dashboard";
const Approvals = lazy(() => import("./pages/Approvals"));
const Notifications = lazy(() => import("./pages/Notifications"));
const Profile = lazy(() => import("./pages/Profile"));
const Directory = lazy(() => import("./pages/Directory"));
const EmployeeProfile = lazy(() => import("./pages/EmployeeProfile"));
const Leaves = lazy(() => import("./pages/Leaves"));
const LeaveCalendar = lazy(() => import("./pages/LeaveCalendar"));
const OrgChart = lazy(() => import("./pages/OrgChart"));
const Goals = lazy(() => import("./pages/Goals"));
const Boards = lazy(() => import("./pages/Boards"));
const Reviews = lazy(() => import("./pages/Reviews"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const CheckIns = lazy(() => import("./pages/CheckIns"));
const Benefits = lazy(() => import("./pages/Benefits"));
const Schedule = lazy(() => import("./pages/Schedule"));
const Timesheets = lazy(() => import("./pages/Timesheets"));
const Loans = lazy(() => import("./pages/Loans"));
const TaxDeclarations = lazy(() => import("./pages/TaxDeclarations"));
const Attendance = lazy(() => import("./pages/Attendance"));
const Announcements = lazy(() => import("./pages/Announcements"));
const Holidays = lazy(() => import("./pages/Holidays"));
const Events = lazy(() => import("./pages/Events"));
const Documents = lazy(() => import("./pages/Documents"));
const Compliance = lazy(() => import("./pages/Compliance"));
const BackgroundChecks = lazy(() => import("./pages/BackgroundChecks"));
const Overtime = lazy(() => import("./pages/Overtime"));
const RemoteWork = lazy(() => import("./pages/RemoteWork"));
const Delegations = lazy(() => import("./pages/Delegations"));
const NoticePeriods = lazy(() => import("./pages/NoticePeriods"));
const Suggestions = lazy(() => import("./pages/Suggestions"));
const Payslips = lazy(() => import("./pages/Payslips"));
const Reimbursements = lazy(() => import("./pages/Reimbursements"));
const Expenses = lazy(() => import("./pages/Expenses"));
const Vendors = lazy(() => import("./pages/Vendors"));
const ExpenseBudgets = lazy(() => import("./pages/ExpenseBudgets"));
const Referrals = lazy(() => import("./pages/Referrals"));
const Pipeline = lazy(() => import("./pages/Pipeline"));
const Requisitions = lazy(() => import("./pages/Requisitions"));
const Candidates = lazy(() => import("./pages/Candidates"));
const CandidateProfile = lazy(() => import("./pages/CandidateProfile"));
const Interviews = lazy(() => import("./pages/Interviews"));
const Offers = lazy(() => import("./pages/Offers"));
const RecruitingAnalytics = lazy(() => import("./pages/RecruitingAnalytics"));
const Tickets = lazy(() => import("./pages/Tickets"));
const Assets = lazy(() => import("./pages/Assets"));
const PayrollRuns = lazy(() => import("./pages/PayrollRuns"));
const Settings = lazy(() => import("./pages/Settings"));
const Workflows = lazy(() => import("./pages/Workflows"));
const Activity = lazy(() => import("./pages/Activity"));

// Route-key -> the page's code-chunk loader. React.lazy only starts a chunk download when the page first
// RENDERS - which is AFTER `me` resolves and the shell has mounted, so the page's data reads land in a later
// coalescing window than the shell's -> a second batch:run. Kicking the chunk here, in parallel with `me`
// (see the prefetch effect), lets the page mount in the SAME commit as the shell so their reads collapse into
// ONE batch. The bundler dedups: this import and the lazy() above share the one chunk. Missing keys just fall
// back to lazy timing (no breakage). Dashboard is in the main chunk already, so it's omitted.
const PAGE_CHUNK: Record<string, () => Promise<unknown>> = {
  approvals: () => import("./pages/Approvals"), notifications: () => import("./pages/Notifications"),
  profile: () => import("./pages/Profile"), employees: () => import("./pages/Directory"),
  "org-chart": () => import("./pages/OrgChart"), attendance: () => import("./pages/Attendance"),
  "leave-requests": () => import("./pages/Leaves"), "leave-calendar": () => import("./pages/LeaveCalendar"),
  goals: () => import("./pages/Goals"), boards: () => import("./pages/Boards"), reviews: () => import("./pages/Reviews"),
  transitions: () => import("./pages/Onboarding"), "check-ins": () => import("./pages/CheckIns"),
  benefits: () => import("./pages/Benefits"), schedule: () => import("./pages/Schedule"),
  timesheets: () => import("./pages/Timesheets"), loans: () => import("./pages/Loans"),
  "tax-declarations": () => import("./pages/TaxDeclarations"), announcements: () => import("./pages/Announcements"),
  kudos: () => import("./pages/Announcements"), holidays: () => import("./pages/Holidays"),
  events: () => import("./pages/Events"), documents: () => import("./pages/Documents"),
  compliance: () => import("./pages/Compliance"), "background-checks": () => import("./pages/BackgroundChecks"),
  overtime: () => import("./pages/Overtime"), "remote-work": () => import("./pages/RemoteWork"),
  delegations: () => import("./pages/Delegations"),
  "notice-periods": () => import("./pages/NoticePeriods"), suggestions: () => import("./pages/Suggestions"),
  payslips: () => import("./pages/Payslips"), reimbursements: () => import("./pages/Reimbursements"),
  expenses: () => import("./pages/Expenses"), vendors: () => import("./pages/Vendors"), "expense-budgets": () => import("./pages/ExpenseBudgets"),
  referrals: () => import("./pages/Referrals"), pipeline: () => import("./pages/Pipeline"),
  "job-requisitions": () => import("./pages/Requisitions"), candidates: () => import("./pages/Candidates"),
  interviews: () => import("./pages/Interviews"), offers: () => import("./pages/Offers"),
  "recruiting-analytics": () => import("./pages/RecruitingAnalytics"), tickets: () => import("./pages/Tickets"),
  assets: () => import("./pages/Assets"), "payroll-runs": () => import("./pages/PayrollRuns"),
  "pay-periods": () => import("./pages/PayrollRuns"), workflows: () => import("./pages/Workflows"),
  activity: () => import("./pages/Activity"),
  // Deep-linked Settings tabs all resolve to the Settings chunk.
  settings: () => import("./pages/Settings"), departments: () => import("./pages/Settings"),
  "leave-types": () => import("./pages/Settings"), "pay-components": () => import("./pages/Settings"),
  users: () => import("./pages/Settings"), operations: () => import("./pages/Settings"),
};

// Route-chunk loading fallback: neutral header + content blocks, so the swap doesn't flash.
function PageLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

// Shown when the session expires MID-use: the app (and any half-typed form) stays mounted underneath while
// the user re-authenticates in a separate tab, then continues right where they were. Deliberately not
// dismissable - every request would just 401 again.
function SessionExpiredDialog({ open, onSignedIn }: { open: boolean; onSignedIn: () => void }) {
  const [checking, setChecking] = useState(false);
  const [stillDead, setStillDead] = useState(false);
  async function checkSignedIn() {
    setChecking(true);
    setStillDead(false);
    try {
      // Raw fetch on purpose: api()'s own 401 handling would re-fire the expired-session flow.
      const res = await fetch("/v1/users/me", { credentials: "include", headers: { "X-Requested-By": "hrms-spa" } });
      if (res.ok) onSignedIn();
      else setStillDead(true);
    } catch {
      setStillDead(true);
    } finally {
      setChecking(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-md" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Signed out</DialogTitle>
          <DialogDescription>
            Your session expired. Anything you were typing is still here - sign in again in a new tab, then
            come back and continue.
          </DialogDescription>
        </DialogHeader>
        {stillDead && <p className="text-sm text-destructive">Still signed out - finish signing in first, then try again.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => window.open("/auth/login", "_blank", "noopener")}>
            Open sign-in
          </Button>
          <Button loading={checking} onClick={() => void checkSignedIn()}>
            I've signed in - continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Building className="h-6 w-6" />
      </div>
      {children}
    </div>
  );
}

export default function App() {
  const { me, loaded, error, retry } = useMe();
  const route = useRoute();
  const { toast } = useToast();
  const viewAs = useViewAs();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [chunkReady, setChunkReady] = useState(false);
  const booted = useRef(false); // flips true after the first full render; after that, nav uses <Suspense>

  // Namespace the table-prefs cache by user before any table mounts.
  setTablePrefsUser(me?.email);

  // Pull cross-device preferences once the user is known.
  useEffect(() => {
    if (me) {
      syncThemeFromServer();
      syncTabSeenFromServer();
    }
  }, [me]);

  // With a signed-in shell on screen there is work worth preserving: a mid-session 401 overlays the
  // re-auth dialog instead of navigating away (see setSessionExpiredHandler in api.ts).
  useEffect(() => {
    if (!me) return;
    setSessionExpiredHandler(() => setSessionExpired(true));
    return () => setSessionExpiredHandler(null);
  }, [me]);

  // A 403 wall offers "Request access": one toast per collection per session, whose action notifies the
  // access admins (access-rules:requestAccess - itself permission-gated, so the offer quietly apologises
  // when the org hasn't enabled the flow). The probe opts out of the handler to avoid a toast loop.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!me) return;
    setForbiddenHandler((collection) => {
      if (asked.current.has(collection)) return;
      asked.current.add(collection);
      toast({
        title: "You don't have access to that",
        description: `Ask the access admins for ${collection.replace(/-/g, " ")}?`,
        action: {
          label: "Request access",
          onClick: () => {
            api("/access-rules:requestAccess", { method: "POST", body: JSON.stringify({ collection }), skipForbiddenHandler: true })
              .then(() => toast({ title: "Request sent", description: "The access admins have been notified.", variant: "success" }))
              .catch(() => toast({ title: "Couldn't send the request", description: "Access requests aren't enabled here yet - ask an admin directly.", variant: "destructive" }));
          },
        },
      });
    });
    return () => setForbiddenHandler(null);
  }, [me, toast]);

  // The code chunk that WILL render this route (detail pages differ from their list page).
  const routeChunk = () => {
    if (route.page === "employees" && route.id) return () => import("./pages/EmployeeProfile");
    if (route.page === "candidates" && route.id) return () => import("./pages/CandidateProfile");
    return PAGE_CHUNK[route.page];
  };

  // Download the current page's chunk NOW - in parallel with the `me` request - and track when it's ready.
  // On the INITIAL load we gate rendering on this (below) so the shell providers and the page mount in the
  // SAME commit; their reads then coalesce into ONE batch:run instead of two (shell window, then page window).
  useEffect(() => {
    const loader = routeChunk();
    if (!loader) { setChunkReady(true); return; }
    let live = true;
    setChunkReady(false);
    Promise.resolve(loader()).finally(() => { if (live) setChunkReady(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.page, route.id]);

  if (!loaded) {
    return (
      <FullScreen>
        <p className="animate-pulse text-sm text-muted-foreground">Loading {APP_NAME}…</p>
      </FullScreen>
    );
  }

  // A non-auth failure loading identity (server 500 / network / CORS) is NOT an expired session - showing
  // "sign in" here would be misleading and dead-ends the user. Offer a retry instead.
  if (error) {
    return (
      <FullScreen>
        <div>
          <h1 className="text-xl font-bold">Can't reach the server</h1>
          <p className="mt-1 text-sm text-muted-foreground">Something went wrong loading your account. This is usually temporary.</p>
        </div>
        <button
          onClick={retry}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Try again
        </button>
      </FullScreen>
    );
  }

  if (!me) {
    return (
      <FullScreen>
        <div>
          <h1 className="text-xl font-bold">Session expired</h1>
          <p className="mt-1 text-sm text-muted-foreground">Please sign in again to continue.</p>
        </div>
        <a
          href="/auth/login"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Sign in
        </a>
      </FullScreen>
    );
  }

  // INITIAL load only: hold the whole app until the first route's chunk is ready, so the shell and the page
  // mount together (one batch:run). Once booted, route changes fall through to <Suspense> below (the shell
  // stays mounted, so a nav only fires the new page's reads - already a single batch).
  if (!booted.current && !chunkReady) {
    return (
      <FullScreen>
        <p className="animate-pulse text-sm text-muted-foreground">Loading {APP_NAME}…</p>
      </FullScreen>
    );
  }
  booted.current = true;

  // Access-mode "view as": when active, the WHOLE shell (nav, pages, gated buttons - everything this
  // component prop-drills `me` into) gates on the simulated user's capability set and role (role feeds
  // audience-style UX branches like dashboard KPI visibility). Identity (email/employee_id) stays the
  // admin's, so every data query still runs as the admin. The access-mode chrome re-provides the REAL
  // capabilities for itself inside AccessModeProvider.
  const gme = viewAs ? { ...me!, capabilities: viewAs.capabilities, role: viewAs.role } : me!;

  function renderPage() {
    switch (route.page) {
      case "dashboard":
        return <Dashboard me={gme} />;
      case "approvals":
        return <Approvals me={gme} />;
      case "notifications":
        return <Notifications me={gme} />;
      case "profile":
        return <Profile me={gme} />;
      case "employees":
        return route.id ? <EmployeeProfile id={route.id} me={gme} sub={route.sub ?? undefined} /> : <Directory me={gme} />;
      case "org-chart":
        return <OrgChart me={gme} focusId={route.id ?? undefined} />;
      case "departments": // moved into Settings; deep-link to its tab
        return <Settings me={gme} tab="departments" />;
      case "attendance":
        return <Attendance me={gme} />;
      case "leave-requests":
        return <Leaves me={gme} />;
      case "leave-calendar":
        return <LeaveCalendar me={gme} />;
      case "goals":
        return <Goals me={gme} openId={route.id ?? undefined} />;
      case "boards":
        return <Boards me={gme} openId={route.id ?? undefined} />;
      case "reviews":
        return <Reviews me={gme} />;
      case "transitions":
        return <Onboarding me={gme} />;
      case "check-ins":
        return <CheckIns me={gme} />;
      case "benefits":
        return <Benefits me={gme} />;
      case "schedule":
        return <Schedule me={gme} />;
      case "timesheets":
        return <Timesheets me={gme} />;
      case "loans":
        return <Loans me={gme} />;
      case "tax-declarations":
        return <TaxDeclarations me={gme} openId={route.id ?? undefined} />;
      case "leave-types": // moved into Settings; deep-link to its tab
        return <Settings me={gme} tab="leave-types" />;
      case "announcements":
        return <Announcements me={gme} openId={route.id ?? undefined} />;
      case "holidays":
        return <Holidays me={gme} openId={route.id ?? undefined} />;
      case "events":
        return <Events me={gme} openId={route.id ?? undefined} />;
      case "documents":
        return <Documents me={gme} />;
      case "compliance":
        return <Compliance me={gme} openId={route.id ?? undefined} />;
      case "background-checks":
        return <BackgroundChecks me={gme} openId={route.id ?? undefined} />;
      case "overtime":
        return <Overtime me={gme} />;
      case "remote-work":
        return <RemoteWork me={gme} />;
      case "delegations":
        return <Delegations me={gme} />;
      case "notice-periods":
        return <NoticePeriods me={gme} openId={route.id ?? undefined} />;
      case "kudos": // merged into the board
        return <Announcements me={gme} />;
      case "suggestions":
        return <Suggestions me={gme} openId={route.id ?? undefined} />;
      case "payslips":
        return <Payslips me={gme} />;
      case "reimbursements":
        return <Reimbursements me={gme} />;
      case "expenses":
        return <Expenses me={gme} />;
      case "vendors":
        return <Vendors me={gme} />;
      case "expense-budgets":
        return <ExpenseBudgets me={gme} />;
      case "referrals":
        return <Referrals me={gme} openId={route.id ?? undefined} />;
      case "pipeline":
        return <Pipeline me={gme} />;
      case "job-requisitions":
        return <Requisitions me={gme} openId={route.id ?? undefined} />;
      case "candidates":
        return route.id ? <CandidateProfile id={route.id} me={gme} /> : <Candidates me={gme} />;
      case "interviews":
        return <Interviews me={gme} openId={route.id ?? undefined} />;
      case "offers":
        return <Offers me={gme} openId={route.id ?? undefined} />;
      case "recruiting-analytics":
        return <RecruitingAnalytics me={gme} />;
      case "tickets":
        return <Tickets me={gme} openId={route.id ?? undefined} />;
      case "assets":
        return <Assets me={gme} openId={route.id ?? undefined} />;
      case "pay-components": // moved into Settings; deep-link straight to its tab
        return <Settings me={gme} tab="pay-components" />;
      case "pay-periods": // merged into Payroll Runs; deep-link to its Pay periods tab
        return <PayrollRuns me={gme} tab="periods" />;
      case "payroll-runs":
        return <PayrollRuns me={gme} tab={route.id ?? undefined} />;
      case "settings":
        return <Settings me={gme} tab={route.id ?? undefined} openId={route.sub ?? undefined} />;
      case "workflows":
        return <Workflows me={gme} />;
      case "activity":
        return <Activity me={gme} />;
      case "users": // legacy deep link -> Settings Access → Roles & permissions
        return <Settings me={gme} tab="users" />;
      case "operations": // moved into Settings; deep-link straight to its tab
        return <Settings me={gme} tab="operations" />;
      default:
        return <Dashboard me={gme} />;
    }
  }

  // Wrap the active page in its workspace tab bar when the route belongs to one (e.g. Attendance/Overtime
  // both live under the "Time" workspace). Tabs are filtered to what the caller may see; an EmployeeProfile
  // detail page (a Directory record) keeps the People tab bar so it never feels like a dead-end.
  function renderWithWorkspace() {
    const ws = workspaceForKey(route.page);
    if (!ws?.tabs) return renderPage();
    const tabs = ws.tabs.filter((t) => { const p = navPerm(t); return !p || hasCapability(gme.capabilities, p); });
    return (
      <Workspace tabs={tabs} active={route.page}>
        {renderPage()}
      </Workspace>
    );
  }

  return (
    <CapabilitiesContext.Provider value={gme.capabilities}>
    <ConfirmProvider>
    <OrgProvider>
    <AccessModeProvider userEmail={me.email} capabilities={me.capabilities}>
    <ApprovalsProvider enabled={APPROVAL_CAPS.some((c) => hasCapability(gme.capabilities, c))}>
    <NotificationsProvider>
      <NotificationClearOnLeave page={route.page} />
      <div className="flex min-h-screen bg-background">
        <Sidebar me={gme} current={route.page} mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar me={gme} page={route.page} sub={route.id ?? undefined} onOpenMenu={() => setMobileOpen(true)} onOpenSearch={() => setPaletteOpen(true)} />
          <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
            {/* Ambient access scope for the whole page: collection = the route key (the collection for most
                pages), object = the detail id when on an item page. Shared primitives (Field, Detail, ...)
                read this so access-mode lights up every data element/control path. ROUTE_SCOPE corrects the
                routes whose key is NOT their wire collection; pages can still nest a narrower <AccessScope>. */}
            <RouteAccessScope page={route.page} id={route.id}>
              <div className="animate-fade-in">
                {/* Per-route boundary: a single page crash shows a recoverable fallback instead of white-
                    screening the shell. resetKey clears the error automatically when the route changes. */}
                <ErrorBoundary resetKey={`${route.page}/${route.id ?? ""}`}>
                  <Suspense fallback={<PageLoading />}>{renderWithWorkspace()}</Suspense>
                </ErrorBoundary>
              </div>
            </RouteAccessScope>
          </main>
        </div>
        <Toaster />
        <CommandPalette me={gme} open={paletteOpen} onOpenChange={setPaletteOpen} />
        <ShortcutLayer me={gme} page={route.page} />
        <SessionExpiredDialog open={sessionExpired} onSignedIn={() => setSessionExpired(false)} />
      </div>
    </NotificationsProvider>
    </ApprovalsProvider>
    </AccessModeProvider>
    </OrgProvider>
    </ConfirmProvider>
    </CapabilitiesContext.Provider>
  );
}
