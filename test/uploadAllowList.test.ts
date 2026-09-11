import { describe, it, expect } from "vitest";
import { isAllowedUpload, isPdfUpload, documentFileName } from "../src/services/documentsCommon";

// The upload allow-list is server-authoritative, and every decision it makes is a comparison against a bare
// media type. A `Content-Type` may carry parameters - `image/svg+xml; charset=utf-8` names the same type as
// `image/svg+xml`, and it is what curl and several browsers actually send - so the parameters have to come off
// before any of those comparisons. They did not, and it broke the list in both directions: the exact refusals
// were bypassable by appending a parameter, and the exact allows rejected the ordinary parameterized form.

describe("isAllowedUpload - the media type decides, parameters and all", () => {
  it("refuses SVG, however the content type is spelled", () => {
    expect(isAllowedUpload("logo.svg", "image/svg+xml")).toBe(false);
    expect(isAllowedUpload(undefined, "image/svg+xml")).toBe(false);
    // The bypass: a parameter made the `=== "image/svg+xml"` refusal miss, and the broad `image/` arm below
    // then allowed it. Stored XSS is the reason SVG is refused at all.
    expect(isAllowedUpload(undefined, "image/svg+xml; charset=utf-8")).toBe(false);
    expect(isAllowedUpload("logo", "IMAGE/SVG+XML;charset=UTF-8")).toBe(false);
  });

  it("refuses an SVG wearing an allowed extension - the type is what the file IS", () => {
    expect(isAllowedUpload("logo.png", "image/svg+xml")).toBe(false);
    expect(isAllowedUpload("report.pdf", "image/svg+xml; charset=utf-8")).toBe(false);
  });

  it("allows a parameterized text/plain, which is how a .txt is normally sent", () => {
    expect(isAllowedUpload(undefined, "text/plain; charset=utf-8")).toBe(true);
    expect(isAllowedUpload("notes", "text/plain;charset=UTF-8")).toBe(true);
  });

  it("still allows the ordinary cases", () => {
    expect(isAllowedUpload("payslip.pdf", "application/pdf")).toBe(true);
    expect(isAllowedUpload("photo.jpg", "image/jpeg")).toBe(true);
    expect(isAllowedUpload("sheet.xlsx", undefined)).toBe(true);
    expect(isAllowedUpload(undefined, "application/vnd.oasis.opendocument.text")).toBe(true);
  });

  it("still refuses what is not on the list", () => {
    expect(isAllowedUpload("payload.html", "text/html")).toBe(false);
    expect(isAllowedUpload("run.exe", "application/octet-stream")).toBe(false);
    expect(isAllowedUpload(undefined, undefined)).toBe(false);
  });
});

describe("isPdfUpload / documentFileName - same normalization", () => {
  it("recognizes a parameterized application/pdf", () => {
    // A policy that requires acknowledgement must be a PDF; a false negative here refuses a legitimate upload.
    expect(isPdfUpload(undefined, "application/pdf; version=1.7")).toBe(true);
    expect(isPdfUpload("policy.pdf", "application/octet-stream")).toBe(true);
    expect(isPdfUpload(undefined, "text/plain")).toBe(false);
  });

  it("appends the extension implied by a parameterized type", () => {
    expect(documentFileName({ title: "Offer", contentType: "application/pdf; charset=binary" })).toBe("Offer.pdf");
    expect(documentFileName({ fileName: "already.pdf", contentType: "application/pdf" })).toBe("already.pdf");
  });
});
