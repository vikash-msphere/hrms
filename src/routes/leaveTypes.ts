import { z } from "zod";
import { RESTRICTION_CODES } from "../domain/leaveRestrictions";
import { collectionRoutes } from "../http/collectionRoute";
import { leaveTypeSpec } from "../services/leaveTypes";
import { toLeaveTypeResource } from "../http/serialize";

// The restrictions blob is shaped per group, and every leaf is nullable - a null leaf is how a type says
// "exempt me from the org's rule" rather than "inherit it" (domain/leaveRestrictions.ts). `.strict()` on each
// group so a mistyped rule name is a 400 rather than a policy that saves cleanly and enforces nothing; the
// same check runs again in `validateRestrictions` for callers that don't come through this route.
const nnum = z.number().nullable().optional();
const nbool = z.boolean().nullable().optional();
const restrictionsSchema = z.object({
  eligibility: z.object({
    min_tenure_days: nnum,
    max_occurrences_lifetime: nnum,
    max_lifetime_days: nnum,
  }).strict().nullable().optional(),
  request: z.object({
    min_days: nnum,
    max_days: nnum,
    max_consecutive_days: nnum,
    half_day_allowed: nbool,
    blocked_weekdays: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
    must_be_single_block: nbool,
    reason_required: nbool,
    reason_min_length: nnum,
    document_required_over_days: nnum,
    backdate_days: nnum,
  }).strict().nullable().optional(),
  timing: z.object({
    advance_notice: z.object({
      tiers: z.array(z.object({ up_to_days: z.number(), notice_days: z.number() }).strict()).max(20).optional(),
      beyond_notice_days: nnum,
    }).strict().nullable().optional(),
    max_advance_days: nnum,
    // Bounded, like every list here: this blob is read as part of the cached leave-type snapshot on most
    // requests in the app, so an unbounded array is a tax on all of them (domain/leaveRestrictions.ts caps the
    // whole blob too, which is the backstop for callers that don't come through this route).
    blackouts: z.array(z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      label: z.string().max(120).optional(),
    }).strict()).max(200).nullable().optional(),
    blackout_days_of_month: z.array(z.number().int().min(1).max(31)).max(31).nullable().optional(),
    block_adjacent_to_holiday: nbool,
  }).strict().nullable().optional(),
  quota: z.object({
    max_days_per_month: nnum,
    max_days_per_year: nnum,
    max_requests_per_month: nnum,
    max_requests_per_year: nnum,
    min_gap_days: nnum,
    year_basis: z.enum(["calendar", "fiscal", "anniversary"]).nullable().optional(),
    fiscal_year_start_month: nnum,
  }).strict().nullable().optional(),
  combinations: z.object({
    no_combination_with: z.array(z.string().max(200)).max(100).nullable().optional(),
    gap_days: nnum,
  }).strict().nullable().optional(),
  counting: z.object({
    sandwich: z.object({
      weekends: z.enum(["exclude", "intervening", "flanking"]),
      holidays: z.enum(["exclude", "intervening", "flanking"]),
    }).strict().nullable().optional(),
  }).strict().nullable().optional(),
  exit: z.object({
    during_notice: z.enum(["allowed", "blocked", "capped"]).nullable().optional(),
    notice_cap_days: nnum,
  }).strict().nullable().optional(),
  accrual: z.object({
    joining_rule: z.object({
      cutoff_day: z.number().int().min(1).max(28),
      if_on_or_before: z.enum(["full", "prorate"]).optional(),
      if_after: z.enum(["none", "prorate"]).optional(),
    }).strict().nullable().optional(),
  }).strict().nullable().optional(),
  soft_rules: z.array(z.string().max(64)).max(RESTRICTION_CODES.length).nullable().optional(),
}).strict();

const writeSchema = z.object({
  display_name: z.string().min(1).optional(),
  accrual_days_per_year: z.number().min(0).optional(),
  accrual_frequency: z.enum(["monthly", "semi_monthly"]).optional(),
  accrual_cap_days: z.number().min(0).nullable().optional(),
  paid: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  available_during_probation: z.boolean().optional(),
  probation_accrual_days_per_year: z.number().min(0).optional(),
  probation_cap_days: z.number().min(0).nullable().optional(),
  encashable: z.boolean().optional(),
  encashment_cap_days_per_year: z.number().min(0).nullable().optional(),
  min_balance_retained_days: z.number().min(0).optional(),
  carry_forward: z.boolean().optional(),
  carry_forward_cap_days: z.number().min(0).nullable().optional(),
  restrictions: restrictionsSchema.nullable().optional(),
}).strict();

export const leaveTypes = collectionRoutes({
  ...leaveTypeSpec,
  param: "leave_type_id",
  writeSchema,
  serialize: toLeaveTypeResource,
  lifecycleName: "leave-type",
});
