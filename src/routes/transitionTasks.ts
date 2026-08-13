import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listTransitionTasks, getTransitionTask, completeTransitionTask, reopenTransitionTask, uploadTransitionTaskDocument } from "../services/transitionTasks";
import { toTransitionTaskResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

// Onboarding / offboarding checklist items. A task is created by its transition (appendTask) and closed by a
// verb, never by a POST or PATCH here, and never deleted - so the standard lane is list + get only.
export const transitionTasks = collectionRoutes({
  table: schema.transitionTasks,
  collection: "transition-tasks",
  auditName: "transition_task",
  notFound: "transition task not found",
  param: "task_id",
  serialize: toTransitionTaskResource,
  softDelete: false,
  list: (c) =>
    listTransitionTasks(
      c.get("deps"),
      c.get("scope"),
      clampPageSize(Number(c.req.query("max_page_size")) || undefined),
      c.req.query("page_token"),
      c.req.query("status"),
      c.req.query("transition"),
    ),
  verbs: {
    complete: {
      schema: z.object({ note: z.string().nullable().optional() }).strict(),
      run: (deps, user, id, body) => completeTransitionTask(deps, user, id, body.note),
    },
    reopen: { run: (deps, user, id) => reopenTransitionTask(deps, user, id) },
    // Supporting document for the task (an ID scan, a signed form): binary in, the updated task out.
    upload: {
      run: async (deps, user, id, _body, c) =>
        uploadTransitionTaskDocument(deps, user, id, await c.req.arrayBuffer(), {
          fileName: c.req.query("file_name"),
          contentType: c.req.query("content_type"),
        }),
    },
  },
});
