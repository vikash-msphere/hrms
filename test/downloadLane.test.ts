/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// ONE WAY A FILE REACHES THE DISK.
//
// There were four hand-rolled copies of "make an anchor around an object URL and click it" - the table export,
// the .ics download, the asset-tag sticker sheet, and api.ts's binary download - and they had already come
// apart. Every one of them revoked the object URL in the SAME TICK as the click, which races the browser's own
// fetch of it: Chrome has usually started by then, Firefox and Safari have not, and the download is cancelled
// with no file and no error. And `assetTagsPdf.downloadPdf` had additionally lost the `document.body.append`
// that Firefox requires before it will act on a synthetic click - so the sheet that exists to be printed was
// the copy most likely to be broken already.
//
// Neither fault is visible in the browser the author is using, and no runtime test in this suite has a DOM to
// catch them. What CAN be checked is that there is only one implementation left: the guard is on the source,
// because the property being protected is "nobody writes a second one".
const files = import.meta.glob("../web/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const LANE = "lib/download.ts";

describe("blob downloads go through one helper", () => {
  it("only lib/download.ts builds an anchor around an object URL", () => {
    const offenders = Object.entries(files)
      .filter(([path]) => !path.endsWith(LANE))
      .filter(([, src]) => /createObjectURL/.test(src) && /\.download\s*=/.test(src))
      .map(([path]) => path.replace(/^\.\.\//, ""));
    expect(offenders, `these build their own download anchor instead of calling saveBlob/saveBytes: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the one helper attaches the anchor and does not revoke in the same tick", () => {
    const src = Object.entries(files).find(([p]) => p.endsWith(LANE))?.[1];
    expect(src, "web/src/lib/download.ts is missing").toBeDefined();
    // Firefox will not dispatch a click at a detached element.
    expect(src).toMatch(/document\.body\.appendChild\(a\)/);
    // The revoke is deferred; a bare `URL.revokeObjectURL(url);` on its own line is the synchronous form.
    expect(src).toMatch(/setTimeout\(\(\) => URL\.revokeObjectURL\(url\)/);
    expect(src).not.toMatch(/^\s*URL\.revokeObjectURL\(url\);\s*$/m);
  });

  // `api.ts#blobUrl` is deliberately outside the lane: it hands a URL to a viewer that keeps it open, so its
  // lifetime belongs to the component. It must not grow a download of its own.
  it("blobUrl stays a URL, not a download", () => {
    const api = Object.entries(files).find(([p]) => p.endsWith("web/src/api.ts"))?.[1] ?? "";
    expect(api).toMatch(/export async function blobUrl/);
    expect(api).toMatch(/saveBlob\(await postBinary/);
  });
});
