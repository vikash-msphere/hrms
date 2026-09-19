import EmployeeProfile from "./EmployeeProfile";
import type { Me } from "@/types";
import { ProfileView, ProfileFact } from "@/components/common/ProfileView";
import { PageHeader } from "@/components/common/PageHeader";
import { Card, CardContent } from "@/components/ui/card";

// MY PROFILE IS THE SAME PAGE AS ANYBODY'S PROFILE, at a different address.
//
// It used to be a second implementation of it, and the two had drifted into different products for the same
// record: different tabs (this one had no Employment, Leave, Attendance or Activity; the other had no Assets
// tab and no signature), a different ORDER for the tabs they shared, different titles for identical cards
// ("My bank details" / "Bank details"), Assets as a tab here and a card inside Employment there - and the open
// tab lived in component state, so no section of your own record could be linked to at all. Every panel on it
// was the same shared component, mounted a second time with different props.
//
// So there is one page now and this is the address. What differs between the two is no longer decided here: it
// is `access.subject`, the engine's answer for the person the page is showing (src/domain/access.ts
// `subjectScopes`), which on your own record is whatever the `me`-scoped rules grant you. `basePath` is the
// only thing this passes that the other route does not, and it is just where tab links are written to, so
// `/profile/identity` works exactly like `/employees/<id>/identity`.
//
// `sub` arrives as the route's `id` segment rather than its `sub`: this route has no record id in the URL
// (the record is "mine"), so the tab is the first segment after the page. See router.ts `Route`.
export default function Profile({ me, sub }: { me: Me; sub?: string }) {
  // An account with no employee record has no profile to draw, and never reaches the shared page - there is no
  // subject for the engine to answer about. The band carries the one thing this account does have.
  if (!me.employee_id) {
    const name = me.email.split("@")[0] ?? me.email;
    return (
      <div>
        <PageHeader title="My Profile" />
        <ProfileView name={name} facts={<ProfileFact label="Account email" value={me.email} copy={me.email} />} />
        <Card className="mt-4">
          <CardContent className="py-6 text-sm text-muted-foreground sm:py-6">
            Your account isn't linked to an employee record yet. Ask an HR admin to connect it.
          </CardContent>
        </Card>
      </div>
    );
  }
  return <EmployeeProfile id={me.employee_id} me={me} sub={sub} basePath="profile" />;
}
