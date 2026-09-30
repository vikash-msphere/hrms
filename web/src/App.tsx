import { Suspense, useEffect, useRef, useState } from "react";
import { useMedia } from "@/hooks/useMedia";
// lazyPage, not React.lazy: a failed import must stay retryable (see lib/lazyPage.tsx and the crash boundary).
import { lazyPage as lazy } from "./lib/lazyPage";
import { Skeleton } from "./components/ui/skeleton";
import { StatsSkeleton, TableSkeleton } from "./components/common/Skeletons";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { api, loginUrl, notifySignedIn, setSessionExpiredHandler, setForbiddenHandler } from "./api";
import { useToast } from "./components/ui/use-toast";
import { useViewAs, stopViewAs } from "./lib/viewAsStore";
import { useMe, useRealMe } from "./useMe";
import { useRoute } from "./router";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { PullToRefresh } from "./components/layout/PullToRefresh";
import { OfflineBar } from "./components/layout/OfflineBar";
import { CommandPalette } from "./components/layout/CommandPalette";
import { ShortcutLayer } from "./components/layout/ShortcutLayer";
import { Toaster } from "./components/ui/toaster";
import { ConfirmProvider } from "./components/common/confirm";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { AccessModeProvider } from "./components/access/AccessModeProvider";
import { AccessScope } from "./components/access/AccessScope";
import { CapabilitiesContext, ScopesContext, hasCapability } from "./lib/perm";
import { OrgProvider } from "./lib/org";
import { setTablePrefsUser } from "./lib/tablePrefs";
import { setResourceStoreUser } from "./lib/resourceStore";
import { whenReady, gc, setClientKey } from "./lib/clientStore";
import { useAppLock, configureLock } from "./lib/appLock";
import { LockScreen } from "./components/lock/LockScreen";
import { AutoLockBanner } from "./components/lock/AutoLockBanner";
import { AppLockSheet } from "./components/lock/AppLockSheet";
import { sweepSeenTickets } from "./lib/ticketsSeen";
import { setSettingsUser } from "./lib/settingsStore";
import { hydrateOrgTimezone } from "./lib/orgDay";
import { syncThemeFromServer } from "./lib/theme";
import { syncTabSeenFromServer } from "./lib/tabActivity";
import { Workspace } from "./components/layout/Workspace";
import { ApprovalsProvider, APPROVAL_COLLECTIONS, TAX_VERIFICATIONS_QUEUE } from "./lib/approvals";
import { ClockProvider } from "./lib/clock";
import { NotificationsProvider, NotificationClearOnLeave } from "./lib/notifications";
import { workspaceForKey, navAdmits, pageGate, pageVisible, APPROVAL_CAPS, pageLabel } from "./nav";
import { NoAccess } from "./components/common/NoAccess";
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
  "late-early": "late-early-requests",
  delegations: "approval-delegations",
  kudos: "announcements",
  pipeline: "applications",
  compliance: "compliance-events",
  workflows: "automations",
  "recruiting-analytics": "applications",
  "team-analytics": "employees",
  "team-goals": "goals",
  tables: "table-views",
  activity: "audit",
};
// Which approval queues each route needs ROWS for. Everywhere else the sidebar badge is all that reads
// approvals, and that is a server-side count (`GET /v1/approvals-summary`) - so a page not listed here fires
// no approval-collection request at all. Reading all ten on every page, which is what this replaced, was ~11
// list requests per page view for one number in the sidebar.
//
// A route belongs here only for the buckets it RENDERS; test/webApprovalQueues.test.ts greps the pages for
// `approvals.<bucket>` and fails if this map has drifted from what they read.
const ALL_QUEUES = [...APPROVAL_COLLECTIONS, TAX_VERIFICATIONS_QUEUE];
// Stable empty value: a fresh `[]` per render would change the provider's prop identity every render.
const NO_QUEUES: readonly string[] = [];
const QUEUES_BY_ROUTE: Record<string, readonly string[]> = {
  approvals: ALL_QUEUES, // the inbox itself: every queue, plus the decided-history tab built from the same rows
  // The "waiting on you" card approves inline, across the personal-request queues it lists. Company expenses
  // and asset requests are decided on their own pages, so the dashboard doesn't read (or fetch) them.
  dashboard: ["leave-requests", "reimbursements", "overtime-requests", "remote-work-requests", "late-early-requests", "attendance-regularizations", "leave-encashments", "loans", "time-entries"],
  attendance: ["attendance-regularizations"],
  "leave-requests": ["leave-requests"],
  "leave-calendar": ["leave-requests"],
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

// Every page is its own chunk, fetched on first visit (route-level code splitting) and downloaded in
// parallel with the `me` request via PAGE_CHUNK above, so the shell and the page still mount together.
//
// Dashboard is included, and was the one exception for a long time: as the landing page it was imported
// statically so that landing on it needed no second roundtrip. That bought one route a roundtrip and charged
// every other route 38 kB gz - it is the largest page in the app, and anyone opening a deep link, a
// notification link or a bookmark downloaded and parsed all of it before their own page could render.
// Measured across a build: index 46.7 -> 23.2 kB gz, shell 121.6 -> 107.2, the whole critical path
// 373.6 -> 335.7. Dashboard's own chunk is 24.5 kB gz, and its `dashboard` entry in PAGE_CHUNK starts
// downloading it at the same moment identity is fetched, so landing on the dashboard is no slower either.
const Dashboard = lazy(() => import("./pages/Dashboard"));
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
const LateEarly = lazy(() => import("./pages/LateEarly"));
const Delegations = lazy(() => import("./pages/Delegations"));
const NoticePeriods = lazy(() => import("./pages/NoticePeriods"));
const Suggestions = lazy(() => import("./pages/Suggestions"));
const Payslips = lazy(() => import("./pages/Payslips"));
const Reimbursements = lazy(() => import("./pages/Reimbursements"));
const Expenses = lazy(() => import("./pages/Expenses"));
const Vendors = lazy(() => import("./pages/Vendors"));
const ExpenseBudgets = lazy(() => import("./pages/ExpenseBudgets"));
const CardTransactions = lazy(() => import("./pages/CardTransactions"));
const Referrals = lazy(() => import("./pages/Referrals"));
const Pipeline = lazy(() => import("./pages/Pipeline"));
const Requisitions = lazy(() => import("./pages/Requisitions"));
const Candidates = lazy(() => import("./pages/Candidates"));
const CandidateProfile = lazy(() => import("./pages/CandidateProfile"));
const Interviews = lazy(() => import("./pages/Interviews"));
const Offers = lazy(() => import("./pages/Offers"));
const RecruitingAnalytics = lazy(() => import("./pages/RecruitingAnalytics"));
const TeamAnalytics = lazy(() => import("./pages/TeamAnalytics"));
const TableBuilder = lazy(() => import("./pages/TableBuilder"));
const Tickets = lazy(() => import("./pages/Tickets"));
const Assets = lazy(() => import("./pages/Assets"));
const Stocktakes = lazy(() => import("./pages/Stocktakes"));
const PayrollRuns = lazy(() => import("./pages/PayrollRuns"));
const Settings = lazy(() => import("./pages/Settings"));
const Workflows = lazy(() => import("./pages/Workflows"));
const Activity = lazy(() => import("./pages/Activity"));
const Moderation = lazy(() => import("./pages/Moderation"));

// Route-key -> the page's code-chunk loader. React.lazy only starts a chunk download when the page first
// RENDERS - which is AFTER `me` resolves and the shell has mounted, so the page's data reads land in a later
// coalescing window than the shell's -> a second batch:run. Kicking the chunk here, in parallel with `me`
// (see the prefetch effect), lets the page mount in the SAME commit as the shell so their reads collapse into
// ONE batch. The bundler dedups: this import and the lazy() above share the one chunk. Missing keys just fall
// back to lazy timing (no breakage). Dashboard is in the main chunk already, so it's omitted.
const PAGE_CHUNK: Record<string, () => Promise<unknown>> = {
  dashboard: () => import("./pages/Dashboard"),
  approvals: () => import("./pages/Approvals"), notifications: () => import("./pages/Notifications"),
  profile: () => import("./pages/Profile"), employees: () => import("./pages/Directory"),
  "org-chart": () => import("./pages/OrgChart"), attendance: () => import("./pages/Attendance"),
  "leave-requests": () => import("./pages/Leaves"), "leave-calendar": () => import("./pages/LeaveCalendar"),
  goals: () => import("./pages/Goals"), boards: () => import("./pages/Boards"), reviews: () => import("./pages/Reviews"),
  transitions: () => import("./pages/Onboarding"), "check-ins": () => import("./pages/CheckIns"),
  benefits: () => import("./pages/Benefits"), schedule: () => import("./pages/Schedule"),
  timesheets: () => import("./pages/Timesheets"), loans: () => import("./pages/Loans"),
  "tax-declarations": () => import("./pages/TaxDeclarations"), announcements: () => import("./pages/Announcements"),
  holidays: () => import("./pages/Holidays"),
  events: () => import("./pages/Events"), documents: () => import("./pages/Documents"),
  compliance: () => import("./pages/Compliance"), "background-checks": () => import("./pages/BackgroundChecks"),
  overtime: () => import("./pages/Overtime"), "remote-work": () => import("./pages/RemoteWork"),
  "late-early": () => import("./pages/LateEarly"),
  delegations: () => import("./pages/Delegations"),
  "notice-periods": () => import("./pages/NoticePeriods"), suggestions: () => import("./pages/Suggestions"),
  payslips: () => import("./pages/Payslips"), reimbursements: () => import("./pages/Reimbursements"),
  expenses: () => import("./pages/Expenses"), vendors: () => import("./pages/Vendors"), "expense-budgets": () => import("./pages/ExpenseBudgets"),
  "card-transactions": () => import("./pages/CardTransactions"),
  referrals: () => import("./pages/Referrals"), pipeline: () => import("./pages/Pipeline"),
  "job-requisitions": () => import("./pages/Requisitions"), candidates: () => import("./pages/Candidates"),
  interviews: () => import("./pages/Interviews"), offers: () => import("./pages/Offers"),
  "recruiting-analytics": () => import("./pages/RecruitingAnalytics"), tickets: () => import("./pages/Tickets"),
  "team-analytics": () => import("./pages/TeamAnalytics"),
  moderation: () => import("./pages/Moderation"),
  // Both goal routes are one page now, so the prefetch for either warms the same chunk.
  "team-goals": () => import("./pages/Goals"),
  tables: () => import("./pages/TableBuilder"),
  assets: () => import("./pages/Assets"), stocktakes: () => import("./pages/Stocktakes"),
  "payroll-runs": () => import("./pages/PayrollRuns"),
  workflows: () => import("./pages/Workflows"),
  activity: () => import("./pages/Activity"),
  settings: () => import("./pages/Settings"),
};

// Route-chunk loading fallback. Shaped like the page that is coming rather than like two grey slabs: nearly
// every route in this app is a title, a metric strip and a list, so the wait holds that geometry and the
// arriving page settles into it instead of shoving it aside.
function PageLoading() {
  return (
    <div>
      <div className="mb-6 space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <StatsSkeleton count={4} className="mb-6" />
      <TableSkeleton rows={6} cols={4} />
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

// What a page navigation owes a keyboard or screen-reader user, none of which a client-side route change does
// by itself:
// the tab/window/task-switcher title has to say which page this is (it said the app name and nothing else on
// every one of seventy pages), focus has to leave the link that just unmounted, and the change has to be
// announced - a silent content swap is the classic SPA failure, where the pointer user sees a new page and
// the screen-reader user is told nothing at all.
//
// Focus lands on <main>, not the page's own heading: pages own their headings and would each have to opt in,
// whereas the landmark is always there and reads its own label first. `preventScroll` because the scroll
// position for this navigation was just decided in router.ts and must not be re-litigated here.
function useRouteAnnounce(page: string, sub: string | undefined, mainRef: React.RefObject<HTMLElement>) {
  // `pageLabel`, not `navBreadcrumb`: the breadcrumb only knows keys that are in NAV, and nine routes are not
  // (the Settings deep-link aliases, Tickets and Notifications) - those had no tab title and announced nothing.
  const label = pageLabel(page, sub);
  const [announced, setAnnounced] = useState("");
  const first = useRef(true);
  useEffect(() => {
    document.title = label ? `${label} · ${APP_NAME}` : APP_NAME;
    // The first render is a page LOAD, not a navigation: the browser announces the document itself and
    // focus belongs wherever the document put it.
    if (first.current) { first.current = false; return; }
    mainRef.current?.focus({ preventScroll: true });
    setAnnounced(label ?? "");
  }, [label, mainRef]);
  return announced;
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
  const lock = useAppLock();
  const { me, loaded, error, retry } = useMe();
  const route = useRoute();
  const { toast } = useToast();
  const viewAs = useViewAs();
  const realMe = useRealMe(); // the signed-in admin (= `me` unless a simulation is running)
  const [mobileOpen, setMobileOpen] = useState(false);
  // The drawer has no meaning once the sidebar docks, and every way out of it is `md:hidden` - the scrim, the
  // drawer's own close X, the top bar's Menu button that opened it - while `drawerOpen` goes false so Escape stops
  // closing it too. So opening the menu at phone width and then crossing 768px (rotating a tablet, dragging a
  // desktop window) left `mobileOpen` true with nothing on screen able to clear it, and the `inert` below took
  // the entire main column out of hit-testing, focus and the accessibility tree: a page that looks completely
  // normal and is completely dead.
  const sidebarDocked = useMedia("(min-width: 768px)");
  useEffect(() => {
    if (sidebarDocked) setMobileOpen(false);
  }, [sidebarDocked]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [chunkReady, setChunkReady] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  // The page that actually renders. An unrecognised route (a stale bookmark, a since-removed alias such as
  // `/pay-periods`) falls to the dashboard in renderPage's `default:`, so the chrome around it - breadcrumb,
  // tab title, announcement, sidebar highlight, replay's page key - names the dashboard too, rather than a
  // humanized guess at a page that is not on screen. renderPage itself still switches on `route.page`.
  const known = Object.prototype.hasOwnProperty.call(PAGE_CHUNK, route.page);
  const page = known ? route.page : "dashboard";
  const sub = known ? route.id ?? undefined : undefined;
  const announced = useRouteAnnounce(page, sub, mainRef);
  const booted = useRef(false); // flips true after the first full render; after that, nav uses <Suspense>

  // Namespace the table-prefs cache by user before any table mounts.
  setTablePrefsUser(me?.email);
  // Same for the resource store's on-disk copies, but keyed by the IDENTITY THE APP IS ANSWERING AS: during a
  // simulation every read returns the subject's rows, so they must not land in (or be read from) the admin's
  // own cache. Set before any collection is read; without it the store stays memory-only.
  // ...and by the SESSION, not only the person. The email keeps two people sharing a browser apart, which was
  // the whole job this key was written for; what it did not do is bound how long a cached copy lives. Only an
  // explicit sign-out purges the store (lib/clientStore.ts `purgeAll`), and closing the tab is the ordinary way
  // a person leaves - so employee records and salary figures stayed on disk, unencrypted, to be rehydrated by
  // whoever signed in next as them. Folding the sitting in makes the cache live exactly as long as the session
  // that filled it: a reload still hydrates from disk, and a new sign-in is a new namespace whose predecessor's
  // records `openFor` deletes rather than reads. Absent on a session-less lane (API key, Access JWT, dev
  // bypass), where the key falls back to the email alone and behaves as it always did.
  const cacheUser = me ? `${me.email}${me.session_id ? `#${me.session_id}` : ""}${viewAs ? `~${viewAs.subject}` : ""}` : undefined;
  // The key the stored copies are encrypted under (lib/clientStore.ts), handed over BEFORE the identity so
  // hydration waits for it rather than racing it. Only an unlocked browser is ever given one.
  setClientKey(me?.client_key);
  void setResourceStoreUser(cacheUser);
  setSettingsUser(cacheUser); // and the org settings snapshot, which gates other reads (see lib/settingsStore.ts)

  // The stored copies live in IndexedDB, which is asynchronous, so they are loaded into memory ONCE before the
  // first read fires - a read that goes out first pays for rows this browser already has. The wait costs
  // nothing in practice: it starts the moment identity is known and runs alongside the route's code chunk,
  // which is a network fetch, and it replaces the hundred-odd synchronous localStorage reads this used to do
  // during render.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!cacheUser) return;
    let live = true;
    void whenReady().then(() => {
      if (live) setHydratedFor(cacheUser);
    });
    return () => {
      live = false;
    };
  }, [cacheUser]);
  const storeReady = !cacheUser || hydratedFor === cacheUser;

  // Sweep what nothing will read again: keys from a build that stored things differently, drafts left behind
  // before they had an expiry, and the families that grow one entry per ticket or per board. Idle-scheduled, so
  // it never competes with the first paint.
  useEffect(() => {
    if (!me) return;
    gc({ seenTickets: sweepSeenTickets });
  }, [me]);

  // Which day the app thinks it is. Every date default, `min` bound and "is this today" test in the SPA reads
  // `todayStr()` (lib/orgDay.ts), which needs the ORG's timezone rather than UTC or the viewer's - see that
  // file for what the UTC version got wrong. Hydrated once from the settings snapshot the app already loads,
  // so it costs no request; until it resolves the default timezone stands, exactly as on the server.
  useEffect(() => {
    if (!me) return;
    void hydrateOrgTimezone();
  }, [me]);

  // A simulation belongs to the admin who started it: if someone else is signed in on this browser now, drop
  // it rather than showing them a shell they never asked for. (The server re-checks permission per request
  // anyway - this is hygiene, not the gate.)
  useEffect(() => {
    if (viewAs && realMe && viewAs.admin !== realMe.email) stopViewAs();
  }, [viewAs, realMe]);

  // Pull cross-device preferences once the user is known.
  useEffect(() => {
    if (me) {
      void syncThemeFromServer();
      void syncTabSeenFromServer();
    }
  }, [me]);

  // The person's app lock (lib/appLock.ts): with a PIN set, this arms auto-lock, the keepalive and the shade.
  useEffect(() => {
    if (me) configureLock(me.app_lock);
  }, [me]);

  // With a signed-in shell on screen there is work worth preserving: a mid-session 401 overlays the
  // re-auth dialog instead of navigating away (see setSessionExpiredHandler in api.ts).
  useEffect(() => {
    if (!me) return;
    setSessionExpiredHandler(() => setSessionExpired(true));
    return () => setSessionExpiredHandler(null);
  }, [me]);

  // A 403 wall raises one toast per collection per session. Its "Request access" action notifies the access
  // admins through access-rules:requestAccess, which is fail-closed: an org turns the flow on by granting that
  // verb to Everyone. Until it does, the button could only ever 403, so it is offered only to a caller who
  // holds the verb, and everyone else is told to ask an admin directly. The probe opts out of the handler to
  // avoid a toast loop.
  const asked = useRef(new Set<string>());
  const canRequestAccess = !!me && hasCapability(me.capabilities, "access-rules.requestAccess");
  useEffect(() => {
    if (!me) return;
    setForbiddenHandler((collection) => {
      if (asked.current.has(collection)) return;
      asked.current.add(collection);
      const what = collection.replace(/-/g, " ");
      if (!canRequestAccess) {
        toast({ title: "You don't have access to that", description: `Ask an access admin for ${what}.`, duration: 10_000 });
        return;
      }
      toast({
        title: "You don't have access to that",
        description: `Ask the access admins for ${what}?`,
        duration: 10_000,
        action: {
          label: "Request access",
          onClick: () => {
            api("/access-rules:requestAccess", { method: "POST", body: JSON.stringify({ collection }), skipForbiddenHandler: true })
              .then(() => toast({ title: "Request sent", description: "The access admins have been notified.", variant: "success" }))
              .catch((e: unknown) => toast({ title: "Couldn't send the request", description: e instanceof Error ? e.message : "Try again, or ask an admin directly.", variant: "destructive" }));
          },
        },
      });
    });
    return () => setForbiddenHandler(null);
  }, [me, toast, canRequestAccess]);

  // The code chunk that WILL render this route (detail pages differ from their list page).
  const routeChunk = () => {
    if (route.page === "employees" && route.id) return () => import("./pages/EmployeeProfile");
    if (route.page === "candidates" && route.id) return () => import("./pages/CandidateProfile");
    // An unrecognised route (a typo, a stale bookmark, a link from a since-renamed page) renders the
    // dashboard - see `default:` in renderPage. Say so here too, or the chunk gate below waves it straight
    // through and the landing splits into two commits and two batch:run windows instead of one. Every key the
    // switch handles is in PAGE_CHUNK, so this fallback is reached only by a route that has no case at all.
    return PAGE_CHUNK[route.page] ?? PAGE_CHUNK.dashboard;
  };

  // Download the current page's chunk NOW - in parallel with the `me` request - and track when it's ready.
  // On the INITIAL load we gate rendering on this (below) so the shell providers and the page mount in the
  // SAME commit; their reads then coalesce into ONE batch:run instead of two (shell window, then page window).
  useEffect(() => {
    const loader = routeChunk();
    if (!loader) { setChunkReady(true); return; }
    let live = true;
    setChunkReady(false);
    void Promise.resolve(loader()).finally(() => { if (live) setChunkReady(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.page, route.id]);

  // A locked browser renders the lock screen and nothing else: no shell, no providers, no reads. The server
  // refuses them anyway (401 /errors/app-locked); this is what the page shows instead of a sign-in.
  if (lock.locked) return <LockScreen />;

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
          href={loginUrl()}
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
  if (!booted.current && (!chunkReady || !storeReady)) {
    return (
      <FullScreen>
        <p className="animate-pulse text-sm text-muted-foreground">Loading {APP_NAME}…</p>
      </FullScreen>
    );
  }
  booted.current = true;

  // Access-mode "view as" is a SERVER-side simulation now (src/lib/viewAs.ts): while it runs, /users/me and
  // every other read already answer as the subject, so `me` IS the simulated person - identity, role,
  // capabilities and data all agree, and nothing leaks in that they couldn't open themselves. The access-mode
  // chrome re-fetches the real admin for itself (useRealMe) so the pill that ends the simulation can never be
  // hidden by the simulated user's own permissions.
  const gme = me!;

  function renderPage() {
    switch (route.page) {
      case "dashboard":
        return <Dashboard me={gme} />;
      case "approvals":
        return <Approvals me={gme} />;
      case "notifications":
        return <Notifications me={gme} />;
      case "profile":
        // `route.id`, not `route.sub`: this route carries no record id (the record is the caller's), so the
        // tab is the first segment after the page - `/profile/identity`. Profile hands it to the one record
        // page as its `sub`.
        return <Profile me={gme} sub={route.id ?? undefined} />;
      case "employees":
        // `key` makes a different person a different component instance. Without it, navigating
        // /employees/A -> /employees/B re-rendered the SAME mounted tree with a new prop, and the profile
        // paints immediately (it resolves the employee out of the cached directory) rather than unmounting
        // its children while it fetches. The nine profile tabs that load by `employeeId` through a bespoke
        // endpoint - bank, compensation, tax, identity, personal, bonuses, settlement, role history - have no
        // cancellation flag, so two requests for two different people were in flight with nothing to say
        // which answer belonged to the current one and the last to land won: person A's salary history beside
        // person B's projected tax, under person B's name, on the surface where somebody decides a raise.
        // Store-backed reads never had this (a `useCollection` entry is keyed by collection+params); these
        // bypass the store. The remount per navigation is the price, and it fixes every tab at once.
        return route.id ? <EmployeeProfile key={route.id} id={route.id} me={gme} sub={route.sub ?? undefined} /> : <Directory me={gme} />;
      case "org-chart":
        return <OrgChart me={gme} focusId={route.id ?? undefined} />;
      case "attendance":
        return <Attendance me={gme} />;
      case "leave-requests":
        return <Leaves me={gme} />;
      case "leave-calendar":
        return <LeaveCalendar me={gme} />;
      // KEYED, because `/goals` and `/team-goals` render the same component in the same slot of this tree.
      // Without a key React reuses the instance across the switch, and everything this page decides at mount -
      // the scope (`scope="all"` is read in a `useState` initialiser), the chip, the search, the layout, all
      // of which also read the address - simply never re-runs. So the sidebar's "Team goals", pressed from
      // Goals, opened a page headed Team goals showing the reader's OWN goals, and a link carrying `?filter=`
      // (the Chase up button's) was ignored because the initialiser that reads it had already run.
      case "goals":
        return <Goals key="goals" me={gme} openId={route.id ?? undefined} />;
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
      // `…/<id>` deep-links a post ON the board (search hits, the activity feed, a copied link); the `/view`
      // tail is the pop-out: that post alone, on a page of its own, with no board behind it.
      case "announcements":
        return <Announcements me={gme} openId={route.id ?? undefined} solo={route.sub === "view"} />;
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
      case "late-early":
        return <LateEarly me={gme} />;
      case "delegations":
        return <Delegations me={gme} />;
      case "notice-periods":
        return <NoticePeriods me={gme} openId={route.id ?? undefined} />;
      case "suggestions":
        return <Suggestions me={gme} openId={route.id ?? undefined} solo={route.sub === "view"} />;
      case "payslips":
        return <Payslips me={gme} />;
      case "reimbursements":
        return <Reimbursements me={gme} />;
      case "expenses":
        return <Expenses me={gme} />;
      case "vendors":
        return <Vendors me={gme} />;
      case "expense-budgets":
        return <ExpenseBudgets me={gme} openId={route.id ?? undefined} />;
      case "card-transactions":
        return <CardTransactions me={gme} />;
      case "referrals":
        return <Referrals me={gme} openId={route.id ?? undefined} />;
      case "pipeline":
        return <Pipeline me={gme} openId={route.id ?? undefined} />;
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
      case "team-analytics":
        return <TeamAnalytics me={gme} />;
      // The same page as `/goals`, with the scope the sidebar entry names. It used to be its own component
      // over nearly the same rows, with its own filters and its own copy explaining how it differed from the
      // grid on Goals - two surfaces for one question, which is what the scope switcher replaced.
      // Keyed apart from `/goals` above - see the note there. Every team the reader can see, not only the people
      // who report to them: "My team" on `/goals` is that narrower question.
      case "team-goals":
        return <Goals key="team-goals" me={gme} scope="all" />;
      // `tables/<id>` opens that grid in place: a saved table is a record people link to, not a dialog.
      case "tables":
        return <TableBuilder me={gme} openId={route.id ?? undefined} />;
      case "tickets":
        return <Tickets me={gme} openId={route.id ?? undefined} />;
      case "assets":
        return <Assets me={gme} openId={route.id ?? undefined} />;
      // `stocktakes/<id>` opens that count in place: a count is a record somebody links to, not a dialog.
      case "stocktakes":
        return <Stocktakes me={gme} />;
      // `payroll-runs/<tab>/<id>`: the tab takes the first segment (it predates deep-opening), so a run id
      // rides in the third - `payroll-runs/runs/<id>` opens that run's breakdown.
      case "payroll-runs":
        return <PayrollRuns me={gme} tab={route.id ?? undefined} openId={route.sub ?? undefined} />;
      case "settings":
        return <Settings me={gme} tab={route.id ?? undefined} openId={route.sub ?? undefined} />;
      case "workflows":
        return <Workflows me={gme} openId={route.id ?? undefined} />;
      case "activity":
        return <Activity me={gme} />;
      case "moderation":
        return <Moderation />;
      default:
        return <Dashboard me={gme} />;
    }
  }

  // Wrap the active page in its workspace tab bar when the route belongs to one (e.g. Attendance/Overtime
  // both live under the "Time" workspace). Tabs are filtered to what the caller may see; an EmployeeProfile
  // detail page (a Directory record) keeps the People tab bar so it never feels like a dead-end.
  function renderWithWorkspace() {
    // Route gate: the sidebar's answer, applied to the URL. A page the nav hides must not render just because
    // its address was typed, bookmarked or pasted by somebody who does hold the access - so the wall goes up
    // INSTEAD of the page (and without its workspace tab bar), rather than the page rendering itself empty.
    if (!pageVisible(route.page, (p) => hasCapability(gme.capabilities, p), (c) => !!gme.scopes.read[c])) {
      const gate = pageGate(route.page);
      const perm = gate?.perm ?? gate?.anyPerm?.[0];
      return <NoAccess collection={perm?.split(".").slice(0, -1).join(".")} />;
    }
    const ws = workspaceForKey(route.page);
    if (!ws?.tabs) return renderPage();
    const tabs = ws.tabs.filter((t) => navAdmits(t, (p) => hasCapability(gme.capabilities, p), (c) => !!gme.scopes.read[c]));
    return (
      <Workspace tabs={tabs} active={route.page}>
        {renderPage()}
      </Workspace>
    );
  }

  return (
    <CapabilitiesContext.Provider value={gme.capabilities}>
    <ScopesContext.Provider value={gme.scopes}>
    <ConfirmProvider>
    <OrgProvider>
    <AccessModeProvider userEmail={realMe?.email ?? me.email} capabilities={realMe?.capabilities ?? []}>
    <ApprovalsProvider enabled={APPROVAL_CAPS.some((c) => hasCapability(gme.capabilities, c))} queues={QUEUES_BY_ROUTE[route.page] ?? NO_QUEUES} history={route.page === "approvals"} selfEmployeeId={gme.employee_id}>
    <NotificationsProvider>
    <ClockProvider me={gme}>
      <NotificationClearOnLeave page={route.page} />
      <div data-app-shell className="flex min-h-screen bg-background">
        <Sidebar me={gme} current={page} mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />
        {/* While the mobile drawer is open the page behind it is inert: that is what keeps Tab inside the
            drawer (a modal surface has to trap focus) and stops a stray tap landing on a control under the
            scrim. Paired with the drawer's own `inert` when closed, exactly one of the two is ever reachable.
            React 18's typings predate the attribute, hence the cast - the DOM and browsers accept it. */}
        {/* Gated on the breakpoint as well as the flag: `inert` is only correct while the drawer is a MODAL
            OVERLAY, and belt-and-braces with the effect above - the effect clears the flag, this makes a frame
            in which both are true impossible to get stuck in. */}
        <div className="flex min-w-0 flex-1 flex-col" {...(mobileOpen && !sidebarDocked ? ({ inert: "" } as React.HTMLAttributes<HTMLDivElement>) : {})}>
          <TopBar
            me={gme}
            page={page}
            sub={sub}
            onOpenSearch={() => setPaletteOpen(true)}
            onOpenMenu={() => setMobileOpen(true)}
            menuOpen={mobileOpen}
          />
          {/* Renders nothing while the connection is up. */}
          <OfflineBar />
          {/* The bottom padding clears the phone's home indicator so the last row of a list is never parked
              under it; from `md` up there is no inset and the normal rhythm applies. Vertical padding is
              tighter on a phone, where 32px of chrome is a sixth of the screen. */}
          {/* Focus target for a navigation (see useRouteAnnounce). `tabIndex={-1}` makes the landmark
              focusable programmatically without adding it to the tab sequence, and `outline-none` keeps
              that focus silent for the pointer user who never asked for a ring around the page. */}
          <main
            ref={mainRef}
            tabIndex={-1}
            aria-label="Main content"
            // The route key, for session replay's per-page masking (SENSITIVE_PAGES in instrument.ts). Replay
            // records text by default, and a selector on this attribute is what hides a whole sensitive route -
            // payslips, payroll runs, documents, reviews, suggestions, check-ins, tax declarations, background
            // checks - subtree and all. A panel added to one of THOSE routes is covered without opting in.
            //
            // `profile` and `employees` are deliberately NOT on that list (instrument.ts says why: masking them
            // hid the headings, statuses and dates that make a replay readable while the values that matter are
            // in a handful of panels). So a panel added to the profile is recorded unless it says otherwise:
            // give it `sentry-mask`, or `data-sentry-block` for an image, the way the compensation, bank, tax,
            // identity, personal, emergency, documents and signature panels each do for themselves.
            data-page={page}
            className="mx-auto w-full max-w-screen-2xl flex-1 px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-5 outline-none sm:px-6 sm:pt-8 md:pb-8 lg:px-8"
          >
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
        {/* Pull down from the top of any page to re-read it (touch only; renders nothing until pulled). */}
        <PullToRefresh />
        {/* Speaks the page a navigation landed on. Off-screen rather than hidden: `display:none` content is
            not announced at all, which is the usual way this element ends up doing nothing. */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">{announced}</div>
        <Toaster />
        <CommandPalette me={gme} open={paletteOpen} onOpenChange={setPaletteOpen} />
        <ShortcutLayer me={gme} page={route.page} />
        {/* The 30-second warning before an auto-lock, and the person's own app lock settings. */}
        <AutoLockBanner />
        <AppLockSheet />
        <SessionExpiredDialog
          open={sessionExpired}
          onSignedIn={() => {
            setSessionExpired(false);
            // Resumes whatever was parked on the lapse - a page chunk the gate refused (lib/lazyPage.tsx).
            notifySignedIn();
          }}
        />
      </div>
    </ClockProvider>
    </NotificationsProvider>
    </ApprovalsProvider>
    </AccessModeProvider>
    </OrgProvider>
    </ConfirmProvider>
    </ScopesContext.Provider>
    </CapabilitiesContext.Provider>
  );
}
