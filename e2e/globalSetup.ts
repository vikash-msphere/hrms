import type { FullConfig } from "@playwright/test";
import { lane } from "./lane";

// Prove the stack is the one the specs assume, before a single browser opens.
//
// Two things have to be true, and both fail quietly rather than loudly if they are not.
//
// **The auth mode.** Every spec logs in by minting a signed `hrms_session` cookie for a seeded role. That
// only means anything while the Worker is in Google sign-in mode. If the dev bypass is engaged instead
// (DEV_FAKE_EMAIL + ALLOW_DEV_AUTH=true, which is exactly how the dev stack runs), the Worker ignores the
// cookie and resolves EVERY request to the one dev identity - so the roles silently collapse into one, the
// access assertions pass for the wrong reason, and the two-identity specs fail somewhere far from the cause.
// The cheapest possible proof: an unauthenticated read must be refused. In Google mode that is 401 "not
// signed in"; under the bypass it is a 200 (or a 500 from a half-configured env), never a 401.
//
// **Prism.** `/v1` is supposed to travel through the contract proxy, so a request or response that drifts
// from openapi.yaml fails the spec that provoked it. If Prism is not listening, Vite's proxy still answers -
// by falling over - and it would be easy to "fix" that by pointing the app at the Worker and quietly losing
// the contract validation this lane is here to get.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("e2e: no baseURL configured");

  const prismPort = lane.prismPort;
  const prism = await fetch(`http://127.0.0.1:${prismPort}/v1/users/me`).catch(() => null);
  if (!prism) {
    throw new Error(
      [
        `e2e: nothing is listening on the Prism port (${prismPort}).`,
        "",
        "`/v1` is meant to go through the contract proxy (scripts/e2eStack.sh starts it). Without it the",
        "specs would run without any openapi.yaml validation - or against a Vite proxy with a dead upstream.",
      ].join("\n"),
    );
  }

  const res = await fetch(`${baseURL}/v1/users/me`, { headers: { accept: "application/json" } });
  if (res.status === 401) return;

  const body = await res.text().catch(() => "");
  throw new Error(
    [
      `e2e: GET /v1/users/me returned ${res.status}, expected 401.`,
      "",
      "The stack is not in the cookie-auth mode the specs need. The usual causes:",
      `  - ${baseURL} is the DEV stack (scripts/start.sh, port 5173), not the e2e stack (scripts/e2eStack.sh, port 5174).`,
      "  - The ALLOW_DEV_AUTH=false override in e2e/e2e.vars is no longer beating .dev.vars.",
      "",
      `Response body: ${body.slice(0, 300)}`,
    ].join("\n"),
  );
}
