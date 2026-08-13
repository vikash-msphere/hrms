import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { benefitEnrollmentSpec, listBenefitEnrollments, type BenefitEnrollmentInput } from "../services/benefitEnrollments";
import { toBenefitEnrollmentResource } from "../http/serialize";

const writeSchema = z.object({
  employee: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  status: z.enum(["enrolled", "waived"]).optional(),
  effective_date: z.string().nullable().optional(),
  dependents: z.array(z.string()).optional(),
}).strict();

// Who is enrolled in (or has waived) which benefit plan. Plain CRUD plus soft delete/restore - all of it the
// shared lane; the spec in the service owns the field mapping, the owner-scoped code and the notification.
export const benefitEnrollments = collectionRoutes<BenefitEnrollmentInput>({
  ...benefitEnrollmentSpec,
  param: "enrollment_id",
  writeSchema,
  serialize: toBenefitEnrollmentResource,
  list: (c, page) => {
    // Row visibility was decided in middleware (scopeFor over the grant); `?employee` narrows it further.
    return listBenefitEnrollments(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, c.req.query("employee"), page.showDeleted);
  },
});
