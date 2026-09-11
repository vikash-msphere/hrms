import { describe, it, expect } from "vitest";
import { escapeHtml, textParagraphs, renderEmail } from "../src/lib/emailLayout";
import { richToPlain } from "../src/domain/richText";

// `EmailContent.bodyHtml` is RAW by contract - the shell cannot escape it, because most callers compose real
// markup (see services/ats.ts). That puts the duty on whoever folds a VALUE into it. These pin the two helpers
// the text-bodied callers use, and the composition the board post email now goes through.

const brand = { orgName: "Acme", accent: "#123456" };

describe("textParagraphs", () => {
  it("splits on blank lines and keeps single newlines as breaks", () => {
    expect(textParagraphs("one\ntwo\n\nthree")).toBe(
      '<p style="margin:0 0 12px;">one<br>two</p><p style="margin:0 0 12px;">three</p>',
    );
  });

  it("escapes what the author typed, so prose can never become markup", () => {
    const out = textParagraphs('<img src=x onerror="alert(1)"> & <b>bold</b>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;b&gt;bold&lt;/b&gt;");
  });

  it("drops empty paragraphs rather than emitting hollow ones", () => {
    expect(textParagraphs("\n\n\n")).toBe("");
    expect(textParagraphs("a\n\n\n\nb")).toBe('<p style="margin:0 0 12px;">a</p><p style="margin:0 0 12px;">b</p>');
  });
});

describe("escapeHtml", () => {
  it("covers the four characters that matter in text and in a quoted attribute", () => {
    expect(escapeHtml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
  });
});

// A board post's body is markdown-lite, and it used to go into the email as-is: subscribers were mailed the
// MARKUP (asterisks, link syntax) as one run-on block, and anything angle-bracketed an author typed landed in
// a company-branded email unescaped.
describe("a board post emailed to its audience", () => {
  const body = "**Important** notice\nsecond line\n\nSee [the policy](https://example.test/policy).\n\n<script>alert(1)</script>";

  it("mails the prose, not the markdown source", () => {
    const html = renderEmail({ heading: "Notice", bodyHtml: textParagraphs(richToPlain(body)) }, brand);
    expect(html).toContain("Important notice"); // the asterisks are gone
    expect(html).not.toContain("**Important**");
    expect(html).toContain("See the policy."); // the link keeps its words, not its syntax
    expect(html).not.toContain("](https://example.test/policy)");
  });

  it("keeps the author's line structure instead of collapsing the post into one block", () => {
    const html = renderEmail({ heading: "Notice", bodyHtml: textParagraphs(richToPlain(body)) }, brand);
    expect(html).toContain("Important notice<br>second line");
  });

  it("never lets a typed-in tag reach the recipient as markup", () => {
    const html = renderEmail({ heading: "Notice", bodyHtml: textParagraphs(richToPlain(body)) }, brand);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes the heading too, wherever the title came from", () => {
    const html = renderEmail({ heading: '<img src=x onerror="alert(1)">', bodyHtml: "<p>hi</p>" }, brand);
    expect(html).not.toContain("<img src=x");
  });
});
