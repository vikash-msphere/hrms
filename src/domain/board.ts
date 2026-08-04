// Pure board-post rules shared by the service and the lifecycle verb, so a post that goes live announces itself
// the same way whichever route published it.

/** Bell title for a board post going live: the kind it actually is, not "announcement" for all of them. */
export function postedTitle(kind: string): string {
  return kind === "poll" ? "New poll" : kind === "post" ? "New post" : "New announcement";
}
