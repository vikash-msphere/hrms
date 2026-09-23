import { describe, it, expect } from "vitest";
import { redactSettingResource, SIGNATURE_FIELDS } from "../src/http/settingRedact";
import type { AppUser } from "../src/env";
import type { Wire } from "../src/http/wire";
import type { Grant } from "../src/domain/permissions";

// THE EMPLOYER'S SIGNATURE IS NOT BRANDING.
//
// `settings/organization` is the one settings blob every signed-in user reads (OrgProvider fetches it on mount
// and settingsStore keeps it on disk for a day), and the seeded grants give every role `settings.**` at read.
// Two values inside it are the images stamped onto offer, increment, experience and relieving letters - the
// authorized signatory's signature and the company seal - so serving the blob verbatim handed the whole
// workforce everything needed to sign a document the company never issued. `employeePhoto.ts` already refuses
// exactly this for an INDIVIDUAL's signature, one file over, calling it forgeable and owner-only at the
// service level.
//
// The rule: served whole to whoever may WRITE the key, without the two images to everybody else.
const user = (grant: Grant): AppUser => ({ uuid: "u1", email: "e@x.test", role: "employee", status: "active", employeeCode: "04-001", grant } as unknown as AppUser);
const reader = user({ levels: { "settings.**": "read" }, allow: [] });
const writer = user({ levels: { "settings.**": "write" }, allow: [] });
const superUser = user({ levels: { "**": "admin" }, allow: ["**"] });

const orgSetting = (letterDefaults: Record<string, unknown>): Wire<"setting"> =>
  ({ path: "settings/organization", key: "organization", value: { name: "Acme", letter_defaults: { signatory_name: "R. Rao", ...letterDefaults } } } as unknown as Wire<"setting">);

const defaultsOf = (res: Wire<"setting">) => (res.value as unknown as { letter_defaults: Record<string, unknown> }).letter_defaults;

const IMAGES = { signatory_signature: "data:image/png;base64,SIG", company_stamp: "data:image/png;base64,SEAL" };

describe("the organization blob does not hand out the employer's signature", () => {
  it("drops both images for a caller who may only read the key", () => {
    const out = redactSettingResource(orgSetting(IMAGES), reader);
    for (const f of SIGNATURE_FIELDS) expect(defaultsOf(out)[f]).toBeUndefined();
  });

  it("keeps the rest of the blob intact - this narrows two fields, not the config", () => {
    const out = redactSettingResource(orgSetting(IMAGES), reader);
    expect((out.value as unknown as { name: string }).name).toBe("Acme");
    expect(defaultsOf(out).signatory_name).toBe("R. Rao");
    expect(out.key).toBe("organization");
  });

  it("serves them whole to whoever administers the key", () => {
    for (const admin of [writer, superUser]) {
      const out = redactSettingResource(orgSetting(IMAGES), admin);
      expect(defaultsOf(out).signatory_signature).toBe(IMAGES.signatory_signature);
      expect(defaultsOf(out).company_stamp).toBe(IMAGES.company_stamp);
    }
  });

  it("leaves every other settings key alone", () => {
    const other = { path: "settings/ctc", key: "ctc", value: { basic_pct: 50 } } as unknown as Wire<"setting">;
    expect(redactSettingResource(other, reader)).toBe(other);
  });

  it("returns the resource untouched when neither image is configured (no empty key invented)", () => {
    const res = orgSetting({});
    expect(redactSettingResource(res, reader)).toBe(res);
  });

  // The two fields are read from the same registry the redactor uses, so a third image added to the blob has
  // to be named here to be hidden - which is the point: the list is the decision.
  it("names exactly the two signature fields", () => {
    expect([...SIGNATURE_FIELDS]).toEqual(["signatory_signature", "company_stamp"]);
  });
});
