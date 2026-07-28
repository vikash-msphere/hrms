// A "request leave for these dates" draft: produced by the dashboard team-timeline's day selection and fed to
// the shared RequestLeaveDialog as its initial values. `startSession`/`endSession` (1 = first half / morning,
// 2 = second half / afternoon) carry half-day edges; absent means a full day (1 -> 2).
export type LeaveDraft = { from: string; to: string; startSession?: number; endSession?: number };
