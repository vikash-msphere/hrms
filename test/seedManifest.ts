// Seed the policy manifest row into a test database, as the bootstrap seeds it into a real one. The app keeps no
// copy of the policy (it refuses with 503 not-configured when the row is missing), so a fixture that sends
// requests through the auth middleware, or acts as the system actor, needs the row a real database always has.
import { DEFAULT_POLICY } from "../bootstrap/authz/policy";

export async function seedManifest(db: D1Database): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO policy (key, value_json, updated_at) VALUES ('manifest', ?, 0)").bind(JSON.stringify(DEFAULT_POLICY)).run();
}
