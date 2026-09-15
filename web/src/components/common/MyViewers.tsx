import * as React from "react";
import { Eye, ShieldCheck } from "lucide-react";
import { invoke } from "@/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CopyEmail } from "@/components/common/CopyEmail";
import { roleLabel } from "@/lib/roles";

// "Who can see my record?" - the effective-access report, aimed at the person the record is about.
//
// Every other access surface in the app answers the ADMIN's question. This one answers the employee's, which
// is the question people actually have about an HR system: who reads my bank details. The engine has always
// known; nothing let you ask it about yourself. Lazily loaded behind an explicit press - it grades the whole
// roster, so it is not something to run on every profile open.

type Viewer = { name: string | null; email: string; role: string; why?: string };
type Report = { target: string; viewers: Viewer[] };
type Response = { reports: Report[]; roster: number; complete: boolean };

// The wire target names, as people would say them.
const TARGET_LABEL: Record<string, string> = {
  "": "Your profile",
  "personal-info": "Contact details",
  identity: "Identity documents",
  "bank-account": "Bank details",
  tax: "Tax details",
};

export function MyViewers({ selfPath }: { selfPath: string }) {
  const [data, setData] = React.useState<Response | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setData(await invoke<Response>(selfPath, "viewers"));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" /> Who can see this</p>
            <p className="text-xs text-muted-foreground">
              The people who can currently read your record and each sensitive section. Worked out by the same
              engine that decides every request - not a guess.
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
            <Eye className="h-4 w-4" /> {data ? "Refresh" : "Check"}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {data && (
          <>
            {!data.complete && (
              // Under-reporting who can see somebody's bank details would be worse than not answering, so the
              // sample says so out loud rather than reading as a complete list.
              <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                Your organisation is larger than one page, so this covers the first {data.roster} people rather
                than everyone.
              </p>
            )}
            <div className="space-y-3">
              {data.reports.map((r) => (
                <div key={r.target} className="rounded-lg border p-3">
                  <p className="mb-1.5 flex items-center gap-2 text-sm font-medium">
                    {TARGET_LABEL[r.target] ?? r.target}
                    <Badge variant={r.viewers.length ? "secondary" : "outline"}>
                      {r.viewers.length === 0 ? "only you" : `${r.viewers.length} ${r.viewers.length === 1 ? "person" : "people"}`}
                    </Badge>
                  </p>
                  {r.viewers.length > 0 && (
                    <ul className="space-y-1">
                      {r.viewers.map((v) => (
                        <li key={v.email} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                          <span className="font-medium">{v.name || v.email}</span>
                          <CopyEmail email={v.email} />
                          <span className="text-muted-foreground">{roleLabel(v.role)}</span>
                          {v.why && <span className="text-muted-foreground">· {v.why}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
