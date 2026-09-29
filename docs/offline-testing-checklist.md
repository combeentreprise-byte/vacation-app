# Offline support: on-device testing checklist

Built 2026-09-29. Tested end-to-end on the web build with the network cut (31 automated checks passed), but **not yet on a real phone**. This file is the list to work through on TestFlight.

## What works offline (and what doesn't)

| Works offline | Needs a connection (shows "You're offline") |
|---|---|
| Adding a new log entry | Settling a debt |
| Editing or deleting an entry that hasn't synced yet | Editing or deleting an entry that already synced |
| Changing your username | Creating or editing groups, changing group currency |
| Changing your profile picture | Joining, leaving, promoting, kicking |
| Browsing groups, members, logs, balances (last known state) | Password change, account deletion, sign-in |

How it works in one paragraph: the app keeps a copy of your groups, members, logs, profile and exchange rates on the phone. New entries and profile changes always go into a queue saved on the phone first, even when you're online, and the queue is sent to the server whenever it can be. It retries on reconnect, when the app comes to the foreground, when your login is renewed, and every 30 seconds while something is waiting.

## Where to test

- **Expo Go works only partly.** It loads the app's JavaScript from your computer's dev server. You can open the app online, then switch on airplane mode and test while it keeps running. You **can't** reliably test anything that starts the app offline: force-quit and reopen, or a cold start after a long time offline. Expo Go needs your computer to start the app.
- **TestFlight is the real test.** The JavaScript is built into the app, so cold starts offline behave exactly as they will for your friends. Everything in the checklist below should be done there.
- **You need a second account** for a few scenarios (marked 👥). Use the web build or a second phone for it.

## Checklist

### 1. Adding entries offline
- [ ] Open a group online, then switch on airplane mode. Add an entry. It appears immediately with a **"Waiting to sync"** marker.
- [ ] The group's balance summary already includes the new entry.
- [ ] Add an entry in a **different currency** from the group's (e.g. USD in a EUR group). It converts using the rate the phone saved earlier, with no error.
- [ ] Add an entry in a currency pair the phone has **never** converted. You should get a clear "no saved exchange rate" message, not a hang. (This should be rare: rates for each group's own currency are saved whenever you're online.)
- [ ] Pressing Submit while offline is instant. No long "Submitting..." spinner.

### 2. Restarting while offline
- [ ] With entries still waiting, **force-quit** the app and reopen it in airplane mode. You're still signed in, the groups load, and the waiting entries are still there with their marker.
- [ ] **Long offline cold start:** leave the app closed and offline for **more than 1 hour**, then open it offline. You should still be signed in, not sent to the sign-in screen.

### 3. Reconnecting
- [ ] Switch airplane mode off with the app open. Waiting entries sync within a few seconds and the marker disappears.
- [ ] After being offline **more than 1 hour**, syncing can take **up to about a minute** after reconnecting while Supabase renews your login. That's expected. It should still happen without reopening the app.
- [ ] 👥 On the second account, the synced entries appear with the **time you entered them**, not the time they synced.
- [ ] Put the app in the background while offline, reconnect, then bring it back to the foreground. It syncs on returning.
- [ ] Sync only runs while the app is open. There's no background sync, so entries made offline reach everyone else only the next time you open the app with a connection.

### 4. Changing entries that haven't synced
- [ ] Offline, edit an entry that's still waiting (amount, details, split). The change is kept and that's what syncs.
- [ ] Offline, delete an entry that's still waiting. It disappears and never reaches the server.
- [ ] Offline, try to edit or delete an entry that **already synced**. You get a "You're offline" alert, and the entry stays as it was.

### 5. Server rejects a waiting entry
- [ ] 👥 Offline on the phone, add an entry to a group. From the second (admin) account, kick the phone's account from that group. Reconnect. You get a **"An entry couldn't be saved"** alert naming the entry and the reason. The entry is dropped rather than retried forever.

### 6. Group currency changed while an entry waits
- [ ] 👥 Offline on the phone, add an entry to a EUR group. From the second (admin) account, change the group to USD. Reconnect. The synced entry's converted amount is in **USD** and the balances look right.

### 7. Profile offline
- [ ] Offline, change your **username**. It shows everywhere immediately, including your own tile in groups.
- [ ] Offline, change your **profile picture**. It shows immediately.
- [ ] **Force-quit and reopen offline.** The new name and picture are still shown. This is the main thing the web test couldn't cover: on the phone the picture is copied into the app's own storage.
- [ ] Reconnect. Both upload. 👥 The second account sees the new name and picture.
- [ ] Offline, change the picture **twice** before reconnecting. Only the last one should end up uploaded.

### 8. Sign-out warning
- [ ] With entries or profile changes still waiting, open **Account → Sign out**. It warns "Not synced yet: … Signing out now will lose them".
- [ ] With nothing waiting, no warning appears.

### 9. Online-only actions give a clear message
- [ ] Offline, try to settle a debt. You get a "Couldn't settle debt" / "You're offline" alert. (It used to fail silently.)

### 10. Flaky connection (optional, hard to trigger on purpose)
- [ ] On weak signal (a train, an elevator), add several entries. Once back on a good connection, each one appears **exactly once**, with no duplicates.

## Decisions worth revisiting after testing

- **Everything goes through the queue, even online.** Entries appear instantly, but "Waiting to sync" can flash briefly even with a good connection. If that looks odd, it could be hidden for the first second or two.
- **Rejected entries are dropped after the alert.** An alternative would be to keep them in a "failed" state with Retry / Discard buttons.
- **No offline banner.** The per-entry marker is the only offline hint right now.
- **Settlements aren't queued.** They could be, using the same pattern as entries, if this turns out to be missed on trips.

## Setup notes

- The database change (`create_log` taking three new parameters) is **already live**. Old app builds still work against it.
- Two new packages were added: `@react-native-community/netinfo` and `expo-crypto`. An EAS/TestFlight build picks them up automatically.
- Code to look at if something's off: `src/hooks/use-logs.tsx` (entry queue), `src/hooks/use-profile.tsx` (profile queue), `src/hooks/use-sync-triggers.ts` (when syncing is attempted), `src/utils/offline-storage.ts` (what's saved on the phone), and `src/hooks/use-auth.tsx` (staying signed in offline).
