import { describe, it, expect } from "vitest";
import { validateSettingValue } from "../src/routes/settings";
import { validateAtsConfig, orphanedStages, DEFAULT_ATS_CONFIG, type AtsStage } from "../src/domain/ats";

// Three keys that decide something consequential and were reaching their consumers unchecked. Each failure
// below is the one the validator exists to stop, stated as the thing that used to be storable.
const settings = (key: string, value: unknown) => () => validateSettingValue(key, value);

// ---- settings/esign ------------------------------------------------------------------------------------
//
// `api_base` is where the app POSTs the document to be signed, CARRYING the vendor credentials out of env
// (services/esign/cashfree.ts#authHeaders sends x-client-id / x-client-secret on every call). Free text, it
// turned a settings capability into "read this org's Cashfree secret" - point it at a host you control and the
// next :sign hands it over - and into an SSRF primitive besides. `redirect_url` is where the SIGNER is sent.
describe("settings/esign vendor URLs", () => {
  const esign = (providers: Record<string, Record<string, unknown>>) => settings("esign", { enabled: true, providers });

  it("accepts the real vendor bases an org would set", () => {
    expect(esign({ cashfree: { api_base: "https://api.cashfree.com/verification" } })).not.toThrow();
    expect(esign({ cashfree: { api_base: "https://sandbox.cashfree.com/verification" } })).not.toThrow();
    expect(esign({ cashfree: { api_base: "https://api.cashfree.com/verification", redirect_url: "https://hr.example.com/documents" } })).not.toThrow();
  });

  it("refuses a base that would send the vendor credentials somewhere else", () => {
    for (const api_base of [
      "http://api.cashfree.com/verification", // plaintext
      "https://127.0.0.1/verification",
      "https://localhost/verification",
      "https://169.254.169.254/latest/meta-data", // the metadata address the guard exists for
      "https://[::1]/verification",
      "https://internal.service.local/verification",
      "https://api.cashfree.com:8443/verification", // a public host's NON-public service
      "not-a-url",
    ]) {
      expect(esign({ cashfree: { api_base } }), api_base).toThrow();
    }
  });

  it("judges every driver and every URL field, not just the one driver that exists today", () => {
    expect(esign({ someVendor: { webhook_url: "http://10.0.0.5/hook" } })).toThrow();
    expect(esign({ cashfree: { redirect_url: "https://192.168.1.1/done" } })).toThrow();
  });

  it("leaves an unset field alone (the default base stands)", () => {
    expect(esign({ cashfree: { expiry_days: 7 } })).not.toThrow();
    expect(esign({ cashfree: { api_base: "", redirect_url: "" } })).not.toThrow();
    expect(settings("esign", { enabled: false })).not.toThrow();
  });

  it("still checks the master switch", () => {
    expect(settings("esign", { enabled: "yes" })).toThrow();
  });
});

// ---- settings/gratuity ---------------------------------------------------------------------------------
//
// Every field is written straight from a number input, `Number("")` is 0, and `gratuityAmount` guards only the
// divisor. The two silent failures are opposite and both land on a payout with no later run to correct it.
describe("settings/gratuity", () => {
  it("accepts the statutory defaults", () => {
    expect(settings("gratuity", { enabled: true, min_years: 5, days_per_year: 15, divisor: 26, exemption_cap: 2_000_000 })).not.toThrow();
  });

  it("refuses a qualifying service of zero (gratuity for someone who left in their first week)", () => {
    expect(settings("gratuity", { enabled: true, min_years: 0 })).toThrow();
  });

  it("refuses zero days per year (every leaver silently paid nothing)", () => {
    expect(settings("gratuity", { enabled: true, days_per_year: 0 })).toThrow();
  });

  it("refuses a zero divisor and a negative ceiling", () => {
    expect(settings("gratuity", { enabled: true, divisor: 0 })).toThrow();
    expect(settings("gratuity", { enabled: true, exemption_cap: -1 })).toThrow();
  });

  it("says nothing about the numbers when the policy is off", () => {
    expect(settings("gratuity", { enabled: false, min_years: 0, days_per_year: 0 })).not.toThrow();
  });
});

// ---- settings/ats --------------------------------------------------------------------------------------
//
// An application's stage is STORED as the stage key, so two stages sharing a key are one stage to everything
// downstream: the board renders those applications in both columns, and `nextStage` (which resolves by
// indexOf) advances from either to the successor of the first, skipping a stage. The Settings panel minted
// keys from the array length, which repeats as soon as the list has ever shrunk.
describe("settings/ats pipeline", () => {
  const stages = (s: AtsStage[]) => ({ ...DEFAULT_ATS_CONFIG, stages: s });

  it("accepts the shipped default pipeline", () => {
    expect(validateAtsConfig(DEFAULT_ATS_CONFIG)).toEqual([]);
    expect(settings("ats", DEFAULT_ATS_CONFIG)).not.toThrow();
  });

  it("refuses two stages with the same key", () => {
    const dup = stages([
      { key: "applied", label: "Applied", kind: "active" },
      { key: "stage_6", label: "Screen", kind: "active" },
      { key: "stage_6", label: "Interview", kind: "active" },
      { key: "hired", label: "Hired", kind: "hired" },
    ]);
    expect(validateAtsConfig(dup).join("; ")).toMatch(/duplicate stage key "stage_6"/);
    expect(settings("ats", dup)).toThrow();
  });

  it("requires a hired terminal and a non-empty, well-formed list", () => {
    expect(validateAtsConfig(stages([{ key: "applied", label: "Applied", kind: "active" }])).join("; ")).toMatch(/hired/);
    expect(validateAtsConfig(stages([])).join("; ")).toMatch(/non-empty/);
    expect(validateAtsConfig(stages([{ key: "Applied Stage", label: "x", kind: "active" }])).join("; ")).toMatch(/lowercase slug/);
  });

  it("refuses duplicate scorecard criteria, which file interview scores the same way", () => {
    const cfg = { ...DEFAULT_ATS_CONFIG, scorecard_criteria: [{ key: "tech", label: "A" }, { key: "tech", label: "B" }] };
    expect(validateAtsConfig(cfg).join("; ")).toMatch(/duplicate scorecard criterion key/);
  });

  it("leaves the default table alone when the write does not touch stages", () => {
    expect(validateAtsConfig({ sources: ["referral"] })).toEqual([]);
  });

  // The other half of removing a stage: the rows already pointing at it. `orphanedStages` is what the route
  // asks before storing, so a stage cannot be deleted out from under live candidates.
  it("names the stages a removal would strand", () => {
    expect(orphanedStages(DEFAULT_ATS_CONFIG.stages, ["applied", "screening"])).toEqual([]);
    expect(orphanedStages(DEFAULT_ATS_CONFIG.stages.filter((s) => s.key !== "screening"), ["applied", "screening", "screening"])).toEqual(["screening"]);
  });
});
