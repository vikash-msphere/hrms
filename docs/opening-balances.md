# Opening balances: going live with people who joined before HRMS

Everybody who joined before your org started using HRMS has history that happened somewhere else. Every part
of the app that works things out from "history since the start date" would otherwise read that history as
empty:

- attendance shows every day before go-live as an absence, and payroll docks it as loss of pay;
- the leave accrual credits every month since the start date in one go, with nothing taken off for leave used;
- leave already taken this year doesn't count against quotas or lifetime limits;
- the first HRMS payroll works out the year's TDS as if nothing had been paid or deducted since April, and the
  PT annual cap and the ESI rule read the same gap.

**Admin → Opening balances** is where each of these is put right. Every section previews first and writes
nothing until you apply. Each section shows only to somebody who holds its permission.

## What to get from the old system first

| For | What | As of |
|---|---|---|
| Leave balances | Each person's closing balance per leave type, **before** deducting any leave booked for dates from go-live, and days already encashed this leave year | The day before HRMS records start (go-live) |
| Leave already booked | Leave the old system approved for dates from go-live on: person, type, from, to, days | As approved |
| Leave history | Every leave taken this calendar year, plus any lifetime-limited type ever taken (maternity, for example): person, type, from, to, days | Up to the day before go-live |
| Unpaid days before go-live | Unpaid leave and unauthorised absences in the part of the first HRMS pay month before go-live (1-23 September for a 24 September go-live), as Loss of Pay | Up to the day before go-live |
| Pay and tax so far | Per person: gross pay, taxable pay, TDS and professional tax from 1 April to the last month the old system paid, and whether ESI was being deducted that month | The last month the old system ran payroll |

People are matched by **employee ID** or **work email** in the first column of every sheet. Leave types are
matched by the name HRMS shows for them.

## The order

1. **When HRMS records start** (`employees:setTrackedFrom`). Pick the go-live date; the page suggests the day
   the first employee record was created. Preview shows who gets which date:
   - everyone who joined before it gets it, or the day their own record was created if that was later;
   - people who joined on or after it are left alone - their records start on their start date;
   - anyone who already has a date keeps it, so running it again changes nothing.

   From then on, a working day before a person's date with no punches, mark or leave is shown as "Before
   HRMS", is not an absence, and is never docked as loss of pay. Unpaid leave on those days is still docked.
   The date is also on each employee's record (Employment details) and can be corrected there - until leave
   opening balances are applied for that person, after which it is fixed (the openings were measured against
   it; adjust the balance instead).

2. **Leave balances** (`leave-adjustments:importOpenings`). Download the sheet (one row per person, a column
   per paid leave type, and an "encashed this year" column for each type that can be encashed), fill in the
   old system's figures, paste or upload it, preview.

   If the old system took leave off the balance when it was APPROVED, its closing figure already excludes leave
   booked for dates from go-live. Add those days back into the figure you enter here, and bring the leave itself
   in at step 3 as booked leave: it has to be in HRMS (or its days read as absences), and it takes its days off
   there, once.

   For each balance the preview shows what HRMS has now, what HRMS credited for the accrual periods before the
   records-start date (taken off), the opening you entered (put on), and the result. Everything that happened
   in HRMS since go-live - accrual, leave filed, an encashment - stays where it is. Blank cells leave a balance
   as it is. Re-importing the sheet moves each balance only by the difference from the previous opening, so
   applying the same file twice changes nothing. Each person gets one notification that their balances were
   brought over.

   A balance that needs fixing later is adjusted from the approver balances table on the Leave page (Adjust,
   with a reason). Every opening and adjustment is kept as a ledger row and shows in the balance's history.

3. **Leave from before HRMS** (`leave-requests:importHistory`). One leave per line: person, leave type, from,
   to, and optionally days, a half day ("PM" for a start session, "AM" for an end session) and a reason. Dates
   are read day first (02/03/2026 is 2 March). A blank "Days" is counted the way a request filed now would be;
   give it when the old system counted differently (holidays before go-live may never have been entered in
   HRMS). Run it after step 2. Each line is one of two kinds, decided by the person's records-start date, and
   the preview says which:

   - **History** - leave that ended before the records start. It lands as approved leave marked "Before HRMS":
     quotas, lifetime limits and the probation cap count it; no balance moves (the opening balance already has
     it taken off). A wrong one is removed from the leave History tab by HR - never by the person it belongs
     to - and removing it refunds nothing.
   - **Booked** - leave the old system approved for dates from the records start on. It lands as ordinary
     approved leave and takes its days off the balance here, once (refused if a paid type's balance cannot
     hold it). From then on it is leave like any other: the person can cancel it before it starts and gets the
     days back.

   A leave that runs across the records-start day is refused: split it there. Nobody is notified either way,
   and bringing in a leave that is already here changes nothing.

   **Unpaid days in the first HRMS pay month.** HRMS pays the whole of the go-live month, but its days before
   go-live happened in the old system, and a day before the records start with nothing on it is never docked.
   Bring the old system's unpaid leave AND its unauthorised absences on those days in here as Loss of Pay
   leave, so the first payroll docks them. Paid leave on those days needs nothing - it excuses the day either
   way, and the opening balance already has it taken off.

   Optional holidays already taken this year before HRMS are not counted toward the yearly number people may
   pick; tell anyone who has used theirs.

4. **Pay and tax so far this year** (`payroll-openings:importOpenings`). Choose the financial year, download
   the sheet (Paid through, Gross, Taxable gross, TDS, PT, ESI contributing), fill it in and preview. "Paid
   through" is the last month whose salary the figures include (write it as 2026-08 or Aug 2026); a blank
   taxable gross is taken as the gross.

   The figures and the months they cover are folded into the year wherever the app reads it: the payroll
   build's TDS (the year's tax less what was already deducted, spread over the months left), the PT annual cap,
   ESI (contributing in the last month keeps it deducted for the rest of that contribution period), the full
   and final settlement, the Tax page ("Includes ₹X paid before HRMS") and Form 16. The covered months are
   never priced or collected in again. An entry can't reach a month a finalized HRMS run already paid that
   person for. Re-importing replaces a person's figures for that year. A draft payroll run built before the
   figures went in shows as needing a rebuild.

   If the first HRMS payroll is due before this step is done, build it and leave it in draft; rebuild once the
   figures are in. A payroll run for a month an entry already covers is refused, naming the people: that month
   was paid by the old system.

   A salary revision backdated into the covered months (an appraisal effective 1 April, entered after
   go-live) owes arrears for them too, at the old rate: each covered month on or after the effective date
   counts in full, from the month the person joined. What the old system docked in those months is not known
   here, so a month it docked is counted as fully paid - correct that one-off by hand.

   **Last year's Form 16.** HRMS holds no pay for a year it did not run payroll in, so a Form 16 generated here
   for last year would show nothing. Either enter a full-year entry for that year (the year picker offers it)
   or issue last year's certificates from the old system.

5. **Also bring over**, each on its own page: loans still being repaid (record, approve, disburse, then record
   what was repaid before HRMS), salary (compensation effective from before the first HRMS payroll month), tax
   declarations and a previous employer's income for anyone who joined this year, documents, and assets in
   people's hands.

## Spot checks after applying

- An employee's attendance for the weeks before go-live shows "Before HRMS", not "Absent".
- A draft payroll run for the go-live month docks loss of pay before the records start only for the Loss of
  Pay days brought in at step 3.
- Leave booked for after go-live shows on the person's Requests tab, and their balance is the old system's
  figure less those days, taken off once.
- A leave balance matches the old system's closing figure plus what happened in HRMS since, and its history
  starts at "Brought over from before HRMS".
- An employee's Tax page shows the pay and TDS before HRMS inside the year's totals, and the monthly TDS looks
  like the old system's run rate rather than double it.

## Who can do it

The three imports and the records-start verb are super-admin by default. Each is granted to somebody else by
name through Access (the ACL screen): `employees.setTrackedFrom`, `leave-adjustments.importOpenings`,
`leave-requests.importHistory` and `payroll-openings.importOpenings`. `leave-adjustments` and
`payroll-openings` are private collections: nobody but a super admin reads them until the org grants them.

So that people can see why their own balance moved - the opening and any adjustment, in the balance history on
the Leave page - grant **read** on `leave-adjustments` at **self** scope to the Everyone role. Without it the
history still adds up, and says that the change sits inside the opening figure.
