import { z } from "zod";

// The body of every request `:reject`. A rejection without a reason tells the requester only that they lost,
// not what to change before they file again, so the reason is required: it is stored on the row as its
// decision note and travels in the requester's notification. One schema so every reject verb asks for the same
// field, with the same limits and the same message.
export const rejectBody = z.object({
  reason: z
    .string({ required_error: "say why the request is rejected" })
    .trim()
    .min(1, "say why the request is rejected")
    .max(1000, "must be 1000 characters or fewer"),
}).strict();

export type RejectBody = z.infer<typeof rejectBody>;
