# Session recording: what to tell employees, and what to decide first

The app records what is on screen in two situations and sends it to a third-party error tracker (Sentry).
Recording people while they work inside an HR system is a privacy question before it is a debugging one, so
it needs a written notice, a stated retention period, and a decision about who may watch a replay. This file
holds the facts, a notice text ready to publish, and the three decisions that are still open.

Nothing here is a legal opinion. If the org is subject to a specific regime (a works council agreement, a
customer DPA, GDPR for an EU-based employee), have this reviewed before publishing.

## What actually happens

There are **two** recording paths, and they are not the same thing. Conflating them makes the notice either
alarming or untrue.

**1. Error-triggered replay - automatic, not announced by the app.** `web/src/instrument.ts` configures the
SDK with `replaysSessionSampleRate: 0` and `replaysOnErrorSampleRate: 1`. Nothing is uploaded while the app
is behaving: the SDK holds recent activity in the browser's memory and discards it when the tab closes. When
an error is thrown, that buffer is flushed, so what leaves the browser is the run-up to a crash and nothing
else. Continuous sampling of ordinary sessions is deliberately switched off. This is the path that needs the
notice, because the employee does not initiate it and sees no prompt.

**2. Manual screen recording - explicit and user-started.** "Report a problem", and "record another one" on
an existing ticket, start a recording the person chose to start (`web/src/lib/screenRecording.ts`). It runs
for a fixed 120-second window with a countdown chip visible in the top bar the whole time, then attaches to
the report or the ticket. This one is already consent-by-action; the notice should still describe it so
people know what the button does.

**What a replay contains.** The posture is unmask-by-default: text, inputs and images are recorded so a
replay shows the page as the person saw it. What is hidden instead is targeted, and it is enforced by
`test/replayMaskCoverage.test.ts`:

- three whole routes are masked - payslips, payroll runs, documents;
- the seven employee-profile panels and their editing dialogs carry `sentry-mask` themselves;
- input fields matching account / PAN / Aadhaar / salary name patterns are masked wherever they appear.

So a replay can legitimately show: which pages someone visited, what they clicked and typed outside those
masked areas, ordinary business data such as ticket text, dates, statuses, department and category names,
and the error they hit.

**What never leaves.** The browser posts telemetry to the app's own `/diag` relay, and the Worker forwards it
server to server (`src/routes/diag.ts`). The relayed request presents the Worker's address, so the tracker
records that rather than the employee's IP, and no `X-Forwarded-For` is added. The relay forwards to one
pinned project and refuses any other destination.

## Decide these three before launch

1. **Retention on the tracker.** Sentry's own retention (90 days on most plans) is the default, and it is
   the number the notice has to state. Set it deliberately in the Sentry project settings; a replay of an HR
   screen is not the same asset as a stack trace, and the two do not need the same lifetime.
2. **Who may watch a replay.** Sentry project membership is the access control. List the people, keep it to
   the ones who actually triage bugs, and say in the notice that it is a named, small group rather than
   "engineering".
3. **Whether error-triggered replay stays on.** It is on, at 100% of errors. Turning it off costs real
   debugging ability - a replay is usually the difference between a reproducible bug and a "cannot
   reproduce". Turning it down (`replaysOnErrorSampleRate` below 1) is a middle option. Making it opt-in per
   employee is not supported by the SDK config today and would need building. Decide, then say which.

## Notice text to publish

Publish this on the intranet or as an org document, and link it from wherever staff are told how to report a
problem. Replace the bracketed values with what was decided above.

> **Recording of screens for troubleshooting**
>
> To find and fix faults in the HR system, the application can record what is displayed on your screen while
> you use it. This happens in two situations, and in no others.
>
> **When the application hits an error.** The app keeps the last few moments of on-screen activity in your
> browser's memory. If nothing goes wrong, that is discarded when you close the tab and never leaves your
> computer. If the application errors, those last few moments are sent to our error-tracking service so the
> fault can be diagnosed. We do not record ordinary sessions in which nothing goes wrong.
>
> **When you choose to record.** "Report a problem", and "record another one" on an existing ticket, record
> your screen for two minutes so you can demonstrate a fault. A countdown is shown while it is running, and
> the recording is attached to the report you send. You start this yourself, and you can leave the page to
> end it.
>
> **What a recording can show.** The pages you visited, what you clicked, and the text on those pages,
> including what you typed. Payslips, payroll runs, the documents area and your personal profile details are
> automatically hidden in every recording, as are bank account, PAN, Aadhaar and salary fields anywhere in
> the app.
>
> **What is not collected.** Your IP address is not sent to the error-tracking service - reports reach it
> through our own server. Recordings are not used to monitor productivity, attendance or performance, and
> are not shared with your manager.
>
> **Who can see recordings, and for how long.** Recordings are held by [Sentry, our error-tracking provider]
> for [90 days] and are then deleted. They can be viewed only by [the named people who maintain the HR
> system].
>
> **Your rights.** To ask what has been recorded about you, or to ask for a recording to be deleted, contact
> [hr@msphere.io].

## Related

- `docs/deploy-security.md` §5, "What session replay can and cannot see" - the engineering detail behind the
  masking rules, and why the relay exists.
- `web/src/instrument.ts` - the masking policy itself, with the reasoning per rule.
- `test/replayMaskCoverage.test.ts` - the gate that keeps the masked set from silently shrinking.
