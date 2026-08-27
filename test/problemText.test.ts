import { describe, it, expect } from "vitest";
import { problemText } from "../web/src/lib/problemText";

// What a failed request SAYS. The rule the module states for itself is that a message ends with what to do
// next - so the one 403 that isn't a permission wall must not fall through to the generic "ask an admin",
// which would send the reader to somebody who cannot help them.

describe("problemText: the attendance clock's network fence", () => {
  const FENCE = { type: "/errors/clock-network-fence", status: 403 };

  it("keeps the server's reason and adds both ways out", () => {
    const t = problemText(403, { ...FENCE, detail: "attendance clock in/out is only allowed from an approved network, or during approved remote work" });
    expect(t).toContain("approved network");
    expect(t).toContain("request remote work");
    expect(t).toContain("attendance correction");
  });

  it("still says what to do when the server sent no detail", () => {
    const t = problemText(403, FENCE);
    expect(t).toContain("request remote work");
    expect(t).toContain("attendance correction");
  });

  it("does not fall through to the generic permission-denied advice", () => {
    expect(problemText(403, { ...FENCE, detail: "nope" })).not.toContain("Ask an admin");
  });

  it("leaves a real permission wall alone", () => {
    expect(problemText(403, { type: "/errors/permission-denied", status: 403 })).toContain("Ask an admin");
  });
});
