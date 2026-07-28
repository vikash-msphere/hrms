// Default letter + card templates - reused verbatim from scripts/genTemplatesSeed (the same source the dev
// seed uses). HR edits these at runtime; this is the starting point only.
import { renderTemplatesSeed } from "../../scripts/genTemplatesSeed";

export function templates(): string {
  return renderTemplatesSeed().trim();
}
