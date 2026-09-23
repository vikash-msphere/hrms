// Day-one automation rules - the workflow engine's default "coherence map". Real org processes are MULTI-STEP:
// these chain sequential actions, pass data between steps (apiCall captureAs -> {{results.x}}), and suspend on
// durable waitFor branches (event/timer selectors), not just single notifications. ADDITIVE - they only add
// steps no inline service code already does. HR edits/enables/disables them in the Workflows admin page.
//
// Enabled-by-default: the safe, broadly-useful lifecycle chains. Opinionated / noisy / infra-dependent rules
// (SLA escalations, webhooks) ship DISABLED so an admin opts in.
//
// Grammar: src/domain/automations.ts (conditions + action catalog). Triggers: src/domain/events.ts EVENT_TYPES.
import { type Ctx, T0, q, b, j, code2, rows } from "../lib";
import type { Action, Condition, Schedule } from "../../src/domain/automations";
import { SCHEDULE_TRIGGER } from "../../src/domain/automations";

type AutomationSeed = {
  name: string;
  description: string;
  trigger: string;
  condition?: Condition | null;
  actions: Action[];
  enabled?: boolean; // default true
  schedule?: Schedule | null; // set (with trigger SCHEDULE_TRIGGER) for time-driven rules
};

export const AUTOMATIONS: AutomationSeed[] = [
  // ---- Onboarding: a real multi-step chain (enrol -> welcome using the result -> brief the manager -> wait
  //      durably for onboarding to finish, else escalate). Fires for every hire (ATS or manual). ----
  {
    name: "Onboard a new hire",
    description:
      "When an employee is created: OPEN their onboarding checklist (from the default template, anchored on their " +
      "start date), AUTO-ENROL them in default benefits, welcome them (citing the checklist + plan count), brief " +
      "their manager, then wait for onboarding to complete - welcoming them + notifying the manager when it does, " +
      "or flagging the manager if it isn't done after 45 days. This is the hire->onboarding hand-off as DATA.",
    trigger: "employee.created",
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/transitions", body: { employee: "{{subject}}", kind: "onboarding", template: "default-onboarding", anchor_date: "{{startDate}}" }, captureAs: "onboarding" },
      { kind: "apiCall", method: "POST", path: "/v1/{{subject}}:enrollDefaultBenefits", captureAs: "benefits" },
      { kind: "notify", recipient: { of: "subject" }, title: "Welcome aboard!", body: "Your onboarding checklist is ready and you're enrolled in {{results.benefits.enrolled}} benefit plan(s). Check your tasks to get started.", link: "onboarding" },
      { kind: "email", to: { of: "subject" }, subject: "Welcome aboard!", html: "<p>Welcome to the team! Your onboarding checklist is ready and you're enrolled in {{results.benefits.enrolled}} benefit plan(s). Log in to see your first-week tasks and get started.</p>" },
      { kind: "notifyManager", noun: "new hire - set up their first week" },
      {
        kind: "waitFor",
        on: [
          {
            event: "transition.completed",
            match: "employeeId",
            then: [
              { kind: "notify", recipient: { of: "subject" }, title: "You're all set!", body: "Your onboarding is complete - welcome aboard.", link: "dashboard" },
              { kind: "notifyManager", noun: "onboarding complete for your report" },
            ],
          },
          { timer: { days: 45 }, then: [{ kind: "notifyManager", noun: "onboarding still open after 45 days" }] },
        ],
      },
    ],
  },
  // ---- Recruiting: the pipeline runs itself ----------------------------------------------------------------
  //
  // Every move on the pipeline board emits an event carrying the whole context (candidate, requisition, hiring
  // manager, pay band, and the dates the org's offer policy implies - see applicationEventPayload in
  // services/ats.ts). These rules turn each of those transitions into the work it implies, so moving a card is
  // the ONLY manual step: the offer is drafted, the round is booked, the requisition closes, the hire converts.
  //
  // Every one of them is data: rename a stage, change a figure, or switch a rule off in the Workflows builder
  // and the pipeline behaves differently with no code change. Conditions key on `stageKind` where the meaning
  // is structural (a hired stage is a hired stage whatever an org calls it) and on `stage` where the meaning is
  // the org's own naming.
  {
    name: "Alert the hiring manager to a new applicant",
    description: "When an application is received, tell the requisition's hiring manager there is someone new to look at.",
    trigger: "application.created",
    condition: { field: "hiringManagerId", op: "exists" },
    actions: [{
      kind: "notify",
      recipient: { of: "ref", field: "hiringManagerId" },
      title: "New applicant",
      body: "{{candidateName}} applied for {{requisitionTitle}}.",
      link: "pipeline",
    }],
  },
  {
    name: "Ask the hiring manager to screen",
    description: "When an application reaches the screening stage, ask the hiring manager to review the candidate.",
    trigger: "application.stageChanged",
    condition: { all: [{ field: "stage", op: "eq", value: "screening" }, { field: "hiringManagerId", op: "exists" }] },
    actions: [{
      kind: "notify",
      recipient: { of: "ref", field: "hiringManagerId" },
      title: "Someone to screen",
      body: "{{candidateName}} is at screening for {{requisitionTitle}}.",
      link: "pipeline",
      action: "advance",
    }],
  },
  {
    name: "Auto-schedule a screening interview",
    description:
      "When an application reaches the interview stage, book the round for it (Recruiting → Interviews), titled " +
      "after the role, then tell the hiring manager to set the panel and the time.",
    trigger: "application.stageChanged",
    condition: { field: "stage", op: "eq", value: "interview" },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/interviews", body: { application: "{{subject}}", title: "{{requisitionTitle}} - screening interview", mode: "video" }, captureAs: "round" },
      { kind: "notify", recipient: { of: "ref", field: "hiringManagerId" }, title: "Interview to arrange", body: "A screening round is open for {{candidateName}} ({{requisitionTitle}}). Set the panel and the time.", link: "interviews" },
    ],
  },
  {
    name: "Draft the offer when a candidate reaches the offer stage",
    description:
      "When an application reaches the offer stage, DRAFT the offer already filled in: the figure from the " +
      "requisition's pay band (settings/ats picks which point of the band), the band's currency, today's date, " +
      "and the join + expiry dates the org's notice and validity periods imply. Then ask for approval. Nothing " +
      "is sent to the candidate - a draft offer still has to be approved and extended.",
    trigger: "application.stageChanged",
    condition: { field: "stage", op: "eq", value: "offer" },
    actions: [
      {
        kind: "apiCall",
        method: "POST",
        path: "/v1/offers",
        body: {
          application: "{{subject}}",
          base_comp: "{{offerAmount}}",
          currency_code: "{{currency}}",
          offer_date: "{{offerDate}}",
          join_date: "{{suggestedJoinDate}}",
          expiry_date: "{{suggestedExpiryDate}}",
          notes: "Drafted automatically when {{candidateName}} reached the offer stage for {{requisitionTitle}}.",
        },
        captureAs: "offer",
      },
      {
        kind: "notify",
        recipient: { of: "ref", field: "hiringManagerId" },
        title: "Offer ready to approve",
        body: "A draft offer for {{candidateName}} ({{requisitionTitle}}) is waiting for approval. Check the figure before it goes out.",
        link: "offers",
        type: "recruiting.offer_approval",
      },
    ],
  },
  {
    name: "Hire when the card reaches the hired stage",
    description:
      "When an application lands on a hired-kind stage, convert the candidate into an employee (which opens " +
      "their onboarding via the hire rules above). Without this, a card in the Hired column is only a label: " +
      "the person has no employee record and nothing to onboard. Idempotent - a candidate already converted is " +
      "left alone. Disable it if hiring must always go through an accepted offer.",
    trigger: "application.stageChanged",
    condition: { all: [{ field: "stageKind", op: "eq", value: "hired" }, { field: "candidateEmail", op: "exists" }] },
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/applications/{{applicationId}}:hire" }],
  },
  {
    name: "Close the requisition when filled",
    description:
      "When a candidate is hired for the last opening on a requisition, mark the requisition filled. Keyed on " +
      "the hire itself, so it fires whether the team accepted an offer or hired straight off the board.",
    trigger: "application.hired",
    condition: { field: "openings", op: "lte", value: 1 },
    actions: [{ kind: "apiCall", method: "PATCH", path: "/v1/job-requisitions/{{requisitionId}}", body: { status: "filled" } }],
  },
  {
    name: "Announce the hire to the hiring manager",
    description: "When a candidate is hired, tell the hiring manager - their search is over and onboarding has started.",
    trigger: "application.hired",
    condition: { field: "hiringManagerId", op: "exists" },
    actions: [{
      kind: "notify",
      recipient: { of: "ref", field: "hiringManagerId" },
      title: "You have a new hire",
      body: "{{candidateName}} is hired for {{requisitionTitle}}. Their onboarding checklist is open.",
      link: "onboarding",
      type: "recruiting.hired",
    }],
  },
  {
    name: "Chase an offer the candidate hasn't answered",
    description:
      "When an offer is extended, wait for the candidate's answer. If neither an acceptance nor a decline lands " +
      "within 3 days, nudge the hiring manager to follow up. Durable - the wait survives restarts.",
    trigger: "offer.extended",
    actions: [{
      kind: "waitFor",
      on: [
        // Either answer resolves the wait, which is what stops the nudge below from firing. Each arm marks the
        // answer as one milestone event, so "we are no longer waiting on this candidate" is a signal an org can
        // build its own reporting or follow-ups on.
        { event: "offer.accepted", match: "subject", then: [{ kind: "emitEvent", type: "offer.answered", payload: { answer: "accepted" } }] },
        { event: "offer.declined", match: "subject", then: [{ kind: "emitEvent", type: "offer.answered", payload: { answer: "declined" } }] },
        {
          timer: { days: 3 },
          then: [{
            kind: "notify",
            recipient: { of: "ref", field: "hiringManagerId" },
            title: "Offer still unanswered",
            body: "{{candidateName}} hasn't answered the offer for {{requisitionTitle}}. It expires on {{expiryDate}}.",
            link: "offers",
          }],
        },
      ],
    }],
  },
  {
    name: "Reopen the search when an offer is declined",
    description: "When a candidate declines, tell the hiring manager so the requisition can go back out.",
    trigger: "offer.declined",
    condition: { field: "hiringManagerId", op: "exists" },
    actions: [{
      kind: "notify",
      recipient: { of: "ref", field: "hiringManagerId" },
      title: "Offer declined",
      body: "{{candidateName}} declined the offer for {{requisitionTitle}}. The requisition is still open.",
      link: "job-requisitions",
      type: "recruiting.offer_declined",
    }],
  },
  {
    name: "Tell the hiring manager when a candidate is rejected",
    description: "When an application is rejected, let the hiring manager know their candidate is out of the running, with the reason.",
    trigger: "application.rejected",
    condition: { field: "hiringManagerId", op: "exists" },
    actions: [{
      kind: "notify",
      recipient: { of: "ref", field: "hiringManagerId" },
      title: "Candidate rejected",
      body: "{{candidateName}} is out for {{requisitionTitle}}. {{reason}}",
      link: "pipeline",
    }],
  },
  {
    name: "Ask for a decision after an interview",
    description: "When an interview is marked held, nudge the hiring manager to read the scorecards and move the candidate on.",
    trigger: "interview.completed",
    condition: { field: "hiringManagerId", op: "exists" },
    actions: [{
      kind: "notify",
      recipient: { of: "ref", field: "hiringManagerId" },
      title: "Interview held - decision needed",
      body: "{{interviewTitle}} with {{candidateName}} is done. Read the scorecards and move them on or out.",
      link: "pipeline",
    }],
  },

  // ---- Onboarding milestone fan-out (Lifecycle → Performance + Engagement), demonstrating emitEvent ----
  // One rule turns "onboarding finished" into a single milestone signal; several cross-section rules react to it.
  {
    name: "Mark onboarding milestone",
    description: "When an ONBOARDING transition completes, emit the 'employee.onboarded' milestone that the fan-out rules below react to.",
    trigger: "transition.completed",
    condition: { field: "kind", op: "eq", value: "onboarding" },
    actions: [{ kind: "emitEvent", type: "employee.onboarded" }],
  },
  {
    name: "New hire: set 30-day ramp-up goals",
    description: "When a new hire finishes onboarding, create a first-30-days ramp-up goal for them (Performance).",
    trigger: "employee.onboarded",
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/goals", body: { employee: "employees/{{employeeId}}", title: "Ramp-up: first 30 days", description: "Get set up, meet the team, and land your first contribution." } }],
  },
  {
    name: "New hire: schedule a 30-day check-in",
    description: "When a new hire finishes onboarding, open a 30-day check-in with their manager (Performance).",
    trigger: "employee.onboarded",
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/check-ins", body: { employee: "employees/{{employeeId}}", notes: "30-day onboarding check-in" } }],
  },
  {
    name: "Welcome the newest team member",
    description: "When a new hire finishes onboarding, invite everyone to welcome them (Engagement). Disabled by default (org-wide broadcast).",
    trigger: "employee.onboarded",
    enabled: false,
    actions: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "Welcome our newest team member!", body: "A colleague has just completed onboarding - say hello when you get a chance.", link: "employees" }],
  },
  {
    name: "Celebrate long-tenure anniversaries",
    description: "On a 5+ year work anniversary, invite the whole company to celebrate (Engagement). Disabled by default (org-wide broadcast).",
    trigger: "schedule.workAnniversary",
    enabled: false,
    condition: { field: "years", op: "gte", value: 5 },
    actions: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "A big work anniversary today!", body: "One of our colleagues is celebrating 5+ years with us. Drop them a note!", link: "employees" }],
  },

  // ---- Probation review: notify both sides, then a delayed reminder if the decision drags. ----
  {
    name: "Probation review",
    description:
      "When probation is ending (Lifecycle): open a 1:1 check-in for the review (Performance), tell the employee, " +
      "ask the manager to confirm/extend, and remind the manager after 7 days if still pending.",
    trigger: "schedule.probationEnding",
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/check-ins", body: { employee: "employees/{{employeeId}}", notes: "Probation review discussion" } },
      { kind: "notify", recipient: { of: "subject" }, title: "Your probation is ending", body: "Your manager will confirm your status shortly.", link: "profile" },
      { kind: "notifyManager", noun: "probation ending - confirm or extend" },
      { kind: "email", to: { of: "managerOf" }, subject: "Action needed: confirm or extend a probation", html: "<p>A team member's probation period is ending. Please confirm their status or extend probation in the app.</p>" },
      { kind: "wait", delayDays: 7, then: [{ kind: "notifyManager", noun: "probation decision still pending" }] },
    ],
  },

  // ---- Offboarding wrap-up (the exit itself is handled inline; these are the additive courtesies). ----
  {
    name: "Offboarding wrap-up",
    description: "When an offboarding transition completes, close the loop with the manager and the departing employee.",
    trigger: "transition.completed",
    condition: { field: "kind", op: "eq", value: "offboarding" },
    actions: [
      { kind: "notifyManager", noun: "offboarding completed for your report" },
      { kind: "notify", recipient: { of: "subject" }, title: "Exit formalities complete", body: "Your offboarding is complete. We wish you all the best!", link: "dashboard" },
      { kind: "email", to: { of: "subject" }, subject: "Your exit formalities are complete", html: "<p>Your offboarding is complete and your access will be wound down shortly. Thank you for all your contributions - we wish you the very best.</p>" },
    ],
  },

  // ---- Tenure & finance milestones (single-step - genuinely one action) ----
  {
    name: "Congratulate work anniversaries",
    description: "On an employee's work anniversary, send them a congratulations.",
    trigger: "schedule.workAnniversary",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Happy work anniversary!", body: "Thank you for all your contributions. Here's to many more!", link: "dashboard" }],
  },
  {
    name: "Celebrate a repaid loan",
    description: "When a loan is fully repaid (last payroll installment), let the employee know.",
    trigger: "loan.closed",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Your loan is fully repaid", body: "The final installment was deducted in this payroll run. You're all paid up!", link: "loans" }],
  },
  {
    name: "Remind owners of expiring documents",
    description: "When a personal document is within 30 days of expiry, remind its owner (in-app) to renew it.",
    trigger: "document.expiring",
    condition: { field: "daysLeft", op: "lte", value: 30 },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "A document is expiring soon", body: 'Your document "{{title}}" expires in {{daysLeft}} day(s). Please renew it.', link: "documents" }],
  },
  {
    name: "Thank suggestion authors",
    description: "When someone submits a (non-anonymous) suggestion, thank them and point to where they can track it.",
    trigger: "suggestion.submitted",
    condition: { field: "anonymous", op: "eq", value: false },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Thanks for your suggestion!", body: "HR will review it. You can track its status on the Suggestions page.", link: "suggestions" }],
  },

  // ---- Moderation: act on a flag without waiting for somebody to open the queue - opt-in ----
  //
  // TWO RULES, AND THE SPLIT IS THE POINT. Telling the moderators costs nothing if the model was wrong;
  // taking a post down in public does. So the notification ships ENABLED and the takedown ships DISABLED,
  // and the takedown is conditioned on `pass == "hazard"` - Llama Guard's fixed taxonomy of dangerous
  // content - never on a conduct flag, which is a general model reading this org's own rubric and is wrong
  // in both directions far more often (src/domain/conduct.ts says so in as many words).
  {
    name: "Tell the moderators about a flagged post",
    description:
      "When a model objects to something on a public wall, notify and email whoever holds `moderation.read` - " +
      "the people who can actually decide about it - with the reason and a link to the queue. Nothing is hidden: " +
      "the post stays exactly as visible as it was until a person decides.",
    trigger: "moderation.flagged",
    actions: [
      { kind: "notifyAudience", audience: { kind: "capability", capability: "moderation.read" }, title: "A post was flagged for review", body: '{{hazardLabels}} - "{{title}}". Nothing has been hidden; it is waiting on a decision.', link: "moderation" },
      {
        kind: "emailAudience",
        audience: { kind: "capability", capability: "moderation.read" },
        subject: "A post was flagged for review",
        html: '<p>A safety check objected to a post on the {{collection}} wall.</p><p><strong>Reason:</strong> {{hazardLabels}}<br><strong>Post:</strong> {{title}}</p><p>Nothing has been hidden - the post is still visible to everyone who could see it before, and stays that way until somebody decides. Open the Flagged posts tab under Connect to hide it or dismiss the flag.</p>',
      },
    ],
  },
  {
    name: "Take down a post the safety model flagged",
    description:
      "When the SAFETY model (not the conduct rubric) objects to a public post, hide it immediately and tell the " +
      "moderators it came down. The hide is reversible, the author is told automatically, and the flag stays on the " +
      "queue to be dismissed or upheld. DISABLED by default: this takes real posts down on a model's say-so, and a " +
      "false positive is a visible, public mistake. Turn it on only if an hour of exposure is worse for you than an " +
      "occasional wrongly-hidden post.",
    trigger: "moderation.flagged",
    // `pass`, not the presence of a flag: a conduct flag (W-codes) is a judgement about tone and must not
    // take a post down automatically. Disagreement reads as abuse often enough that this would eventually
    // hide somebody for criticising a decision.
    condition: { field: "pass", op: "eq", value: "hazard" },
    enabled: false,
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/moderation:decide", body: { host: "{{subject}}", action: "hide" } },
      { kind: "notifyAudience", audience: { kind: "capability", capability: "moderation.read" }, title: "A flagged post was hidden automatically", body: '{{hazardLabels}} - "{{title}}". It is off the wall and the author has been told. Review it on the queue and restore it if the model was wrong.', link: "moderation" },
    ],
  },

  // ---- Approval SLAs (durable, conditional, multi-branch) - opt-in ----
  {
    name: "High-value reimbursement SLA",
    description:
      "For a claim over 25,000: wait for a decision; if none within 2 days, nudge the approving manager. The " +
      "approve/reject branch cancels the timer. Disabled by default (opt-in; tune the threshold).",
    trigger: "reimbursement.submitted",
    enabled: false,
    condition: { field: "amount", op: "gt", value: 25000 },
    actions: [
      {
        kind: "waitFor",
        on: [
          { event: "reimbursement.approved", match: "subject", then: [{ kind: "notifyManager", noun: "high-value reimbursement resolved" }] },
          { event: "reimbursement.rejected", match: "subject", then: [{ kind: "notifyManager", noun: "high-value reimbursement resolved" }] },
          { timer: { days: 2 }, then: [
            { kind: "notifyManager", noun: "high-value reimbursement pending 2+ days" },
            { kind: "email", to: { of: "managerOf" }, subject: "A high-value reimbursement has been pending 2+ days", html: "<p>A high-value reimbursement claim from one of your reports has been awaiting a decision for over two days. Please review it in your Approvals inbox.</p>" },
          ] },
        ],
      },
    ],
  },
  {
    name: "Escalate high-priority tickets",
    description: "When a high-priority ticket is raised, alert the requester's manager. Disabled by default (opt-in).",
    trigger: "ticket.created",
    enabled: false,
    condition: { field: "priority", op: "eq", value: "high" },
    actions: [
      { kind: "notifyManager", noun: "high-priority support ticket raised by your report" },
      { kind: "email", to: { of: "managerOf" }, subject: "High-priority support ticket from your report", html: "<p>One of your reports raised a high-priority support ticket. Please make sure it's being picked up.</p>" },
    ],
  },
  {
    name: "Support SLA reminder",
    description:
      "When a ticket is raised, wait for it to be resolved; if it isn't within 3 days, nudge the requester. " +
      "Disabled by default (opt-in). Durable: the resolve cancels the timer.",
    trigger: "ticket.created",
    enabled: false,
    actions: [
      {
        kind: "waitFor",
        on: [
          { event: "ticket.resolved", match: "subject", then: [{ kind: "notify", recipient: { of: "subject" }, title: "Your ticket was resolved", body: "Thanks for your patience.", link: "tickets" }] },
          { timer: { days: 3 }, then: [{ kind: "notify", recipient: { of: "subject" }, title: "Still working on your ticket", body: "This is taking a little longer than usual - we're on it.", link: "tickets" }] },
        ],
      },
    ],
  },
  {
    name: "Policy acknowledgement reminder",
    description: "When a policy document that requires acknowledgement is published, remind everyone after 7 days. Disabled by default (opt-in; can be noisy).",
    trigger: "document.published",
    enabled: false,
    condition: { field: "requiresAck", op: "eq", value: true },
    actions: [{ kind: "wait", delayDays: 7, then: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "Please acknowledge the recent policy", body: "A policy published last week still needs your acknowledgement.", link: "documents" }] }],
  },

  // ---- Integration example (needs webhook egress configured) ----
  {
    name: "Sync new hires to an external system",
    description:
      "Example: POST new-hire basics to an external HRIS/provisioning webhook. Disabled by default and inert until " +
      "an operator configures webhook egress (the WebhookSender port + a destination allowlist).",
    trigger: "employee.created",
    enabled: false,
    actions: [{ kind: "webhook", url: "https://example.invalid/hooks/new-hire", includeFields: ["departmentId", "startDate"] }],
  },

  // ============================================================================================
  // Cross-section chains. Each spans MULTIPLE modules; together they exercise every action kind -
  // apiCall (create records in another section), emitEvent (delayed fan-out), wait, waitFor (event
  // + timer arms), notify (subject/manager), notifyAudience (department + everyone), and webhook.
  // {{today}} stamps date fields; the notifyAudience audience is templated from the event.
  // ============================================================================================

  // Lifecycle -> Support: raise the hire's day-one requests ON BEHALF OF them (owner = the new hire, via the
  // `employee` owner-ref), so the tickets show up in their queue. An automation runs as the system principal,
  // which can't own a ticket itself but may create one for an employee; categories ("it"/"facilities") ship as
  // defaults (see DEFAULT_CATEGORIES in services/tickets.ts).
  {
    name: "Provision IT & workspace for new hires",
    description:
      "When an employee is created: raise an IT provisioning ticket and a facilities (desk + access card) ticket " +
      "for the new hire (Support), let them know, and brief their manager. Bridges Lifecycle -> Support.",
    trigger: "employee.created",
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "{{subject}}", category: "it", subject: "Provision accounts for a new hire", description: "Create email, SSO, and tool access before the start date.", priority: "high", initial_todos: ["Email + SSO", "Laptop", "Software licenses"] } },
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "{{subject}}", category: "facilities", subject: "Desk & access card for a new hire", description: "Assign a desk and issue a building access card.", priority: "medium", initial_todos: ["Desk", "Access card"] } },
      { kind: "notify", recipient: { of: "subject" }, title: "We're setting up your workspace", body: "IT access and your desk are being arranged - they'll be ready for your first day.", link: "tickets" },
      { kind: "notifyManager", noun: "new hire - IT & facilities requests raised" },
    ],
  },

  // Lifecycle -> Engagement: welcome a hire to their OWN department (a department-scoped audience from the event).
  {
    name: "Introduce a new hire to their department",
    description:
      "When an employee is created, post a welcome to their department's members (Engagement) - scoped to the " +
      "immediate team via the event's department, not the whole company. Disabled by default (opt-in broadcast).",
    trigger: "employee.created",
    enabled: false,
    actions: [
      { kind: "notifyAudience", audience: { kind: "department", department: "{{departmentId}}" }, title: "A new teammate is joining!", body: "Please give a warm welcome to the newest member of your team.", link: "employees" },
    ],
  },

  // Lifecycle -> (7-day delay) -> milestone fan-out: raise a "first week" signal several rules react to.
  {
    name: "Raise the first-week milestone",
    description: "Seven days after a hire finishes onboarding, emit the 'first week' milestone the rules below react to (Lifecycle). A delayed fan-out (wait -> emitEvent).",
    trigger: "employee.onboarded",
    actions: [{ kind: "wait", delayDays: 7, then: [{ kind: "emitEvent", type: "milestone.firstWeek" }] }],
  },
  {
    name: "First week: nudge the manager for feedback",
    description: "At a new hire's first-week milestone, ask their manager for early feedback (Performance).",
    trigger: "milestone.firstWeek",
    actions: [{ kind: "notifyManager", noun: "new hire's first week - share early feedback" }],
  },
  {
    name: "First week: open a settling-in check-in",
    description: "At a new hire's first-week milestone, open a settling-in 1:1 with the employee (Performance).",
    trigger: "milestone.firstWeek",
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/check-ins", body: { employee: "employees/{{employeeId}}", notes: "First-week settling-in check-in" } }],
  },

  // Payroll: durable disbursement SLA for an approved loan (the disbursed arm cancels the timer).
  {
    name: "Track loan disbursement",
    description:
      "When a loan is approved: confirm the EMI to the employee, then wait for disbursement - confirming it when " +
      "it happens, or flagging the manager if it hasn't disbursed within 5 days (Payroll). Durable.",
    trigger: "loan.approved",
    actions: [
      { kind: "notify", recipient: { of: "subject" }, title: "Your loan is approved", body: "Your monthly EMI will be {{emiAmount}}. We'll disburse the loan shortly.", link: "loans" },
      {
        kind: "waitFor",
        on: [
          { event: "loan.disbursed", match: "employeeId", then: [{ kind: "notify", recipient: { of: "subject" }, title: "Your loan has been disbursed", body: "The approved amount of {{amount}} has been disbursed.", link: "loans" }] },
          { timer: { days: 5 }, then: [{ kind: "notifyManager", noun: "approved loan not disbursed after 5 days" }] },
        ],
      },
    ],
  },

  // Recruiting -> Payroll: track a referral reward all the way to payout, nudging if it stalls. Durable.
  {
    name: "Track a referral bonus to payout",
    description:
      "When a referral bonus is awarded: tell the referrer, then wait for it to be paid in payroll - confirming " +
      "the payout, or nudging after 60 days if it hasn't been paid (Recruiting -> Payroll). Durable.",
    trigger: "referral.awarded",
    actions: [
      { kind: "notify", recipient: { of: "subject" }, title: "Your referral bonus is approved", body: "A referral bonus of {{amount}} has been awarded and will be paid in an upcoming payroll run.", link: "referrals" },
      {
        kind: "waitFor",
        on: [
          { event: "referral.paid", match: "employeeId", then: [{ kind: "notify", recipient: { of: "subject" }, title: "Your referral bonus was paid", body: "Your {{amount}} referral bonus was included in this payroll run.", link: "payslips" }] },
          { timer: { days: 60 }, then: [{ kind: "notifyManager", noun: "referral bonus still unpaid after 60 days" }] },
        ],
      },
    ],
  },

  // Lifecycle -> Payroll -> Engagement: reward a milestone anniversary with a real bonus, then celebrate it.
  // Money + broadcast, so DISABLED by default. Uses {{today}} to stamp the scoped bonus award.
  {
    name: "Reward milestone work anniversaries",
    description:
      "On a 3+ year work anniversary: award a loyalty bonus (Payroll, paid next run, stamped {{today}}), thank " +
      "the employee, and invite the company to celebrate (Engagement). Disabled by default (money + broadcast).",
    trigger: "schedule.workAnniversary",
    enabled: false,
    condition: { field: "years", op: "gte", value: 3 },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/bonuses:award", body: { scope: "individual", employee: "employees/{{employeeId}}", amount: 5000, kind: "loyalty", reason: "{{years}}-year work anniversary", award_date: "{{today}}" } },
      { kind: "notify", recipient: { of: "subject" }, title: "Thank you for {{years}} years!", body: "We've added a loyalty bonus to your next payslip in appreciation of your time with us.", link: "payslips" },
      { kind: "notifyAudience", audience: { kind: "everyone" }, title: "Celebrating a big milestone!", body: "A colleague is marking {{years}} years with us today - drop them a note of congratulations.", link: "employees" },
    ],
  },

  // Lifecycle -> Support -> Engagement -> external: offboarding deprovision ticket + farewell + HRIS sync.
  {
    name: "Offboarding: deprovision, farewell & sync",
    description:
      "When an offboarding completes: raise an IT deprovisioning ticket for the leaver (Support), post a farewell " +
      "to the company (Engagement), and notify an external HRIS via webhook. Disabled by default (broadcast + " +
      "needs webhook egress configured).",
    trigger: "transition.completed",
    enabled: false,
    condition: { field: "kind", op: "eq", value: "offboarding" },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "it", subject: "Deprovision a departing employee", description: "Revoke SSO/email/tool access and reclaim company assets.", priority: "high", initial_todos: ["Revoke SSO & email", "Reclaim laptop", "Reclaim access card"] } },
      { kind: "notifyAudience", audience: { kind: "everyone" }, title: "Farewell to a colleague", body: "A teammate is moving on - thank them for their contributions and wish them well.", link: "employees" },
      { kind: "webhook", url: "https://example.invalid/hooks/offboard", includeFields: ["kind"] },
    ],
  },

  // ============================================================================================
  // Module coverage: rules for every request/approve surface the app now emits events for -
  // leave, encashment, overtime, remote work, attendance regularization, reimbursement, loan,
  // payroll, document publish, and support. Approval SLAs are durable (waitFor: the decision arm
  // cancels the timer, correlated on the request's subject).
  // ============================================================================================

  // ---- Leave & time off ----
  {
    name: "Leave decision SLA",
    description: "When leave is requested, wait for the decision; if none within 2 days, nudge the approving manager (the approve/reject cancels the timer).",
    trigger: "leave.requested",
    actions: [{ kind: "waitFor", on: [
      { event: "leave.approved", match: "subject", then: [{ kind: "notifyManager", noun: "leave request resolved" }] },
      { event: "leave.rejected", match: "subject", then: [{ kind: "notifyManager", noun: "leave request resolved" }] },
      { timer: { days: 2 }, then: [
        { kind: "notifyManager", noun: "leave request awaiting your decision for 2+ days" },
        { kind: "email", to: { of: "managerOf" }, subject: "A leave request has been waiting 2+ days", html: "<p>A leave request from one of your reports has been awaiting your decision for over two days. Please review it in your Approvals inbox.</p>" },
      ] },
    ] }],
  },
  {
    name: "Extended leave: arrange coverage",
    description: "When a leave of 5+ days is approved, remind the manager to arrange coverage for the team.",
    trigger: "leave.approved",
    condition: { field: "days", op: "gte", value: 5 },
    actions: [{ kind: "notifyManager", noun: "extended leave approved - arrange coverage" }],
  },
  {
    name: "Leave cancelled: free the calendar",
    description: "When an employee cancels approved/pending leave, let their manager know the dates are freed up.",
    trigger: "leave.cancelled",
    actions: [{ kind: "notifyManager", noun: "report cancelled their leave" }],
  },
  {
    name: "Acknowledge an encashment request",
    description: "When an employee requests leave encashment, confirm it was received and is pending HR review.",
    trigger: "leaveEncashment.requested",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Encashment request received", body: "Your request to encash {{days}} day(s) has been submitted - HR will review it.", link: "leave-requests/encashments" }],
  },
  {
    name: "Confirm an approved encashment",
    description: "When leave encashment is approved, tell the employee it will be paid in an upcoming payroll run.",
    trigger: "leaveEncashment.approved",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Encashment approved", body: "Your encashment of {{days}} day(s) ({{amount}}) will be paid in an upcoming payroll run.", link: "payslips" }],
  },

  // ---- Attendance & scheduling ----
  {
    name: "Overtime decision SLA",
    description: "When overtime is requested, nudge the manager if it isn't approved within 2 days. Durable.",
    trigger: "overtime.requested",
    actions: [{ kind: "waitFor", on: [
      { event: "overtime.approved", match: "subject", then: [{ kind: "notifyManager", noun: "overtime request resolved" }] },
      { timer: { days: 2 }, then: [
        { kind: "notifyManager", noun: "overtime request awaiting approval for 2+ days" },
        { kind: "email", to: { of: "managerOf" }, subject: "An overtime request needs your decision", html: "<p>An overtime request from one of your reports has been waiting over two days. Please approve or decline it in your Approvals inbox.</p>" },
      ] },
    ] }],
  },
  {
    name: "Confirm approved overtime",
    description: "When overtime is approved, confirm to the employee that it will be paid as a taxable earning in the next run.",
    trigger: "overtime.approved",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Overtime approved", body: "Your {{hours}} hour(s) of overtime were approved and will be paid in your next payroll run.", link: "overtime/history" }],
  },
  {
    name: "Remote-work decision SLA",
    description: "When remote work is requested, nudge the manager if it isn't decided within 2 days. Durable.",
    trigger: "remoteWork.requested",
    actions: [{ kind: "waitFor", on: [
      { event: "remoteWork.approved", match: "subject", then: [{ kind: "notifyManager", noun: "remote-work request resolved" }] },
      { timer: { days: 2 }, then: [
        { kind: "notifyManager", noun: "remote-work request awaiting your decision" },
        { kind: "email", to: { of: "managerOf" }, subject: "A remote-work request needs your decision", html: "<p>A remote-work request from one of your reports has been waiting over two days. Please review it in your Approvals inbox.</p>" },
      ] },
    ] }],
  },
  {
    name: "Regularization decision SLA",
    description: "When an attendance regularization is requested, nudge the manager if it isn't decided within 3 days. Durable.",
    trigger: "attendanceRegularization.requested",
    actions: [{ kind: "waitFor", on: [
      { event: "attendanceRegularization.approved", match: "subject", then: [{ kind: "notifyManager", noun: "regularization resolved" }] },
      { timer: { days: 3 }, then: [
        { kind: "notifyManager", noun: "attendance regularization awaiting your decision" },
        { kind: "email", to: { of: "managerOf" }, subject: "An attendance regularization needs your decision", html: "<p>An attendance regularization from one of your reports has been waiting over three days. Please review it in your Approvals inbox.</p>" },
      ] },
    ] }],
  },

  // ---- Payroll & compensation ----
  {
    name: "Payday announcement",
    description: "When a payroll run is published, announce to the company that payslips are available. Disabled by default (org-wide broadcast).",
    trigger: "payroll.published",
    enabled: false,
    actions: [
      { kind: "notifyAudience", audience: { kind: "everyone" }, title: "Payslips are ready", body: "Payslips for this pay cycle have been published - view yours in Payslips.", link: "payslips" },
      { kind: "emailAudience", audience: { kind: "everyone" }, subject: "Your payslip is ready", html: "<p>Payslips for this pay cycle have been published. Log in to view yours under Payslips.</p>" },
    ],
  },
  {
    name: "Email each employee their payslip",
    description:
      "When a payslip is published (one event per employee), email that employee their payslip PDF as an " +
      "attachment. Disabled by default (a payslip is sensitive PII leaving over email; enable once your email " +
      "provider is configured and this is a deliberate policy). Showcases an email attachment referencing the " +
      "event's payslip.",
    trigger: "payslip.published",
    enabled: false,
    actions: [{ kind: "email", to: { of: "subject" }, subject: "Your payslip is ready", html: "<p>Your payslip for this pay period is attached. You can also view it any time under Payslips.</p>", attachments: [{ document: "{{subject}}", filename: "Payslip.pdf" }] }],
  },
  {
    name: "Email finance the payroll bank file",
    description:
      "When a payroll run is published, email the bank-transfer file to finance as an attachment. Disabled by " +
      "default - set your finance address and the bank format slug, then enable. Showcases an address recipient " +
      "(not an employee) plus a generated (bankFile) attachment.",
    trigger: "payroll.published",
    enabled: false,
    actions: [{ kind: "email", to: { of: "address", address: "finance@example.com" }, subject: "Payroll bank file for the latest run", html: "<p>The bank-transfer file for the latest published payroll run is attached. Upload it to your bank portal to disburse salaries.</p>", attachments: [{ bankFile: { run: "{{subject}}", bank: "your-bank-format" }, filename: "payroll-bank-file.xlsx" }] }],
  },
  {
    name: "Reimbursement approved: assure payout",
    description: "When a reimbursement claim is approved, tell the employee it will be paid in an upcoming run.",
    trigger: "reimbursement.approved",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Reimbursement approved", body: "Your claim for {{amount}} was approved and will be paid in an upcoming payroll run.", link: "reimbursements/history" }],
  },
  {
    name: "Reimbursement rejected: next steps",
    description: "When a reimbursement claim is rejected, point the employee at what to do next.",
    trigger: "reimbursement.rejected",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Reimbursement not approved", body: "Your claim for {{amount}} wasn't approved. Check the notes, then reach out to finance or resubmit with the right details.", link: "reimbursements/history" }],
  },
  {
    name: "Track a reimbursement to payout",
    description: "When a claim is approved, wait for it to be paid; if it hasn't been within 14 days, reassure the employee it's still processing. Disabled by default. Durable.",
    trigger: "reimbursement.approved",
    enabled: false,
    actions: [{ kind: "waitFor", on: [
      { event: "reimbursement.paid", match: "subject", then: [{ kind: "notify", recipient: { of: "subject" }, title: "Reimbursement paid", body: "Your approved claim has been paid.", link: "reimbursements/history" }] },
      { timer: { days: 14 }, then: [{ kind: "notify", recipient: { of: "subject" }, title: "Your reimbursement is still processing", body: "Your approved claim hasn't been paid yet - it will be included in an upcoming run.", link: "reimbursements/history" }] },
    ] }],
  },
  {
    name: "Loan request SLA",
    description: "When a loan/advance is requested, wait for the decision; if none within 3 days, nudge the approving manager. Durable.",
    trigger: "loan.requested",
    actions: [{ kind: "waitFor", on: [
      { event: "loan.approved", match: "subject", then: [{ kind: "notifyManager", noun: "loan request resolved" }] },
      { event: "loan.rejected", match: "subject", then: [{ kind: "notifyManager", noun: "loan request resolved" }] },
      { timer: { days: 3 }, then: [
        { kind: "notifyManager", noun: "loan request awaiting your decision for 3+ days" },
        { kind: "email", to: { of: "managerOf" }, subject: "A loan/advance request needs your decision", html: "<p>A loan/advance request from one of your reports has been awaiting your decision for over three days. Please review it in your Approvals inbox.</p>" },
      ] },
    ] }],
  },
  {
    name: "Loan rejected: guidance",
    description: "When a loan/advance is not approved, let the employee know HR can talk through the options.",
    trigger: "loan.rejected",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Your request wasn't approved", body: "Your loan/advance request wasn't approved this time. HR can walk you through the eligibility and alternatives.", link: "loans" }],
  },
  {
    name: "Loan repayment progress",
    description: "After each payroll installment, tell the employee the remaining balance. Disabled by default (one message per run can be noisy).",
    trigger: "loan.repaymentRecorded",
    enabled: false,
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Loan installment recorded", body: "This run's installment of {{amount}} was deducted. Remaining balance: {{outstanding}}.", link: "loans" }],
  },

  // ---- Lifecycle & performance ----
  {
    name: "Anniversary: nudge the manager to recognize",
    description: "On an employee's work anniversary, prompt their manager to send a note of appreciation.",
    trigger: "schedule.workAnniversary",
    actions: [{ kind: "notifyManager", noun: "report's work anniversary today - send a note" }],
  },
  {
    name: "New hire: assign security & compliance training",
    description: "When a new hire finishes onboarding, create a goal to complete security & compliance training (Performance).",
    trigger: "employee.onboarded",
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/goals", body: { employee: "employees/{{employeeId}}", title: "Complete security & compliance training", description: "Finish the mandatory security and workplace-conduct modules in your first weeks." } }],
  },
  {
    name: "New hire: schedule a 90-day review",
    description: "When a new hire finishes onboarding, open a 90-day review check-in with their manager after 90 days (wait -> create).",
    trigger: "employee.onboarded",
    actions: [{ kind: "wait", delayDays: 90, then: [{ kind: "apiCall", method: "POST", path: "/v1/check-ins", body: { employee: "employees/{{employeeId}}", notes: "90-day review check-in" } }] }],
  },
  {
    name: "First week: share the handbook",
    description: "At a new hire's first-week milestone, point them to the employee handbook and policies.",
    trigger: "milestone.firstWeek",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Get to know how we work", body: "Take some time this week to read the employee handbook and company policies.", link: "documents" }],
  },

  // ---- Compliance & documents ----
  {
    name: "New policy: prompt acknowledgement",
    description: "When a policy that requires acknowledgement is published, prompt everyone to review & sign it now. Disabled by default (org-wide broadcast; the 7-day reminder is separate).",
    trigger: "document.published",
    enabled: false,
    condition: { field: "requiresAck", op: "eq", value: true },
    actions: [
      { kind: "notifyAudience", audience: { kind: "everyone" }, title: "A new policy needs your acknowledgement", body: "A policy was just published that requires your review and signature.", link: "documents" },
      { kind: "emailAudience", audience: { kind: "everyone" }, subject: "A new policy needs your acknowledgement", html: "<p>A new policy was just published that requires your review and signature. Please log in to read and acknowledge it.</p>" },
    ],
  },

  // ---- Support ----
  {
    name: "Ticket resolved: ask for feedback",
    description: "When a support ticket is resolved, invite the requester to confirm it's fixed and share feedback.",
    trigger: "ticket.resolved",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Your ticket was resolved", body: "We've marked your ticket resolved. If it's not fully sorted, reopen it or reply - and tell us how we did.", link: "tickets" }],
  },

  // ============================================================================================
  // Cross-section action-item chains. An automation runs as the system principal, which can now open a
  // REAL, employee-owned ticket on behalf of the subject - so an event in one module becomes a tracked task
  // in Support. Plus a 30-day milestone fan-out (emitEvent -> waitFor linkage) and captureAs data-passing.
  // ============================================================================================

  // Compliance -> Support (data-passing): an expiring document becomes a concrete renewal task owned by the
  // employee, and the confirmation cites the ticket that was just created (captureAs -> {{results}}).
  {
    name: "Open a renewal task for an expiring document",
    description: "When a personal document is within 15 days of expiry, open an HR ticket for the owner to upload the renewed copy, then confirm the task to them. Bridges Compliance -> Support.",
    trigger: "document.expiring",
    condition: { field: "daysLeft", op: "lte", value: 15 },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "hr", subject: "Renew an expiring document", description: "Your document \"{{title}}\" expires in {{daysLeft}} day(s). Please upload the renewed copy.", priority: "medium" }, captureAs: "renewalTicket" },
      { kind: "notify", recipient: { of: "subject" }, title: "We've opened a renewal task", body: "\"{{results.renewalTicket.subject}}\" is on your tickets - please upload the renewed document before it expires.", link: "tickets" },
    ],
  },

  // Leave -> Support: an extended absence gets a coverage/handover task + a manager heads-up. Disabled by
  // default (opens a ticket for every 10+ day leave; opt in once your coverage process wants it).
  {
    name: "Plan coverage for extended leave",
    description: "When 10+ days of leave are approved: brief the manager and open a coverage/handover task for the employee. Bridges Leave -> Support. Disabled by default.",
    trigger: "leave.approved",
    enabled: false,
    condition: { field: "days", op: "gte", value: 10 },
    actions: [
      { kind: "notifyManager", noun: "extended leave approved - plan coverage & handover" },
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "general", subject: "Coverage & handover for extended leave", description: "{{days}} day(s) of leave approved. Note who covers what and hand over in-flight work.", priority: "medium" } },
    ],
  },

  // Lifecycle -> Support: fulfil a small recognition gesture on a work anniversary. Disabled by default
  // (money/logistics + fires yearly).
  {
    name: "Fulfil a work-anniversary gift",
    description: "On a work anniversary, open a facilities task to send a small gift/token. Bridges Lifecycle -> Support. Disabled by default.",
    trigger: "schedule.workAnniversary",
    enabled: false,
    condition: { field: "years", op: "gte", value: 1 },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "facilities", subject: "Send a work-anniversary gift", description: "{{years}}-year anniversary - arrange a small gift or token of appreciation.", priority: "low" } },
    ],
  },

  // Engagement -> Support: route a NON-anonymous suggestion into an HR triage ticket. Disabled by default
  // (the built-in HR respond flow may be enough). Condition keeps anonymous suggestions out of a ticket (a
  // ticket is owner-attributed, which would defeat anonymity).
  {
    name: "Triage a suggestion into an HR ticket",
    description: "When a non-anonymous suggestion is submitted, open an HR ticket to review and respond. Bridges Engagement -> Support. Disabled by default (anonymity-safe: anonymous ones are skipped).",
    trigger: "suggestion.submitted",
    enabled: false,
    condition: { field: "anonymous", op: "eq", value: false },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "hr", subject: "Review an employee suggestion", description: "A suggestion was submitted for review - triage it and respond via the Suggestions page.", priority: "low" } },
    ],
  },

  // Lifecycle fan-out: 30 days after onboarding, raise a milestone several rules react to (delayed emitEvent).
  {
    name: "Raise the 30-day milestone",
    description: "Thirty days after a hire finishes onboarding, emit the 'first month' milestone the rules below react to (Lifecycle). Delayed fan-out (wait -> emitEvent).",
    trigger: "employee.onboarded",
    actions: [{ kind: "wait", delayDays: 30, then: [{ kind: "emitEvent", type: "milestone.thirtyDays" }] }],
  },
  {
    name: "First month: manager review touchpoint",
    description: "At a new hire's 30-day milestone, prompt their manager for a first-month review (Performance).",
    trigger: "milestone.thirtyDays",
    actions: [{ kind: "notifyManager", noun: "new hire's first month - do a quick review" }],
  },
  {
    name: "First month: employee pulse",
    description: "At a new hire's 30-day milestone, invite them to share how their first month has gone (Performance).",
    trigger: "milestone.thirtyDays",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "How's your first month going?", body: "You're 30 days in - share what's working and what you need with your manager.", link: "check-ins" }],
  },

  // Lifecycle -> Performance (durable emitEvent<->waitFor linkage): from onboarding, wait for the 30-day
  // milestone (above) to fire; if ramp seems slow (no milestone within 45 days), nudge the manager instead.
  {
    name: "New hire ramp watch",
    description: "From onboarding, wait for the 30-day milestone to celebrate one month in; if it hasn't fired within 45 days, nudge the manager to check on ramp-up. Durable; links to the milestone fan-out.",
    trigger: "employee.onboarded",
    actions: [{ kind: "waitFor", on: [
      { event: "milestone.thirtyDays", match: "employeeId", then: [{ kind: "notify", recipient: { of: "subject" }, title: "One month in - nice work!", body: "You've completed your first month. Keep going!", link: "dashboard" }] },
      { timer: { days: 45 }, then: [{ kind: "notifyManager", noun: "new hire ramp-up - check in if it's lagging" }] },
    ] }],
  },

  // Support CSAT: a delayed satisfaction nudge after a ticket is resolved (complements the immediate notice).
  {
    name: "Ticket CSAT follow-up",
    description: "Two days after a ticket is resolved, follow up so the requester can confirm it stayed fixed and rate the experience (Support). Uses a delay.",
    trigger: "ticket.resolved",
    enabled: false,
    actions: [{ kind: "wait", delayDays: 2, then: [{ kind: "notify", recipient: { of: "subject" }, title: "Did that fix it?", body: "It's been a couple of days since we resolved your ticket - reopen it if anything's still off, and let us know how we did.", link: "tickets" }] }],
  },

  // Leave -> external: mirror approved leave into an external calendar/HRIS. Disabled by default (needs
  // webhook egress configured).
  {
    name: "Sync approved leave to an external calendar",
    description: "When leave is approved, POST the dates to an external calendar/HRIS webhook. Disabled by default and inert until webhook egress is configured.",
    trigger: "leave.approved",
    enabled: false,
    actions: [{ kind: "webhook", url: "https://example.invalid/hooks/leave-approved", includeFields: ["from", "to", "days"] }],
  },

  // ============================================================================================
  // State-changing chains: these DON'T just notify - they drive real records/transitions in another module
  // via apiCall (run as system through the app's own authz + validation). Money/compliance/pipeline moves ship
  // DISABLED so an admin opts in deliberately.
  // ============================================================================================

  // Lifecycle -> Payroll -> Support (data-passing): an exit kicks off the full-and-final settlement, then opens
  // an exit-clearance ticket that links to the settlement it just computed (captureAs -> {{results}}).
  {
    name: "Offboarding: compute F&F settlement + exit clearance",
    description: "When an offboarding completes: compute and store the full-and-final settlement (Payroll), then open an exit-clearance ticket for the employee that references it. Disabled by default (F&F is usually HR-reviewed).",
    trigger: "transition.completed",
    enabled: false,
    condition: { field: "kind", op: "eq", value: "offboarding" },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/settlements", body: { employee: "employees/{{employeeId}}" }, captureAs: "settlement" },
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "hr", subject: "Exit clearance & asset return", description: "Complete exit clearance and reclaim assets. Full-and-final settlement draft: {{results.settlement.path}}.", priority: "high" } },
    ],
  },

  // Support: standardize triage - a new IT ticket gets the team's checklist appended automatically.
  {
    name: "Seed a triage checklist on IT tickets",
    description: "When an IT support ticket is raised, append the standard triage checklist so nothing is missed. Bridges into Support workflow (a real record change, not a message).",
    trigger: "ticket.created",
    condition: { field: "category", op: "eq", value: "it" },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/{{subject}}:addTodos", body: { texts: ["Acknowledge & triage", "Reproduce / confirm the issue", "Resolve & verify the fix", "Confirm with the requester"] } },
    ],
  },

  // Payroll: auto-approve a small salary advance under a cap (approveLoan computes the EMI itself). Disabled by
  // default - it moves money without a human, so opt in and tune the cap.
  {
    name: "Auto-approve small salary advances",
    description: "When a loan/advance of 10,000 or less is requested, approve it automatically (Payroll). Disabled by default (moves money with no human decision; set your own cap).",
    trigger: "loan.requested",
    enabled: false,
    condition: { field: "amount", op: "lte", value: 10000 },
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/{{subject}}:approve" }],
  },

  // Payroll -> Compliance: every published run opens the statutory-remittance filing to track (PF/ESI/TDS).
  // Disabled by default (statutory setup + due dates vary; adjust the created event's date).
  {
    name: "Open the statutory filing after each run",
    description: "When a payroll run is published, create a compliance event to remit statutory dues (PF/ESI/TDS) for that period. Bridges Payroll -> Compliance. Disabled by default (tune the due date).",
    trigger: "payroll.published",
    enabled: false,
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/compliance-events", body: { title: "Remit statutory dues for the latest pay run", category: "payroll", frequency: "one_time", due_date: "{{today}}" } },
    ],
  },

  // Lifecycle -> Compliance: kick off identity background verification for a new hire. Disabled by default
  // (BGV is sensitive and often vendor-driven; opt in).
  {
    name: "Initiate a new hire's background check",
    description: "When an employee is created, open an identity background-check record to start verification (Compliance). Bridges Lifecycle -> Compliance. Disabled by default.",
    trigger: "employee.created",
    enabled: false,
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/background-checks", body: { employee: "{{subject}}", check_type: "identity" } }],
  },

  // Lifecycle -> Performance: give a new hire a tracked "get set up" goal (safe, enabled).
  {
    name: "New hire: complete-your-profile goal",
    description: "When an employee is created, create a goal prompting them to complete their profile (bank, identity, personal details, documents). Bridges Lifecycle -> Performance.",
    trigger: "employee.created",
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/goals", body: { employee: "{{subject}}", title: "Complete your employee profile", description: "Add your bank, identity and personal details and upload any required documents in your first week." } }],
  },

  // Lifecycle -> Support: turn a probation deadline into a trackable HR decision task (enabled - one per end).
  {
    name: "Open a probation confirmation task",
    description: "When probation is ending, open an HR ticket to confirm or extend it, so the decision is tracked (not just a reminder). Bridges Lifecycle -> Support.",
    trigger: "schedule.probationEnding",
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "hr", subject: "Confirm or extend probation", description: "Probation ends {{probationEndDate}}. Confirm the employee or extend probation, then update their record.", priority: "medium" } }],
  },

  // Payroll: auto-approve a small reimbursement under a cap (approveReimbursement needs no body). Disabled by
  // default - approving without a human is a policy choice; set your own cap.
  {
    name: "Auto-approve small reimbursements",
    description: "When a reimbursement of 2,000 or less is submitted, approve it automatically (Payroll). Disabled by default (no human decision; tune the cap).",
    trigger: "reimbursement.submitted",
    enabled: false,
    condition: { field: "amount", op: "lte", value: 2000 },
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/{{subject}}:approve" }],
  },

  // Payroll: disburse a loan/advance as soon as it's approved (skips the manual finance step). Disabled by
  // default (moves money automatically).
  {
    name: "Auto-disburse approved advances",
    description: "When a loan/advance is approved, disburse it automatically (Payroll). Disabled by default (auto money movement; enable if finance wants approval to release funds).",
    trigger: "loan.approved",
    enabled: false,
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/{{subject}}:disburse" }],
  },

  // Leave: auto-approve a single-day leave (e.g. one sick day). The approve path re-checks balance, so an
  // over-draw still fails safely. Disabled by default (bypasses manager judgment).
  {
    name: "Auto-approve single-day leave",
    description: "When a leave request of 1 day or less is made, approve it automatically (Leave). Disabled by default (bypasses the manager's decision; the balance check still applies).",
    trigger: "leave.requested",
    enabled: false,
    condition: { field: "days", op: "lte", value: 1 },
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/{{subject}}:approve" }],
  },

  // Lifecycle -> Assets: create a laptop asset assigned to the new hire so IT inventory tracks it. Disabled by
  // default (IT records the real model and files it under a category). No `category` in the body: it is a
  // reference to an asset-categories row, whose id differs per org, so the tag is allocated uncategorised
  // (AST-nnn) until IT files it - which is also when the row stops being a placeholder.
  {
    name: "Assign a laptop to new hires",
    description: "When an employee is created, add a 'Company laptop' asset assigned to them so it shows in IT inventory. Bridges Lifecycle -> Assets. Disabled by default (IT sets the real model and category).",
    trigger: "employee.created",
    enabled: false,
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/assets", body: { name: "Company laptop", status: "assigned", assigned_to: "{{subject}}" } }],
  },

  // ============================================================================================
  // Assets: turning "somebody asked for a laptop" into a process that finishes.
  //
  // The inventory already enforces the physical half by itself (a tag is allocated on create, custody is only
  // proved by scanning, the nightly tick chases an unconfirmed hand-over). What no service does is close the
  // ORGANISATIONAL loop: an approved request that nobody acts on, kit that arrives broken, a leaver who walks
  // out still holding a laptop. Those are the rules below, and they are what make the request feature useful
  // rather than a form that files a row.
  //
  // A rule that has to name an asset CATEGORY ships disabled, because a category id differs per org - the
  // description says which path to paste in.
  // ============================================================================================

  // The fulfilment chain, and the reason `:issue` exists as its own step: approving a request promises somebody
  // a machine, so the promise gets a ticket in the queue that actually holds the stock, the requester is told
  // where their ask went, and then the chain SUSPENDS. Handing the asset over resolves the ticket by itself
  // (data-passing: the ticket's own path came back from the create call); a week of silence bumps it to high
  // priority and says so out loud, rather than letting an approved request rot.
  {
    name: "Asset request approved: open the hand-over ticket, then chase it",
    description:
      "When an asset request is approved: open an IT ticket to prepare and hand over the kit, tell the requester which ticket " +
      "is carrying it, then wait. If the asset is handed over, the ticket resolves itself and the requester is told to scan its " +
      "tag. If a week passes with nothing handed over, the ticket goes to high priority and both sides hear about it. This is " +
      "the approve -> prepare -> hand over -> confirm loop as data.",
    trigger: "assetRequest.approved",
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "it", subject: "Prepare and hand over requested kit", description: "An asset request from this person was approved. Pick something out of stock and use Hand over on their profile's Assets tab - that closes the request and starts the custody scan.", priority: "medium", initial_todos: ["Find or order the kit", "Print its tag", "Hand it over from the request"] }, captureAs: "handover" },
      { kind: "notify", recipient: { of: "subject" }, title: "Your asset request was approved", body: "IT is preparing it - {{results.handover.path}} is tracking the hand-over. You'll be asked to scan the tag when you receive it.", link: "profile" },
      {
        kind: "waitFor",
        on: [
          {
            event: "assetRequest.issued",
            match: "employeeId",
            then: [
              { kind: "apiCall", method: "POST", path: "/v1/{{results.handover.path}}:resolve" },
              { kind: "notify", recipient: { of: "subject" }, title: "Your kit is ready", body: "It has been handed over. Scan the tag on it to confirm you have it - until then it still shows as awaiting your confirmation.", link: "profile" },
            ],
          },
          {
            timer: { days: 7 },
            then: [
              { kind: "apiCall", method: "POST", path: "/v1/{{results.handover.path}}:prioritize", body: { priority: "high" } },
              { kind: "apiCall", method: "POST", path: "/v1/{{results.handover.path}}:comment", body: { body: "A week since this request was approved and nothing has been handed over yet." } },
              { kind: "notify", recipient: { of: "subject" }, title: "Still waiting on your kit", body: "Your approved asset request hasn't been handed over after a week. It has been escalated with IT.", link: "profile" },
              { kind: "notifyManager", noun: "approved asset request still not handed over" },
            ],
          },
        ],
      },
    ],
  },

  // Receiving is the first honest inspection an asset gets, and the scan already carries what the holder saw.
  // Anything other than "good" becomes a ticket instead of a condition string nobody reads again.
  {
    name: "Asset arrived damaged: raise it with IT",
    description:
      "When somebody confirms receipt of an asset but reports it as damaged or missing parts, open a high-priority IT ticket " +
      "with what they reported and tell them it is being handled. The condition comes from their own scan, so this fires on the " +
      "first look anyone has had at the thing.",
    trigger: "asset.acknowledged",
    condition: { field: "condition", op: "ne", value: "good" },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "it", subject: "Asset {{assetTag}} reported as {{condition}} on receipt", description: "The holder confirmed receipt of {{assetTag}} and reported it as {{condition}}. Decide whether to repair, replace or swap it.", priority: "high", initial_todos: ["Inspect the asset", "Repair, replace or swap", "Update the asset's condition"] } },
      { kind: "notify", recipient: { of: "subject" }, title: "Thanks - we've logged that", body: "You reported {{assetTag}} as {{condition}} when you confirmed it. IT has a ticket for it and will come back to you.", link: "tickets" },
    ],
  },

  // The nightly tick nudges the holder every day and copies their manager at twice the threshold. Three weeks
  // of that means nudging is not working, so it stops being a notification and becomes somebody's job.
  {
    name: "Custody unconfirmed for three weeks: make it IT's job",
    description:
      "When an asset has been waiting three weeks for its holder to scan the tag, open an IT ticket to go and find it in person " +
      "and tell the manager. Beyond this point the daily reminder is clearly not landing - the asset may not be where the record " +
      "says it is.",
    trigger: "asset.custodyOverdue",
    condition: { all: [{ field: "kind", op: "eq", value: "ack" }, { field: "days", op: "gte", value: 21 }] },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "it", subject: "{{assetTag}} unconfirmed for {{days}} days", description: "{{name}} ({{assetTag}}) has been waiting {{days}} days for its holder to scan its tag. Go and sight it: either scan it with them, or record it as unaccounted for.", priority: "high", initial_todos: ["Find the asset in person", "Scan it with the holder", "If it can't be found, mark it accordingly"] } },
      { kind: "notifyManager", noun: "asset your report has never confirmed" },
    ],
  },

  // A tag exists so an asset can be sighted; an asset nobody has sighted in months is a record, not an asset.
  // The holder is the cheapest person to ask, and it costs them one scan.
  {
    name: "Asset not sighted in months: ask its holder to scan it",
    description:
      "When an asset hasn't been sighted for as long as the org's staleness window allows, ask whoever holds it to scan its tag " +
      "so the inventory is true again. Cheaper than a stocktake and it keeps the audit trail honest between them.",
    trigger: "asset.stale",
    actions: [
      { kind: "notify", recipient: { of: "subject" }, title: "Scan the kit you're holding", body: "Nobody has sighted {{name}} ({{assetTag}}) in {{days}} days. Open Assets and scan its tag - it takes a second and keeps the inventory true.", link: "assets" },
    ],
  },

  // A count that closes with things unaccounted for has done its job only if somebody then goes and looks. The
  // holder is the one person who can settle it in a minute, and the event fires once per missing item they hold.
  {
    name: "Missing in a stocktake: ask the holder to find it",
    description:
      "When a count closes without sighting an asset that somebody is holding, ask that person to scan its tag or say where it is. " +
      "The alternative is a missing list nobody reads, which is how paper inventories rot.",
    trigger: "asset.stocktakeMissing",
    actions: [
      { kind: "notify", recipient: { of: "subject" }, title: "We couldn't find your kit in the count", body: "{{name}} ({{assetTag}}) wasn't sighted in {{label}} - last seen {{days}} days ago. Open Assets and scan its tag, or tell IT where it is.", link: "assets" },
    ],
  },

  // Adding a row to the inventory is a claim; scanning it is the evidence. This waits for the evidence and only
  // speaks up if it never arrives - so the person who added the asset hears about their own loose end, once.
  {
    name: "New asset never scanned into stock: tell whoever added it",
    description:
      "When an asset is added, wait for somebody to scan it into stock. If that happens, confirm it to whoever added it; if three " +
      "days pass without a scan, remind them it is still an unverified record rather than kit anyone can hand out.",
    trigger: "asset.created",
    actions: [
      {
        kind: "waitFor",
        on: [
          { event: "asset.verified", match: "subject", then: [{ kind: "notify", recipient: { of: "actor" }, title: "Asset counted into stock", body: "{{assetTag}} has been scanned in and is available to hand out.", link: "assets" }] },
          { timer: { days: 3 }, then: [{ kind: "notify", recipient: { of: "actor" }, title: "An asset is still unverified", body: "{{assetTag}} was added three days ago and nobody has scanned it into stock yet, so it can't be handed to anyone. Print its tag and scan it in.", link: "assets" }] },
        ],
      },
    ],
  },

  // Offboarding closing is exactly when kit goes missing: the checklist is ticked, the person leaves, and a
  // laptop stays on their record forever. The count comes from the inventory itself (a GET whose response is
  // templated into the ticket), so the ticket says how many things are actually outstanding.
  {
    name: "Offboarding closed: reclaim whatever kit is still on their record",
    description:
      "When an offboarding completes, read what the leaver still has assigned and open a ticket to reclaim exactly that many " +
      "items. Uses the inventory's own answer rather than a generic 'collect the laptop' reminder, so it is obvious when the " +
      "answer is zero and nothing is owed.",
    trigger: "transition.completed",
    condition: { field: "kind", op: "eq", value: "offboarding" },
    actions: [
      { kind: "apiCall", method: "GET", path: "/v1/assets?employee=employees/{{employeeId}}", captureAs: "kit" },
      { kind: "apiCall", method: "POST", path: "/v1/tickets", body: { employee: "employees/{{employeeId}}", category: "it", subject: "Reclaim {{results.kit.results.length}} asset(s) from a leaver", description: "Offboarding is complete and the inventory still lists {{results.kit.results.length}} asset(s) against this person. Collect each one, scan it back into stock, and clear it off their record.", priority: "high", initial_todos: ["Collect the kit", "Scan each item back into stock", "Confirm nothing is left on their record"] } },
    ],
  },

  // Org-specific: both of these need one asset-category path pasted in, so they ship disabled rather than
  // half-configured. They are the two places where a standard kit policy stops being a conversation.
  {
    name: "Auto-approve requests for one standard category",
    description:
      "When an asset request names a chosen category, approve it without a human. Disabled and inert until configured: paste " +
      "the category's resource path (asset-categories/<id>, from Settings -> Asset tags -> Categories) into the condition's " +
      "value. Use it for the kit nobody argues about - a mouse, a headset - and leave laptops to a person.",
    trigger: "assetRequest.requested",
    enabled: false,
    condition: { field: "categoryId", op: "eq", value: "" },
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/{{subject}}:approve", body: { note: "Auto-approved: standard kit for this category." } },
    ],
  },
  {
    name: "New hire: file their standard kit request",
    description:
      "When an employee is created, file an asset request for their standard kit so it goes through the normal decide-and-hand-over " +
      "flow (and the chase rules above apply to it). Disabled until configured: paste the category's resource path " +
      "(asset-categories/<id>) into the body. Prefer this over creating an asset out of thin air - it hands over something that " +
      "really exists, tagged, from stock.",
    trigger: "employee.created",
    enabled: false,
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/asset-requests", body: { employee: "{{subject}}", category: "asset-categories/PASTE_CATEGORY_ID", justification: "Standard kit for a new hire.", needed_by: "{{startDate}}" } },
    ],
  },

  // -------------------------------------------------------------------------------------------------------
  // Scheduled (time-driven) rules. A daily scanner fires these when the recurrence matches - no inbound event.
  // `once` rules broadcast to an audience; `perEmployee` rules fan out per active employee with derived metrics
  // (pendingApprovals / daysSinceLastLeave / leaveBalanceDays / goalsDueSoon / goalsOverdue) in scope, so the condition can be genuinely
  // smart. Enabled by default - they're gentle, opt-out nudges that make the app feel proactive.
  // -------------------------------------------------------------------------------------------------------

  // Monday morning: remind every manager sitting on pending approvals to clear them.
  {
    name: "Monday: nudge managers with pending approvals",
    description: "Every Monday, remind each manager who has requests waiting on their decision to clear their Approvals inbox. Skips managers with an empty queue.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "pendingApprovals", op: "gte", value: 1 },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "You have approvals waiting", body: "There are {{pendingApprovals}} request(s) awaiting your decision. Clear them from your Approvals inbox.", link: "approvals" }],
  },

  // Same overdue-approvals nudge, but by EMAIL - reaches managers who don't live in the app. Disabled by
  // default (turn on once a transactional email provider is configured via the EMAIL_* env). Showcases the
  // `email` action: recipient resolution + {{...}} templating into the subject and HTML body.
  {
    name: "Monday: email managers with pending approvals",
    description: "Every Monday, email each manager who has requests waiting on their decision. Off by default - enable once email is configured.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    enabled: false,
    condition: { field: "pendingApprovals", op: "gte", value: 1 },
    actions: [{ kind: "email", to: { of: "subject" }, subject: "You have {{pendingApprovals}} approval(s) waiting", html: "<p>You have <strong>{{pendingApprovals}}</strong> request(s) awaiting your decision. Please clear them from your Approvals inbox.</p>" }],
  },

  // Wellbeing: quarterly nudge for anyone who hasn't taken leave in a long time (burnout guard).
  {
    name: "Quarterly: nudge people overdue for a break",
    description: "On the 1st of each quarter-ish month, gently remind anyone who hasn't taken leave in over ~6 months (and has balance to spare) to plan some time off.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "monthly", day: 1, scope: "perEmployee" },
    enabled: false,
    condition: { all: [{ field: "daysSinceLastLeave", op: "gte", value: 180 }, { field: "leaveBalanceDays", op: "gte", value: 5 }] },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Due for a break?", body: "You haven't taken leave in a while and have {{leaveBalanceDays}} days in balance. Consider planning some time off." }],
  },

  // Performance: goals shouldn't slip silently. Weekly owner nudge for goals inside the 7-day due window.
  {
    name: "Monday: nudge owners of goals due soon",
    description: "Every Monday, remind each employee who has open goals due within the next 7 days to push them over the line (or move the date).",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "goalsDueSoon", op: "gte", value: 1 },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Goals due this week", body: "You have {{goalsDueSoon}} goal(s) due within a week. Update progress or adjust the due date.", link: "goals" }],
  },

  // Performance: overdue goals ping the owner AND surface to their manager - slippage becomes a conversation.
  {
    name: "Monday: chase overdue goals",
    description: "Every Monday, remind each employee with overdue goals to update or reschedule them, and let their manager know so it can come up in a 1:1.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "goalsOverdue", op: "gte", value: 1 },
    actions: [
      { kind: "notify", recipient: { of: "subject" }, title: "Overdue goals", body: "You have {{goalsOverdue}} overdue goal(s). Update progress, push the due date, or close them out.", link: "goals" },
      { kind: "notifyManager", noun: "report has overdue goals" },
    ],
  },

  // Performance: a completed goal currently produces one notification to one manager and then disappears into
  // a status change. These two let the org SEE delivery - disabled by default, because a goal title is the
  // person's own words and publishing it org-wide is a decision somebody has to make on purpose.
  {
    name: "Goal completed: post it to the board",
    description: "When someone completes a goal, post it to the company board so the org sees what is being delivered. Disabled by default - a goal title is the owner's own words, so publishing it is an opt-in.",
    trigger: "goal.completed",
    enabled: false,
    actions: [{ kind: "apiCall", method: "POST", path: "/v1/announcements", body: { kind: "post", title: "A goal just landed", body: "A colleague completed one of their goals. Nice work!" } }],
  },
  {
    name: "Goal completed: nudge the manager to say well done",
    description: "When someone completes a goal, prompt their manager to send them kudos while it is still fresh.",
    trigger: "goal.completed",
    actions: [{ kind: "notifyManager", noun: "report just completed a goal - worth a kudos?" }],
  },

  // Performance: the two signals that arrive BEFORE a date is missed. A goal behind its own pace has weeks of
  // warning in it; a goal nobody has mentioned in three weeks usually has more. Both chase the owner rather
  // than the manager - the point is to get the goal moved or re-dated while there is still time to do either.
  {
    name: "Monday: flag goals that have fallen behind pace",
    description: "Every Monday, tell each employee whose open goals are a quarter of the way behind where they should be by now (or which they have flagged themselves) to move them, re-scope them, or say what is blocking.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "goalsAtRisk", op: "gte", value: 1 },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Goals behind pace", body: "{{goalsAtRisk}} of your goals are behind where they should be by now. Update progress, re-scope, or flag what is blocking.", link: "goals" }],
  },
  {
    name: "Monday: chase goals that have gone quiet",
    description: "Every Monday, remind each employee about open goals nobody has touched in three weeks. Silence is the earliest sign a goal has been abandoned - long before its due date says so.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "goalsStale", op: "gte", value: 1 },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Goals with no update", body: "{{goalsStale}} of your goals have had no update in three weeks. A quick progress note keeps them honest.", link: "goals" }],
  },

  // Performance: board work, chased the same way as goals. A card's due date was stored, drawn on the card,
  // and read by nothing that told anybody - so a task went past its date in silence unless somebody happened
  // to be looking at the board. Aimed at the ASSIGNEE, whose queue it is sitting in.
  {
    name: "Monday: nudge assignees of tasks due soon",
    description: "Every Monday, tell each person what board tasks assigned to them fall due within the next 7 days. Delivered cards never count.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "tasksDueSoon", op: "gte", value: 1 },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Tasks due this week", body: "You have {{tasksDueSoon}} task(s) due within a week. Move them along, or change the date.", link: "boards" }],
  },
  {
    name: "Monday: chase overdue tasks",
    description: "Every Monday, remind each person of the board tasks assigned to them that are past their due date, and let their manager know so it can come up in a 1:1.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "tasksOverdue", op: "gte", value: 1 },
    actions: [
      { kind: "notify", recipient: { of: "subject" }, title: "Overdue tasks", body: "You have {{tasksOverdue}} task(s) past their due date. Deliver them, re-date them, or say what is blocking.", link: "boards" },
      { kind: "notifyManager", noun: "report has overdue tasks" },
    ],
  },
  {
    // The manager rather than the assignee on purpose: the person holding a blocked card is, by definition,
    // the one who cannot move it.
    name: "Monday: surface blocked tasks to the manager",
    description: "Every Monday, tell each manager how many of their reports' tasks are sitting blocked. A block is somebody else's move, so chasing the person who is stuck achieves nothing.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "tasksBlocked", op: "gte", value: 1 },
    actions: [{ kind: "notifyManager", noun: "report has blocked tasks" }],
  },

  // Performance: review season. A cycle's self / manager / goal-setting deadlines were stored and rendered and
  // read by nothing that chases anybody, so the whole thing ran on whoever remembered to nag. Each of these
  // fires only inside an ACTIVE cycle, and stops the moment the person does the thing.
  {
    name: "Monday: chase self-assessments",
    description: "Every Monday during an active review cycle, remind each person whose review is still waiting on their self-assessment to write it.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "selfReviewsDue", op: "gte", value: 1 },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Your self-assessment is waiting", body: "You have {{selfReviewsDue}} review(s) waiting on your self-assessment. Your manager cannot write theirs until it is in.", link: "reviews", action: "respond" }],
  },
  {
    name: "Monday: chase managers for review write-ups",
    description: "Every Monday during an active review cycle, tell each manager how many of their reports' reviews are waiting on their write-up.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "teamReviewsDue", op: "gte", value: 1 },
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "Reviews waiting on you", body: "{{teamReviewsDue}} of your reports' reviews are waiting for your write-up.", link: "reviews", action: "respond" }],
  },
  {
    name: "Monday: chase goal-setting for the cycle",
    description: "Every Monday, remind anyone who has set no goals against an active cycle that asked for them by a date - and tell their manager how many of their reports are in that position. Goal-setting season was the half of a review cycle with a deadline nobody chased.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "perEmployee" },
    condition: { field: "goalSettingMissing", op: "gte", value: 1 },
    actions: [
      { kind: "notify", recipient: { of: "subject" }, title: "No goals set for this cycle", body: "The current review cycle asks for goals and you have not set any yet. A review with no goals scores nothing.", link: "goals", action: "respond" },
      { kind: "notifyManager", noun: "report has set no goals for the cycle" },
    ],
  },

  // Month start: open the payroll-prep checklist for the finance team (broadcast, no per-employee fan-out).
  {
    name: "Month start: payroll prep reminder",
    description: "On the 1st of every month, remind the team to review inputs and build the month's payroll run. Disabled by default (turn on and point the audience at your finance team).",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "monthly", day: 1, scope: "once" },
    enabled: false,
    actions: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "Payroll prep for this month", body: "Time to review income inputs (reimbursements, overtime, loans) and build this month's payroll run." }],
  },

  // Assets, weekly: the queue of promises. An approved request with nothing handed over is invisible unless
  // somebody asks the inventory, so this asks it and mails the answer to whoever owns stock. Off by default -
  // it needs an email provider AND the distro address pasted in (`to.address`).
  {
    name: "Weekly: email IT the asset requests still awaiting hand-over",
    description:
      "Every Monday, count the approved asset requests nobody has handed over yet and email the total to the IT distro. Off by " +
      "default: set the address on the email action (and configure an email provider). Complements the per-request chase - this " +
      "is the standing backlog, not one late item.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 1, scope: "once" },
    enabled: false,
    actions: [
      { kind: "apiCall", method: "GET", path: "/v1/asset-requests?state=APPROVED", captureAs: "awaiting" },
      { kind: "email", to: { of: "address", address: "it@example.com" }, subject: "{{results.awaiting.results.length}} asset request(s) awaiting hand-over", html: "<p><strong>{{results.awaiting.results.length}}</strong> approved asset request(s) are still waiting for kit to be handed over. Each one is on somebody's profile, under Assets - handing an asset over closes the request and starts its custody scan.</p>" },
    ],
  },

  // Assets, monthly: a stocktake is the only thing that turns the inventory back into a fact. Broadcast rather
  // than per-person, and off by default because how often an org counts its kit is a policy, not a default.
  {
    name: "Month start: stocktake reminder",
    description:
      "On the 1st of every month, remind the team to walk the office with the Stocktake scanner so every asset gets sighted. Off " +
      "by default - point the audience at whoever owns inventory and pick a cadence that matches your policy.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "monthly", day: 1, scope: "once" },
    enabled: false,
    actions: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "Stocktake this week", body: "Open Assets -> Stocktake and scan what you can see. Anything nobody sights keeps showing up as unverified until somebody does.", link: "assets" }],
  },

  // -------------------------------------------------------------------------------------------------------
  // Feature coverage across Kanban, Performance, Leave and Time - each showcasing a different component
  // (wait / apiCall / notifyAudience / webhook / scheduled-once) so the palette is visible end-to-end.
  // -------------------------------------------------------------------------------------------------------

  // Kanban: a blocked card is silent risk. Ping the owner's manager now, and again if it's still blocked in 2
  // days. `wait` defers the follow-up onto the jobs queue - a durable nudge, not a fire-and-forget.
  {
    name: "Kanban: chase blocked cards",
    description: "When a card is marked blocked, alert the owner's manager. If it's still blocking work two days later, remind them again.",
    trigger: "card.blocked",
    actions: [
      { kind: "notifyManager", noun: "blocked card - clear the blocker" },
      { kind: "wait", delayDays: 2, then: [{ kind: "notifyManager", noun: "card STILL blocked after 2 days" }] },
    ],
  },

  // Performance: the code already tells a manager when their report finishes a goal - this closes the loop for
  // the achiever themselves, so completing a goal feels acknowledged.
  {
    name: "Goal completed: celebrate the achiever",
    description: "When someone marks a goal complete, send them a congratulations. (Their manager is notified separately.)",
    trigger: "goal.completed",
    actions: [{ kind: "notify", recipient: { of: "subject" }, title: "🎯 Goal complete!", body: "Nice work finishing a goal. It's logged against your performance record.", link: "goals" }],
  },

  // Performance: rally the board when a sprint kicks off (sprints aren't employee-owned, so this broadcasts).
  {
    name: "Sprint started: rally the board",
    description: "Announce a new sprint to everyone so the team knows work has started.",
    trigger: "sprint.started",
    enabled: false,
    actions: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "🏁 Sprint started", body: "{{name}} is underway. Pull your committed cards and get going.", link: "boards" }],
  },

  // Performance: when a sprint completes, auto-create a retrospective calendar event via apiCall (chaining a
  // record off the event), then tell the team. `{{today}}` and `{{name}}` template from the run context.
  {
    name: "Sprint completed: schedule a retro",
    description: "On sprint completion, drop an all-day retrospective onto the calendar and let the team know to reflect.",
    trigger: "sprint.completed",
    enabled: false,
    actions: [
      { kind: "apiCall", method: "POST", path: "/v1/events", body: { title: "Retro: {{name}}", start_time: "{{today}}", end_time: "{{today}}", all_day: true, count_as_work: true } },
      { kind: "notifyAudience", audience: { kind: "everyone" }, title: "🔁 Sprint wrapped", body: "{{name}} is done - a retrospective has been added to the calendar. Bring your learnings.", link: "events" },
    ],
  },

  // Leave -> external system: push an approved leave to an outside calendar/HRIS over an allowlisted webhook.
  // Off by default (needs the egress URL + webhook port configured) - shown so the integration path is obvious.
  {
    name: "Leave approved: sync to external calendar",
    description: "POST approved leave to an external calendar or HRIS webhook so out-of-office shows up everywhere. Configure the URL and enable to use.",
    trigger: "leave.approved",
    enabled: false,
    actions: [{ kind: "webhook", url: "https://example.com/hooks/leave-approved", includeFields: ["employeeId", "subject"] }],
  },

  // Time: a gentle Friday broadcast so timesheets don't pile up into Monday. Scheduled `once` = a single
  // employee-less firing, perfect for a whole-company reminder.
  {
    name: "Friday: submit your timesheets",
    description: "Every Friday, remind everyone to log their hours before the week closes.",
    trigger: SCHEDULE_TRIGGER,
    schedule: { freq: "weekly", day: 5, scope: "once" },
    enabled: false,
    actions: [{ kind: "notifyAudience", audience: { kind: "everyone" }, title: "🕒 Log your time", body: "It's Friday - please submit your timesheets for the week so approvals aren't held up." }],
  },
];

export function automations(ctx: Ctx): string {
  return rows(
    "INSERT INTO automations (uuid,code,name,description,trigger_type,condition_json,actions_json,schedule_json,disabled,locked,created_at,updated_at) VALUES",
    AUTOMATIONS.map((a, i) =>
      ` (${q(ctx.nid())},${q(code2(i + 1))},${q(a.name)},${q(a.description)},${q(a.trigger)},` +
        `${a.condition ? j(a.condition) : "NULL"},${j(a.actions)},${a.schedule ? j(a.schedule) : "NULL"},${b(a.enabled === false)},0,${T0},${T0})`,
    ),
  );
}
