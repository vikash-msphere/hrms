import { useEffect, useState } from "react";
import { LogIn } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PanelSkeleton } from "@/components/common/Skeletons";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { getSetting, saveSetting } from "@/lib/settingsStore";

// What the app takes from a Google account at sign-in (settings/sign-in).
//
// One switch today, and a panel of its own rather than a line in another one, because importing somebody's
// Google picture is a data-handling decision an org may want to make deliberately - and because session length
// and the allowed sign-in domains belong here if they ever become editable.

type NameMode = "never" | "once" | "always";
type SignInConfig = { google_photo?: boolean; google_name?: NameMode | boolean; google_employee?: boolean };

const DEFAULTS = { google_photo: true, google_name: "once" as NameMode, google_employee: false };

const NAME_MODES: { value: NameMode; label: string; hint: string }[] = [
  { value: "never", label: "Never", hint: "Names are whatever HR entered here. Nothing a sign-in says changes them." },
  {
    value: "once",
    label: "At their first sign-in only",
    hint: "Takes Google's spelling while the record is new and nobody has had a reason to correct it, then never argues again - a preferred name, a corrected transliteration, or a change made here and not in Google all survive. Applies to an account that has never used the app.",
  },
  {
    value: "always",
    label: "At every sign-in",
    hint: "Google is the register of names: at each sign-in the first and last name here are set to the Google account's, over whatever is stored. A name corrected here is overwritten at that person's next sign-in.",
  },
];

/** A stored boolean is what this setting was before it grew a middle option: `true` meant today's "always". */
const asMode = (v: SignInConfig["google_name"]): NameMode | null =>
  v === true ? "always" : v === false ? "never" : v === "never" || v === "once" || v === "always" ? v : null;

export function SignInSettingsTab() {
  const { toast } = useToast();
  const [googlePhoto, setGooglePhoto] = useState(DEFAULTS.google_photo);
  const [googleName, setGoogleName] = useState(DEFAULTS.google_name);
  const [googleEmployee, setGoogleEmployee] = useState(DEFAULTS.google_employee);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSetting<SignInConfig>("sign-in")
      .then((s) => {
        const v = s.value ?? {};
        if (typeof v.google_photo === "boolean") setGooglePhoto(v.google_photo);
        const mode = asMode(v.google_name);
        if (mode) setGoogleName(mode);
        if (typeof v.google_employee === "boolean") setGoogleEmployee(v.google_employee);
      })
      .catch(() => { /* nothing saved yet: the defaults stand, which is what the server uses too */ })
      .finally(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved({ googlePhoto, googleName, googleEmployee }, ready, save);
  async function save() {
    setSaving(true);
    try {
      await saveSetting("sign-in", { value: { google_photo: googlePhoto, google_name: googleName, google_employee: googleEmployee } });
      markSaved();
      toast({ title: "Saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // No live inputs before the stored value lands: a change made on the defaults was replaced by the hydration.
  if (!ready) return <PanelSkeleton />;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><LogIn className="h-4 w-4" /> Google sign-in</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          These apply where the organisation signs in with Google, and cover what a sign-in already tells the
          app: the person&apos;s photo and their name. A phone number, a job title or the Workspace org unit are
          not part of it - those come from Google&apos;s directory, which is a separate integration. On a
          Cloudflare Access deployment none of this applies: an Access sign-in carries an email address and
          nothing else.
        </p>

        <div className="space-y-2 rounded-lg border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={googleEmployee} onCheckedChange={(v) => setGoogleEmployee(v === true)} />
            Create an employee record for someone who has none
          </label>
          <p className="text-xs text-muted-foreground">
            For an organisation that adds people to Google first. Signing in already creates the account that
            holds someone&apos;s access, but almost everything in the app hangs off their employee record - so
            without one they land on an app with nothing in it. This makes the record at their first sign-in,
            from what the sign-in carries: their name, their work address, and today as the start date, in the
            default department. There is no second time - an employee already holding that work address, a past
            one included, is left exactly as it is.
          </p>
          <p className="text-xs text-warning">
            It is a real hire everywhere else: headcount, the directory, the org chart, and any onboarding
            automation you have written, which runs for them as it would for anyone HR adds. Only addresses on
            the permitted sign-in domains ever reach this.
          </p>
        </div>

        <div className="space-y-2 rounded-lg border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={googlePhoto} onCheckedChange={(v) => setGooglePhoto(v === true)} />
            Use their Google profile photo
          </label>
          <p className="text-xs text-muted-foreground">
            Fills the profile photo for someone who has never had one, once, the next time they sign in. It
            never replaces a photo that was uploaded here, and never brings back one that was removed - so
            anybody who would rather not have a face in the directory only has to clear it once. Everyone can
            still change or remove their own photo on their profile.
          </p>
        </div>

        <div className="space-y-2 rounded-lg border p-3">
          <label className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Take their name from Google
            <Select value={googleName} onValueChange={(v) => setGoogleName(v as NameMode)}>
              <SelectTrigger className="h-8 w-60"><SelectValue /></SelectTrigger>
              <SelectContent>{NAME_MODES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <p className="text-xs text-muted-foreground">
            {NAME_MODES.find((m) => m.value === googleName)?.hint}
          </p>
          <p className="text-xs text-muted-foreground">
            The employee record&apos;s first and last name, never the legal name. Both parts have to be on the
            Google account or nothing is taken, and every change is recorded in the audit trail.
          </p>
        </div>

        <AccessAction collection="settings" objectPath="settings/sign-in" label="Save">
          <Button onClick={save} disabled={saving || !ready}>{saving ? "Saving…" : "Save"}</Button>
        </AccessAction>
      </CardContent>
    </Card>
  );
}
