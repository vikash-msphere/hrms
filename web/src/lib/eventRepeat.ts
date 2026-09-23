// A repeating event's next dates, on the client.
//
// The event form shows the dates a repeat will produce before it is saved ("then 28 Aug · 4 Sep · 11 Sep"),
// because a repeat nobody can see is a repeat nobody trusts - and the cron that actually creates them runs
// hours later, so the form is the only chance to be wrong in front of somebody who can correct it.
//
// This file used to hold a SECOND COPY of the stepping rule, pinned to the server's by a drift test. The test
// did its job - the two agreed - but what they agreed on was the end-of-month rollover bug (31 Jan + 1 month
// = 3 March), which walked a monthly series permanently off its date, and it had to be found and fixed twice.
// The rule is pure, so it now lives once in `src/domain/calendar.ts` and both sides import it, the same way
// the leave forecast and the ticket categories are shared.
export { nextOccurrence, upcomingOccurrences, type EventRepeat } from "../../../src/domain/calendar";
