import { describe, it, expect } from "vitest";
import { isAllowedUpload, isPdfUpload, documentFileName, storedContentType } from "../src/services/documentsCommon";

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

describe("an allowed EXTENSION does not excuse an executable media type", () => {
  // The extension arm returned before the media type was ever consulted, so a name ending in an allowed
  // extension was enough to declare any type at all - and that declared type is what the upload STORED and
  // every download route echoes back into the response's `Content-Type`. `payload.html` was refused (no
  // allowed extension, no allowed type) while `resume.pdf` carrying `text/html` sailed through, which is the
  // same file under a different name.
  it("refuses text/html however the file is named", () => {
    expect(isAllowedUpload("resume.pdf", "text/html")).toBe(false);
    expect(isAllowedUpload("sheet.xlsx", "text/html; charset=utf-8")).toBe(false);
    expect(isAllowedUpload("photo.png", "TEXT/HTML")).toBe(false);
  });

  it("refuses the rest of the family SVG was standing in for", () => {
    for (const ct of ["application/xhtml+xml", "text/xml", "application/xml", "application/javascript", "text/javascript"]) {
      expect(isAllowedUpload("notes.txt", ct)).toBe(false);
    }
  });

  it("refuses an executable EXTENSION even with a harmless declared type", () => {
    expect(isAllowedUpload("payload.html", "text/plain")).toBe(false);
    expect(isAllowedUpload("payload.htm", "application/pdf")).toBe(false);
    expect(isAllowedUpload("payload.js", "text/plain")).toBe(false);
    expect(isAllowedUpload("logo.svgz", "image/png")).toBe(false);
  });

  it("leaves the legitimate uploads alone", () => {
    expect(isAllowedUpload("resume.pdf", "application/pdf")).toBe(true);
    expect(isAllowedUpload("notes.txt", "text/plain; charset=utf-8")).toBe(true);
    expect(isAllowedUpload("deck.pptx", undefined)).toBe(true);
    // A vendor type nobody can enumerate, on an allowed extension: still accepted, because refusing what we
    // cannot name would break ordinary uploads. `storedContentType` is what keeps it from being echoed.
    expect(isAllowedUpload("plan.pages", "application/x-iwork-pages-sffpages")).toBe(true);
  });
});

describe("storedContentType - what the server is willing to CLAIM a file is", () => {
  it("keeps the types the app produces and recognises", () => {
    expect(storedContentType("application/pdf")).toBe("application/pdf");
    expect(storedContentType("image/png")).toBe("image/png");
    expect(storedContentType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(storedContentType("APPLICATION/PDF")).toBe("application/pdf");
    expect(storedContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("collapses anything else to octet-stream rather than echoing it back", () => {
    // The point of the whole exercise: the caller does not get to choose the Content-Type their own bytes are
    // later served under, even where the bytes themselves were allowed to be stored.
    expect(storedContentType("text/html")).toBe("application/octet-stream");
    expect(storedContentType("image/svg+xml")).toBe("application/octet-stream");
    expect(storedContentType("application/x-iwork-pages-sffpages")).toBe("application/octet-stream");
    expect(storedContentType(undefined)).toBe("application/octet-stream");
    expect(storedContentType(null)).toBe("application/octet-stream");
    expect(storedContentType("")).toBe("application/octet-stream");
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
