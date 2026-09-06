import {
  Activity, ArrowRightLeft, ArrowUpDown, Award, BadgeCheck, Ban, Banknote, Check, CheckCheck,
  CircleCheckBig, CircleSlash, CircleX, ClipboardCheck, Copy, Eye, LockOpen, MessageSquare,
  MessageSquarePlus, MoveRight, Pencil, Play, Plus, RotateCcw, Rocket, Send, Settings2,
  ShieldAlert, Signature, TimerOff, Trash2, TrendingUp, Undo2, UserPlus, UserRoundCheck, type LucideIcon,
} from "lucide-react";

// Human-readable label for an audit action code (e.g. "card.move" -> "moved"). Web mirror of the action
// vocabulary; the server stores raw codes. Falls back to a humanized form of the verb for unmapped codes.
const VERB: Record<string, string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  restore: "restored",
  purge: "permanently deleted",
  move: "moved",
  block: "blocked",
  unblock: "unblocked",
  assign: "assigned",
  prioritize: "reprioritized",
  comment: "commented on",
  approve: "approved",
  reject: "rejected",
  cancel: "cancelled",
  submit: "submitted",
  launch: "launched",
  enroll: "enrolled reviewees on",
  close: "closed",
  reopen: "reopened",
  configure: "configured",
  updateProgress: "updated progress on",
  activate: "started",
  complete: "completed",
  acknowledge: "acknowledged",
  nominate: "requested feedback on",
  skipStage: "advanced",
  start: "started",
  resolve: "resolved",
  disburse: "disbursed",
  award: "awarded",
  record: "recorded",
  sensitive: "viewed", // `<col>.read.sensitive` — an allowed read of a sensitive record
  denied: "was denied", // `access.denied` — a blocked attempt
  // Permission-change verbs (`access-rule.*`). Four-eyes puts a change through request → approve/reject, a
  // rule with an expiry lapses on its own, and a copy writes one summary entry over the rules it created - so
  // the trail has four verbs no other collection uses.
  request: "requested",
  removalRequest: "requested removal of",
  expire: "lapsed",
  clone: "copied permissions onto",
};

export function actionLabel(action: string): string {
  const verb = action.includes(".") ? action.slice(action.lastIndexOf(".") + 1) : action;
  return VERB[verb] ?? verb.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

// Coarse category for color-coding + filtering. Groups the fine-grained verbs into a handful of tones.
export type ActionTone = "create" | "update" | "move" | "assign" | "remove" | "positive" | "comment" | "read" | "denied" | "other";
const TONE: Record<string, ActionTone> = {
  create: "create", add: "create", award: "create", record: "create",
  update: "update", configure: "update", prioritize: "update", updateProgress: "update", disburse: "update",
  move: "move",
  assign: "assign",
  delete: "remove", purge: "remove", cancel: "remove", reject: "remove", block: "remove",
  restore: "positive", unblock: "positive", approve: "positive", complete: "positive", activate: "positive", resolve: "positive", acknowledge: "positive", launch: "positive", enroll: "positive", submit: "positive",
  comment: "comment", nominate: "comment", start: "positive", close: "remove", reopen: "positive", skipStage: "update",
  sensitive: "read", denied: "denied", // access-audit rows: sensitive read / blocked attempt
  // A pending request is not yet a change (update); a removal request and an expiry both TAKE access away.
  request: "update", removalRequest: "remove", expire: "remove", clone: "create",
};
export function actionTone(action: string): ActionTone {
  const verb = action.includes(".") ? action.slice(action.lastIndexOf(".") + 1) : action;
  return TONE[verb] ?? "other";
}
export const TONE_LABEL: Record<ActionTone, string> = {
  create: "Created", update: "Updated", move: "Moved", assign: "Assigned", remove: "Removed", positive: "Completed", comment: "Comments", read: "Viewed", denied: "Denied", other: "Other",
};

// Glyph per action, so a long feed is scannable without reading every verb. One icon per fine-grained verb where
// the verb is distinctive (disbursed money, awarded, blocked); anything unmapped falls back to its tone's icon,
// so a new server-side verb still renders something sensible.
export const TONE_ICON: Record<ActionTone, LucideIcon> = {
  create: Plus, update: Pencil, move: ArrowRightLeft, assign: UserPlus, remove: Trash2,
  positive: Check, comment: MessageSquare, read: Eye, denied: ShieldAlert, other: Activity,
};
const ACTION_ICON: Record<string, LucideIcon> = {
  create: Plus,
  update: Pencil,
  delete: Trash2,
  restore: Undo2,
  purge: Trash2,
  move: ArrowRightLeft,
  block: Ban,
  unblock: LockOpen,
  assign: UserPlus,
  prioritize: ArrowUpDown,
  comment: MessageSquare,
  approve: CircleCheckBig,
  reject: CircleX,
  cancel: Ban,
  submit: Send,
  launch: Rocket,
  enroll: UserRoundCheck,
  close: CircleSlash,
  reopen: RotateCcw,
  configure: Settings2,
  updateProgress: TrendingUp,
  activate: Play,
  complete: CheckCheck,
  acknowledge: BadgeCheck,
  nominate: MessageSquarePlus,
  skipStage: MoveRight,
  start: Play,
  resolve: CircleCheckBig,
  disburse: Banknote,
  award: Award,
  record: ClipboardCheck,
  sign: Signature,
  upvote: TrendingUp,
  respond: MessageSquare,
  route: MoveRight,
  sensitive: Eye,
  denied: ShieldAlert,
  request: Send,
  removalRequest: Trash2,
  expire: TimerOff,
  clone: Copy,
};
export function actionIcon(action: string): LucideIcon {
  const verb = action.includes(".") ? action.slice(action.lastIndexOf(".") + 1) : action;
  return ACTION_ICON[verb] ?? TONE_ICON[actionTone(action)];
}

// Compact relative time ("3h ago", "2d ago") for feed rows; falls back to a date for older entries.
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
