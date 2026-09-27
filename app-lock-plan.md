# App lock

A PIN that locks HRMS on a device. While a browser is locked, the server refuses every API call from it and
the page holds nothing: no data in memory, in storage, in the HTTP cache or in the back/forward cache.
Unlocking takes the PIN (later also Touch ID, Face ID or Windows Hello).

Status: approved 2026-09-26, being built. The decisions are recorded in section 9.

## 1. What it protects against

The person this stops is someone who sits down at a browser where you are signed in: a shared desk, a laptop
left open, a phone on a table. Assume they know DevTools.

While a browser is locked:

- Every `/v1` request from it fails, including batch reads, downloads and photos. The server enforces the
  lock, so deleting the lock screen from the page gets nothing.
- The page has nothing to show. Locking reloads into a fresh document, so no data survives in JavaScript
  memory, not even for a heap snapshot. Stored rows, the settings snapshot and drafts are deleted or made
  unreadable (section 4), sessionStorage is cleared, and so are the HTTP cache (cached photos) and the
  back/forward cache.
- Signing out and back in does not get past it. With Google already signed in in the browser, sign-in is one
  click, so a new session for someone with a PIN starts locked.
- Guessing is slow: five tries, then waits that grow to an hour per try, and the owner is told.

What it does not protect against, so nobody over-trusts it:

- Someone watching the PIN being typed.
- Malware or a browser extension on the device, or anyone using the device while it is unlocked.
- Files already downloaded (payslip PDFs), the clipboard, screenshots.
- The Google account itself: locking HRMS does not lock Gmail.
- API keys. They are machine credentials and keep working.

## 2. How the server enforces it

### An unlock proof, not a lock flag

A browser is unlocked only while it holds a valid unlock proof: an HttpOnly, Secure, SameSite=Strict cookie
(`hrms_unlock`) the server issues after a correct PIN. It is signed with HMAC, like the session cookie, under a
key derived from `FIELD_ENCRYPTION_KEY`, so it works in both sign-in modes (Access mode has no
`AUTH_SESSION_KEY`). It carries which user, which session, a random id, and when it was issued and expires.
No PIN and no key material.

Everything without a valid proof is locked. That makes the lock fail-closed: deleting cookies, restoring an old
one or starting a new session all land on the lock screen.

A proof is valid when all of these hold:

- the signature checks and it has not expired;
- it names this user and this session, so a proof from an earlier sign-in never carries over;
- it was issued after the user's "unlocks valid from" cut-off, which "Lock all my devices", a PIN change and an
  admin reset move;
- its id is not on the user's revoked list, which locking one device adds to. Entries drop off once they would
  have expired anyway, so the list stays at a handful.

### Where the check runs

In `src/middleware/auth.ts`, after the user row is loaded and the session revocation check, before grants are
loaded. Lock state lives in a new table, `app_locks` (one row per user who has set a PIN), joined into the read
auth already makes on every request. Cost: one HMAC check, microseconds and well inside the free plan's 10 ms CPU
cap, and about one extra row read per request for people with a PIN.

A separate table rather than columns on `users`, because every write to `users` fires `chg_u_users`, which moves
the change feed and every list etag for every client. Lock and unlock writes should not do that.

A locked request gets `401` with problem type `/errors/app-locked`, carrying the first name and PIN length the
lock screen shows. 401 is the standard answer for "authenticated, but a step-up is required" (RFC 9470 uses it
the same way), it is already declared on every operation in `openapi.yaml`, so the Prism proxy accepts it, and
the SPA tells it apart from an expired session by its type.

Not affected: API-key requests; batch sub-requests (the envelope was already checked); "view as" (the real
admin's lock is the one checked).

### Idle expiry on the server too

The proof has a short sliding expiry: the chosen auto-lock time plus a margin. The page renews it only while it
is actually being used: a small keepalive call, at most once per half window, and only after keyboard, pointer
or touch activity. A browser that is closed, asleep or abandoned therefore locks on the server by itself, with no
write, even if the page never ran its own timer. A proof never outlives its session (12 hours).

### Storing the PIN

HMAC-SHA256 over the user id and the PIN, keyed by a secret derived from `FIELD_ENCRYPTION_KEY`. A 4 or 6 digit
PIN falls to any hash, however slow, within seconds for someone holding the database, so PBKDF2 or scrypt would
buy nothing and would not fit the 10 ms CPU cap. A leaked database is protected by the key not being in it; a
live account is protected by the attempt limit.

Refused when set: all one digit, straight runs (1234, 654321), keypad lines (2580), a short list of the most
common PINs, and digits taken from the person's own employee number. That last check runs on the server, and
the message only says to avoid numbers tied to you.

### Guessing

Each attempt is reserved before the PIN is compared: one `UPDATE ... RETURNING` that increments the failure count
only when the account is not in a wait, the guarded single-statement pattern the money flows use. A burst of
parallel guesses cannot slip extra comparisons past the counter. A correct PIN resets the count; time alone
never does.

Schedule: 5 tries free, then 30 s, 1 min, 5 min, 15 min, then 1 hour per try. At 3 wrong tries, and every
fifth after, the owner gets an urgent in-app notification (and a push to devices where they turned push on).
Each of those thresholds is audited. At this rate a 4 digit PIN takes months to guess and a 6 digit one decades.

No permanent lockout: that would hand anyone at the desk a one-minute denial of service.

### Endpoints

Under `/auth`, beside `/auth/logout`: this is sign-in state, not a data collection, so no access rules or grants
are involved. Same CSRF header as every mutation. They get their own per-user limit. The existing sign-in limit
(30 a minute per IP) moves to login and callback only; otherwise an office behind one address would spend its
sign-in budget on keepalives.

| Endpoint | Does |
|---|---|
| `GET /auth/lock` | Lock status for this browser: enabled, locked, PIN length, auto-lock time, tries left, wait |
| `POST /auth/lock` | Lock this browser, or `{ "everywhere": true }` for every device. Clears the cookie, sends `Clear-Site-Data: "cache"` |
| `POST /auth/lock/unlock` | `{ "pin" }`, returns a new proof |
| `POST /auth/lock/keepalive` | Renews the proof while in use |
| `PUT /auth/lock/pin` | Set or change; a change needs the current PIN |
| `DELETE /auth/lock/pin` | Turn the lock off; needs the current PIN |
| `PATCH /auth/lock` | `{ "idle_minutes" }`: the person's own auto-lock time |

Admin reset is a `/v1` verb, `POST /v1/users/{user}:resetPin`, so it goes through the access rules like any
admin action (super admin by default, grantable in the ACL UI). It clears the PIN, signs the person out
everywhere, notifies them and is audited.

Break-glass for the last super admin who forgets their PIN: one SQL statement, documented in
`docs/deploy-security.md`.

## 3. What the browser does

### Locking

1. In the same frame as the click: an opaque cover over the page and the app root made inert. Nothing from the
   app is visible from this point.
2. Every other tab in this browser is told to lock too.
3. The app unmounts and storage is wiped (table below).
4. `POST /auth/lock`, sent with `keepalive` and capped at about a second, so a slow network cannot hold the
   lock open.
5. Reload into a fresh document at the same path. The query string and hash are dropped, because table filters
   can hold names.

The reload is what makes "nothing left" true: the old page's memory, every module-level cache and anything a
heap snapshot could find go with the document. If the browser restores the old page from its back/forward cache
anyway, it shows only the cover and reloads at once.

If the lock request cannot reach the server (offline), a local flag keeps the lock screen up and re-sends the
lock on the next boot, and the server's idle expiry closes it regardless.

### Wiped on lock

| What | Holds today | On lock |
|---|---|---|
| IndexedDB rows and settings snapshot | Cached server data | Deleted, or unreadable with section 4 |
| IndexedDB drafts | Unsaved writing | Deleted, or unreadable with section 4 |
| sessionStorage | Dialog drafts | Cleared |
| localStorage | Theme, view-as, sync point, UI toggles, palette history | Theme and purely visual toggles stay; anything that can hold names or values goes |
| HTTP cache | Photos (7 days), app code | Cleared by `Clear-Site-Data: "cache"`; costs one app download on the lock screen |
| Back/forward cache | Earlier pages | The same header clears it in Chrome; the cover and reload-on-restore cover the rest |
| Cache Storage | Unused | Cleared anyway |
| Error tracker's replay buffer | The last minute of the page | Gone with the document |

### The lock screen never mounts the app

Boot asks `/users/me`, which `theme-init.js` already prefetches. An `/errors/app-locked` answer renders the lock
screen and nothing else: no sidebar, no providers, no reads.

### Idle

- Activity (keys, pointer, touch, wheel) is tracked across the browser's tabs, so a background tab does not lock
  you while you work in another.
- 30 seconds before an auto-lock, a small banner: "Locking in 30 s", with "Stay unlocked" and "Lock now".
- Checked on a timer and again whenever the tab becomes visible, gets focus or wakes from sleep, so a laptop
  opened after lunch locks before it shows anything.
- While the tab is hidden the page is covered, so tab thumbnails, a phone's app switcher and the first frame on
  return show nothing.

### Across tabs

Lock one tab and every tab locks. Unlock one and the others reload into the app.

## 4. Encrypted local storage (recommended)

The real tension is drafts. Deleting them on every lock means an auto-lock during a coffee break loses a
half-written review. Keeping them as plain text keeps sensitive writing on disk.

Proposal: everything `web/src/lib/clientStore.ts` writes to IndexedDB is encrypted with AES-GCM under a per-user
key. The server derives the key from `FIELD_ENCRYPTION_KEY` and hands it only to an unlocked session, on
`/users/me`. The browser holds it in memory as a non-extractable CryptoKey and never stores it. Locking reloads
the page, so the key is gone, and what stays on disk is ciphertext that nothing can read without the server,
which will not hand the key to a locked browser.

What it buys:

- Nothing readable is left on the device, and drafts survive a lock.
- Unlock is warm: the cache decrypts, the change feed checks it in one request, the page paints from it. Without
  this, every unlock re-reads the page's data from D1.
- Encryption at rest in the browser for everyone, not only PIN users. That closes the "nothing is encrypted at
  rest in the browser" limitation `client-storage.md` records.

Costs: one change to clientStore (encrypt on flush, decrypt on hydrate) and a one-time cache drop on deploy, with
existing drafts re-encrypted rather than dropped. The key rotates only on an admin reset. If the key is ever
unavailable, the store runs memory-only rather than writing plain text.

## 5. The UI

### Lock button

A lock icon in the top bar beside the notification bell, on phones too; also the first item in the avatar menu,
"Lock" in the command palette, and a keyboard shortcut (proposing ⌘⇧L / Ctrl+Shift+L, to be checked against
browser bindings before it ships). Without a PIN, the same button opens setup.

### First-time setup, a sheet of about 20 seconds

1. What it does in two sentences, including that sign-in will ask for the PIN too.
2. 6 digits (default) or 4.
3. Enter, then confirm. A weak PIN is refused inline as the last digit goes in.
4. Auto-lock after 5, 15 (default), 30 or 60 minutes, or only when I lock.
5. "Lock now" or "Done".

### The lock screen

- Full screen, theme-aware, a brand gradient. Never a blurred picture of the app, since that would be the app.
- Large time and date, the way a device lock screen shows them.
- An initials avatar, "Welcome back, first name", and one dot per digit.
- A number pad: 64 px round keys on touch; the physical keyboard and paste on desktop; submits on the last
  digit.
- Wrong PIN: the dots shake, a short vibration on phones, "Wrong PIN. 2 tries left."
- In a wait: the pad pauses behind a countdown.
- "Not you? Sign out" and "Forgot PIN?", which says who can reset it.
- Accessible: a real numeric input under the dots, so screen readers and phone keyboards work; announcements
  for errors; reduced motion respected; focus stays on the screen.
- On unlock the shackle opens, the dots turn green, and the app loads.

### Settings for the person

"App lock" in the avatar menu opens a sheet, and the same panel sits on the profile's self-only Privacy tab
(renamed Privacy & security): on or off, change PIN, auto-lock time, "Lock all my devices", and the last wrong
PIN (when, which browser). A sheet as well as the tab, because accounts with no employee record have no profile.

### Admin

Settings, Users: "Reset app PIN" on a user, behind a confirmation.

## 6. Efficiency

- Per request: one HMAC, and one extra row for people with a PIN.
- Writes: lock this device 1, unlock 2, wrong PIN 1, auto-lock 0.
- Keepalive: at most once per half auto-lock window, and only while in use.
- No polling. A lock from another device is noticed on the next request; within one browser, at once.
- The lock screen is small and ships in the main bundle. Setup and the settings panel load on demand.

## 7. Edge cases

- The session expires while locked: the PIN is not checked; the lock screen sends you to sign in, then asks
  for the PIN once.
- Offline while locked: unlocking needs the server, and the screen says so.
- Access mode and the local dev bypass: supported; the proof binds to the user alone there.
- "View as": locking ends the simulation.
- A dialog with unsaved input open at lock time: lost unless it keeps a draft (with section 4, drafts survive).
- Existing users and live sessions: unaffected until someone sets a PIN. The migration only adds a table.

## 8. Build order

1. Server: table and migration, PIN set and verify with the attempt limit, the unlock proof, the check in auth,
   the endpoints, admin reset, tests.
2. Browser: the lock sequence (cover, wipe, reload, other tabs, idle, back/forward cache), lock screen, setup,
   top bar button, settings panel, admin action, e2e specs.
3. Encrypted local storage, if chosen.
4. Later, each on its own:
   - Touch ID, Face ID and Windows Hello unlock (passkeys), with the PIN as fallback. Faster and stronger than
     typing.
   - Remote lock that bites immediately on other devices, through the existing web push.
   - Private notifications while locked: a push shows "New notification" with no text.
   - Org policy: require a PIN for chosen roles, cap the auto-lock time.

## 9. Decisions (2026-09-26)

1. New sign-ins ask for the PIN. Without it, signing out and back in walks around the lock.
2. The lock button locks this browser; "Lock all my devices" lives in the settings panel.
3. Forgot PIN: an admin resets it. There is no self-service reset.
4. Drafts and cache: encrypted, and locking throws the key away.
5. 6 digits by default, 4 allowed. The auto-lock time is each person's own setting, in their app lock settings
   (15 minutes until they change it).
