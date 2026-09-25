import {
  Bell, CalendarDays, Receipt, Landmark, Clock, Laptop, CalendarCheck, Coins, Timer, Heart, Lightbulb,
  Megaphone, FileSignature, Wallet, Percent, DoorOpen, LifeBuoy, ClipboardCheck, Target, MessagesSquare,
  ShieldCheck, UserPlus, Gift, ShieldPlus, Columns3, CalendarClock, Banknote, Package, CalendarRange,
  Briefcase, TrendingUp, KeyRound, AlarmClock, type LucideIcon,
} from "lucide-react";

// Per-category presentation for a notification: a glyph + a theme-aware tint. The category is the first
// segment of the notification `type` ("leave.approved" -> "leave"). This is the single source of the icon +
// colour used by the bell, the full page and the per-user preference toggles, so a new category added on the
// server just needs one line here to look right. Unknown categories fall back to a neutral bell.
export type CategoryMeta = { label: string; icon: LucideIcon; cls: string };

// `cls` styles the round icon chip: a soft tinted background + a saturated glyph, tuned for both themes.
const M = (label: string, icon: LucideIcon, hue: string): CategoryMeta => ({
  label,
  icon,
  cls: `bg-${hue}-500/15 text-${hue}-600 dark:text-${hue}-400`,
});

export const CATEGORY_META: Record<string, CategoryMeta> = {
  leave: M("Leave", CalendarDays, "sky"),
  reimbursement: M("Reimbursements", Receipt, "emerald"),
  loan: M("Loans & advances", Landmark, "amber"),
  overtime: M("Overtime", Clock, "indigo"),
  remote: M("Remote work", Laptop, "teal"),
  regularization: M("Attendance", CalendarCheck, "cyan"),
  lateEarly: M("Late & early", AlarmClock, "amber"),
  encashment: M("Encashment", Coins, "lime"),
  timesheet: M("Timesheets", Timer, "violet"),
  kudos: M("Kudos", Heart, "pink"),
  suggestion: M("Suggestions", Lightbulb, "yellow"),
  announcement: M("Announcements", Megaphone, "blue"),
  document: M("Documents", FileSignature, "orange"),
  payslip: M("Payslips", Wallet, "green"),
  tax: M("Tax", Percent, "rose"),
  transition: M("Onboarding", DoorOpen, "purple"),
  ticket: M("Support", LifeBuoy, "red"),
  review: M("Reviews", ClipboardCheck, "fuchsia"),
  goal: M("Goals", Target, "orange"),
  checkin: M("Check-ins", MessagesSquare, "blue"),
  compliance: M("Compliance", ShieldCheck, "amber"),
  referral: M("Referrals", UserPlus, "teal"),
  bonus: M("Bonuses", Gift, "emerald"),
  benefit: M("Benefits", ShieldPlus, "teal"),
  board: M("Boards", Columns3, "violet"),
  notice: M("Notice periods", CalendarClock, "orange"),
  settlement: M("Settlement", Banknote, "green"),
  asset: M("Assets", Package, "slate"),
  shift: M("Shifts", CalendarRange, "cyan"),
  recruiting: M("Recruiting", Briefcase, "indigo"),
  compensation: M("Compensation", TrendingUp, "green"),
  access: M("Access & permissions", KeyRound, "amber"),
  system: M("System", Bell, "slate"),
};

// Every Tailwind class the tints above resolve to, listed once so the JIT compiler keeps them (they are built
// via template strings, which the scanner can't see). Do not remove - dropping a hue here drops its colour.
// prettier-ignore
const _KEEP =
  "bg-sky-500/15 text-sky-600 dark:text-sky-400 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 " +
  "bg-amber-500/15 text-amber-600 dark:text-amber-400 bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 " +
  "bg-teal-500/15 text-teal-600 dark:text-teal-400 bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 " +
  "bg-lime-500/15 text-lime-600 dark:text-lime-400 bg-violet-500/15 text-violet-600 dark:text-violet-400 " +
  "bg-pink-500/15 text-pink-600 dark:text-pink-400 bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 " +
  "bg-blue-500/15 text-blue-600 dark:text-blue-400 bg-orange-500/15 text-orange-600 dark:text-orange-400 " +
  "bg-green-500/15 text-green-600 dark:text-green-400 bg-rose-500/15 text-rose-600 dark:text-rose-400 " +
  "bg-purple-500/15 text-purple-600 dark:text-purple-400 bg-red-500/15 text-red-600 dark:text-red-400 " +
  "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 bg-slate-500/15 text-slate-600 dark:text-slate-400";
void _KEEP;

// Category key of a notification type (segment before the first dot).
export const categoryOf = (type: string): string => (type || "").split(".")[0] || "system";

// Resolved presentation for a notification type, always non-null (neutral bell fallback).
export const metaForType = (type: string): CategoryMeta => CATEGORY_META[categoryOf(type)] ?? { label: "Notification", icon: Bell, cls: "bg-muted text-muted-foreground" };
