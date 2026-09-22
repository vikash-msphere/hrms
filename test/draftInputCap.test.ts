/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { MAX_DRAFT_INPUT } from "../src/domain/aiDraft";

// The drafting cap is one number written twice, and the two copies have to agree.
//
// The server enforces it (`routes/aiDraft.ts` answers 400, `services/aiDraft.ts` throws) and the composer
// applies it (`web/src/lib/aiFeatures.ts`, read by `DraftButton`) so somebody is stopped at the box rather
// than after a round trip. A client copy that drifts HIGHER is the failure that was there before: the button
// sends what the server refuses, and the person gets a message about character counts for an announcement
// they cannot shorten from that dialog. One that drifts LOWER refuses work the server would have done.
//
// The client cannot import the domain module - it is a separate build with its own tsconfig - so the number
// is mirrored, and this is what holds the mirror.
const web = import.meta.glob("../web/src/lib/aiFeatures.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("the drafting input cap", () => {
  it("is the same number on both sides", () => {
    const src = Object.values(web)[0]!;
    const mirrored = src.match(/export const MAX_DRAFT_INPUT = (\d+)/)?.[1];
    expect(mirrored, "web/src/lib/aiFeatures.ts must export MAX_DRAFT_INPUT").toBeDefined();
    expect(Number(mirrored)).toBe(MAX_DRAFT_INPUT);
  });

  it("is applied by the composer", () => {
    // The mirror is only worth having if the dialog binds it: the textarea stops typing at the cap, and the
    // existing text - which the dialog cannot shorten - is refused with a sentence instead of being sent.
    const button = Object.values(
      import.meta.glob("../web/src/components/common/DraftButton.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
    )[0]!;
    expect(button).toMatch(/maxLength=\{MAX_DRAFT_INPUT\}/);
    expect(button).toMatch(/MAX_DRAFT_INPUT/);
  });
});
