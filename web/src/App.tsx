import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Skeleton } from "./components/ui/skeleton";
import { useMe } from "./useMe";
import { useRoute } from "./router";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { CommandPalette } from "./components/layout/CommandPalette";
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
import { workspaceForKey, APPROVAL_CAPS } from "./nav";
import { Building } from "lucide-react";
import { APP_NAME } from "./lib/brand";

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
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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
          href="/"
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

  function renderPage() {
    switch (route.page) {
      case "dashboard":
        return <Dashboard me={me!} />;
      case "approvals":
        return <Approvals me={me!} />;
      case "notifications":
        return <Notifications me={me!} />;
      case "profile":
        return <Profile me={me!} />;
      case "employees":
        return route.id ? <EmployeeProfile id={route.id} me={me!} /> : <Directory me={me!} />;
      case "org-chart":
        return <OrgChart me={me!} />;
      case "departments": // moved into Settings; deep-link to its tab
        return <Settings me={me!} tab="departments" />;
      case "attendance":
        return <Attendance me={me!} />;
      case "leave-requests":
        return <Leaves me={me!} />;
      case "leave-calendar":
        return <LeaveCalendar me={me!} />;
      case "goals":
        return <Goals me={me!} openId={route.id ?? undefined} />;
      case "boards":
        return <Boards me={me!} openId={route.id ?? undefined} />;
      case "reviews":
        return <Reviews me={me!} />;
      case "transitions":
        return <Onboarding me={me!} />;
      case "check-ins":
        return <CheckIns me={me!} />;
      case "benefits":
        return <Benefits me={me!} />;
      case "schedule":
        return <Schedule me={me!} />;
      case "timesheets":
        return <Timesheets me={me!} />;
      case "loans":
        return <Loans me={me!} />;
      case "tax-declarations":
        return <TaxDeclarations me={me!} openId={route.id ?? undefined} />;
      case "leave-types": // moved into Settings; deep-link to its tab
        return <Settings me={me!} tab="leave-types" />;
      case "announcements":
        return <Announcements me={me!} openId={route.id ?? undefined} />;
      case "holidays":
        return <Holidays me={me!} openId={route.id ?? undefined} />;
      case "events":
        return <Events me={me!} openId={route.id ?? undefined} />;
      case "documents":
        return <Documents me={me!} />;
      case "compliance":
        return <Compliance me={me!} openId={route.id ?? undefined} />;
      case "background-checks":
        return <BackgroundChecks me={me!} openId={route.id ?? undefined} />;
      case "overtime":
        return <Overtime me={me!} />;
      case "remote-work":
        return <RemoteWork me={me!} />;
      case "delegations":
        return <Delegations me={me!} />;
      case "notice-periods":
        return <NoticePeriods me={me!} openId={route.id ?? undefined} />;
      case "kudos": // merged into the board
        return <Announcements me={me!} />;
      case "suggestions":
        return <Suggestions me={me!} openId={route.id ?? undefined} />;
      case "payslips":
        return <Payslips me={me!} />;
      case "reimbursements":
        return <Reimbursements me={me!} />;
      case "expenses":
        return <Expenses me={me!} />;
      case "vendors":
        return <Vendors me={me!} />;
      case "expense-budgets":
        return <ExpenseBudgets me={me!} />;
      case "referrals":
        return <Referrals me={me!} openId={route.id ?? undefined} />;
      case "pipeline":
        return <Pipeline me={me!} />;
      case "job-requisitions":
        return <Requisitions me={me!} openId={route.id ?? undefined} />;
      case "candidates":
        return route.id ? <CandidateProfile id={route.id} me={me!} /> : <Candidates me={me!} />;
      case "interviews":
        return <Interviews me={me!} openId={route.id ?? undefined} />;
      case "offers":
        return <Offers me={me!} openId={route.id ?? undefined} />;
      case "recruiting-analytics":
        return <RecruitingAnalytics me={me!} />;
      case "tickets":
        return <Tickets me={me!} openId={route.id ?? undefined} />;
      case "assets":
        return <Assets me={me!} openId={route.id ?? undefined} />;
      case "pay-components": // moved into Settings; deep-link straight to its tab
        return <Settings me={me!} tab="pay-components" />;
      case "pay-periods": // merged into Payroll Runs; deep-link to its Pay periods tab
        return <PayrollRuns me={me!} tab="periods" />;
      case "payroll-runs":
        return <PayrollRuns me={me!} tab={route.id ?? undefined} />;
      case "settings":
        return <Settings me={me!} tab={route.id ?? undefined} openId={route.sub ?? undefined} />;
      case "workflows":
        return <Workflows me={me!} />;
      case "activity":
        return <Activity me={me!} />;
      case "users": // legacy deep link -> Settings Access → Roles & permissions
        return <Settings me={me!} tab="users" />;
      case "operations": // moved into Settings; deep-link straight to its tab
        return <Settings me={me!} tab="operations" />;
      default:
        return <Dashboard me={me!} />;
    }
  }

  // Wrap the active page in its workspace tab bar when the route belongs to one (e.g. Attendance/Overtime
  // both live under the "Time" workspace). Tabs are filtered to what the caller may see; an EmployeeProfile
  // detail page (a Directory record) keeps the People tab bar so it never feels like a dead-end.
  function renderWithWorkspace() {
    const ws = workspaceForKey(route.page);
    if (!ws?.tabs) return renderPage();
    const tabs = ws.tabs.filter((t) => !t.perm || hasCapability(me!.capabilities, t.perm));
    return (
      <Workspace tabs={tabs} active={route.page}>
        {renderPage()}
      </Workspace>
    );
  }

  return (
    <CapabilitiesContext.Provider value={me.capabilities}>
    <ConfirmProvider>
    <OrgProvider>
    <AccessModeProvider userEmail={me.email}>
    <ApprovalsProvider enabled={APPROVAL_CAPS.some((c) => hasCapability(me.capabilities, c))}>
    <NotificationsProvider>
      <NotificationClearOnLeave page={route.page} />
      <div className="flex min-h-screen bg-background">
        <Sidebar me={me} current={route.page} mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar me={me} page={route.page} sub={route.id ?? undefined} onOpenMenu={() => setMobileOpen(true)} onOpenSearch={() => setPaletteOpen(true)} />
          <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
            {/* Ambient access scope for the whole page: collection = the route key (the collection for most
                pages), object = the detail id when on an item page. Shared primitives (Field, Detail, ...)
                read this so access-mode lights up every data element/control path. Pages whose route key is
                not a 1:1 collection (dashboard/profile/documents) can wrap an inner <AccessScope> to override. */}
            <AccessScope collection={route.page} objectPath={route.id ? `${route.page}/${route.id}` : undefined}>
              <div className="animate-fade-in">
                {/* Per-route boundary: a single page crash shows a recoverable fallback instead of white-
                    screening the shell. resetKey clears the error automatically when the route changes. */}
                <ErrorBoundary resetKey={`${route.page}/${route.id ?? ""}`}>
                  <Suspense fallback={<PageLoading />}>{renderWithWorkspace()}</Suspense>
                </ErrorBoundary>
              </div>
            </AccessScope>
          </main>
        </div>
        <Toaster />
        <CommandPalette me={me} open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </NotificationsProvider>
    </ApprovalsProvider>
    </AccessModeProvider>
    </OrgProvider>
    </ConfirmProvider>
    </CapabilitiesContext.Provider>
  );
}
