@AGENTS.md

# Project overview

A group vacation expense-splitting app (Splitwise-style): create a group, invite people, log shared expenses in any currency, see who owes whom, settle up. Built with Expo + React Native + TypeScript on the client, Supabase (Postgres + Auth + RLS) on the backend.

# Architecture conventions — follow these for new features

- **Any write that touches more than one table atomically goes through a `security definer` Postgres function in `supabase/schema.sql`, never sequential client-side inserts.** This is the app's central pattern (`create_group`, `create_log`, `settle_debt`, `leave_group`, `join_group`, `change_group_currency`, `delete_log`). The reason: a dropped connection between two separate client inserts can leave an orphaned/inconsistent row that RLS then hides from everyone, including its own creator. When adding a feature that writes to 2+ tables together, add a new RPC rather than two `.from(...)` calls.
- **Balances are always derived, never stored** — `src/utils/balances.ts`'s `calculateMemberBalances` computes everything from the log ledger, keyed by viewer perspective (positive = they owe you, negative = you owe them). The one stored number is `logs.converted_amount`, which exists purely so balance math doesn't require a live currency conversion on every read — it's always kept in terms of the group's *current* currency, rescaled atomically by `change_group_currency` whenever a group's currency changes. Never read `logs.amount` for balance math — that's the original entered amount/currency, for display only.
- **Group membership is soft-deleted** (`group_members.left_at`), never hard-deleted. `is_group_member()` checks `left_at is null`, which is what revokes a departed member's own access everywhere while leaving their historical logs/balances visible (grayed out) to everyone else. Rejoining reactivates the same row via `join_group`'s upsert rather than creating a new one. The one exception: if leaving drops a group to zero active members, `leave_group` deletes the group entirely (cascades via FK).
- **RLS is on for every table.** `is_group_member(group_id)` and `shares_group_with(user_id)` are `security definer` helper functions used throughout policies to avoid RLS-recursion issues. When a policy needs "am I active in this group," reuse `is_group_member`, don't reinvent it.
- **The currency list (`src/constants/currencies.ts`) is ISO 4217 filtered to what the exchange-rate API actually supports** — currently only `KPW` is excluded (open.er-api.com has no rate for it). If the API choice ever changes, re-diff the currency list against its supported codes before assuming coverage.
- **Confirm before anything irreversible.** There's no undo for a deleted log, a left/deleted group, or a settled debt from the UI — every such action gets an `Alert.alert` confirmation first.
- **Not-yet-built features route through `showComingSoon(feature)`** (`src/utils/coming-soon.ts`) rather than a silent no-op `onPress={() => {}}`.

# Known technical gotchas

- **`Alert.alert` and `Share.share` are no-ops on the web build.** Don't rely on Playwright clicking through a confirm dialog on web — verify that logic via direct `curl` calls to the Supabase RPC/REST API instead, or note that it needs on-device verification.
- **`src/lib/supabase.ts` disables session persistence when `typeof window === "undefined"`.** This is required — Expo Router pre-renders the web build in Node during dev/build, and the Supabase client's auto session-recovery on construction crashes the entire process without this guard.
- **`detectSessionInUrl` is deliberately `false`.** Password recovery links are parsed by hand in `src/app/reset-password.tsx` (the auth flow is `implicit`, so tokens arrive as a URL fragment, not a query param) — don't assume Supabase auto-handles the incoming recovery link.
- **`metro.config.js` adds `.mjs` to `resolver.sourceExts`** — required for `@supabase/supabase-js`'s dependency chain. Don't remove it.
- **Deep-linked screens need to work with no back-stack.** `src/utils/navigation.ts`'s `goBackOrToGroups()` falls back to the group list when `router.canGoBack()` is false — use it (not a bare `router.back()`) on any screen reachable via a deep link (invite links, password reset, etc).
- **`reset-password` is intentionally an ungated route** in `src/app/_layout.tsx` (outside both `Stack.Protected` blocks) since it can be reached before or after the client establishes its own session from the link's tokens.

# Testing / verification workflow

- **The Supabase CLI is linked to the live project** (`supabase login` + `supabase link` already done). Use `npx supabase db query --linked "..."` or `--file supabase/schema.sql` to run SQL directly — no need to relay SQL for the user to paste into the dashboard.
- **Verify features end-to-end against the real web build**, not just by reading code: start `npx expo start --web --port <unused port>`, sign up throwaway test accounts via `curl` against the Auth API, drive the UI with a scratch Playwright script, and check results via direct `curl`/`supabase db query` calls against the database. Clean up test accounts/groups/rows after.
- Always run `npx tsc --noEmit` and `npx eslint <changed files>` after a change, before considering it done.

# Current known gaps (deliberately deferred, not oversights)

- Logs can be deleted (`delete_log`, owner-only) but not edited.
- No "kick member" — only self-leave exists.
- "Promote to admin" (`src/app/group/[id].tsx`) is a pure client-side animation — there is no role/admin column anywhere in the schema, and no permission tiers exist. Every active member currently has equal power over a group.
- No profile picture upload — avatars are initials-only; the edit-mode camera badge is decorative.
- No push notifications or realtime updates. The "Notifications" and "Password" rows in Account Settings and the whole Scan tab show a "coming soon" alert.
- No offline handling — failed writes mostly just `console.warn`, with no user-facing error or rollback of optimistic UI updates (see `use-profile.tsx`).

# Deployment status

`app.json` is still fully placeholder (name "My App", slug "my-app", generic `scheme: "myapp"`, no `ios.bundleIdentifier`/`android.package`, default Expo icons) — none of this has been customized yet. Plan is TestFlight distribution (not the public App Store) for a small friend group: requires an Apple Developer Program enrollment ($99/yr, only the distributing developer needs one — testers just need the free TestFlight app and an invite link), then EAS Build setup, real app identity/icons, production env secrets, and adding the production redirect URL(s) to Supabase's Auth → Redirect URLs allow-list once a real `scheme` is chosen.
