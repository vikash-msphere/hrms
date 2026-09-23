import { describe, it, expect } from "vitest";
import { DEFAULT_PAYSLIP_TEMPLATE, PAYSLIP_TOKENS, MAX_BLOCKS, parsePayslipTemplate } from "../src/domain/payslipTemplate";
import {
  DEFAULT_PAYSLIP_TEMPLATE as WEB_DEFAULT,
  PAYSLIP_TOKENS as WEB_TOKENS,
  MAX_PAYSLIP_BLOCKS as WEB_MAX,
  PAYSLIP_BLOCK_META,
  newPayslipBlock,
  type PayslipBlockKind,
} from "../web/src/lib/payslipTemplate";

// The payslip-design editor mirrors the server's block vocabulary and stock design (the web bundle can't import
// from src/). This pins the copies together: a block kind, token or default the server changed but the editor
// didn't would otherwise ship an editor that writes templates the API rejects.
describe("web payslip template mirror stays in sync with the server", () => {
  it("the stock design is identical on both sides", () => {
    expect(WEB_DEFAULT).toEqual(DEFAULT_PAYSLIP_TEMPLATE);
  });
  it("the token list and block cap match", () => {
    expect([...WEB_TOKENS]).toEqual([...PAYSLIP_TOKENS]);
    expect(WEB_MAX).toBe(MAX_BLOCKS);
  });
  it("every editor block kind is a kind the server accepts, and each is described", () => {
    const kinds = Object.keys(PAYSLIP_BLOCK_META) as PayslipBlockKind[];
    for (const kind of kinds) {
      expect(PAYSLIP_BLOCK_META[kind].title.length, kind).toBeGreaterThan(0);
      // A freshly-added block must survive server validation unchanged in kind.
      const parsed = parsePayslipTemplate({ blocks: [newPayslipBlock(kind)] });
      expect(parsed.blocks[0]!.kind).toBe(kind);
    }
  });
  it("the stock design is itself valid input to the server validator", () => {
    expect(parsePayslipTemplate(DEFAULT_PAYSLIP_TEMPLATE)).toEqual(DEFAULT_PAYSLIP_TEMPLATE);
  });
});
