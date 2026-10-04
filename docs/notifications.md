# Notifications

Every notification the app sends, who gets it, and its wording. The switch each one belongs to is in `src/constants/notifications.ts` (Account → Notifications). All of them are written by the database (`notify()` and its callers in `supabase/schema.sql` — see the notifications note in CLAUDE.md for where each comes from) and pushed by the `send-notifications` Edge Function; keep this list and the SQL in sync. Phones can't receive them until EAS and a development build are set up (CLAUDE.md, "Waiting on the Apple Developer account").

Examples use *Anna* (who did it), *you* (who gets it) and the group *Lisbon Trip*. Amounts are written like the Logs tab: in the group's currency, `45 EUR`. Dates like the rest of the app: `12 Oct` (with the year only when it isn't this year).

**Title** is the bold first line, **Body** the text below it. Tapping opens what's in **Opens**.

General rules:

- Nobody is ever notified about something they did themselves.
- Only active members of a group get its notifications (someone who left gets nothing more from it — except the one telling them they were removed).
- "Turn off all notifications" silences everything except the *Always* ones.
- Several of the same kind from the same group within a few minutes are merged into one (e.g. "Anna added 3 entries" — see the merged wording below each).

---

## Entries

### Entries with you (`myExpenses`, on by default)

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| E1 | Someone adds an entry you're part of | Everyone in the split except the payer | Lisbon Trip | Anna paid 45 EUR for "Dinner" — your share is 11.25 EUR | The group |
| E1b | …same, but the entry has no description | 〃 | Lisbon Trip | Anna paid 45 EUR — your share is 11.25 EUR | The group |
| E1m | Merged: several entries from the same payer | 〃 | Lisbon Trip | Anna added 3 entries with you — your share is 34.50 EUR | The group |
| E2 | The payer edits an entry you're part of, and your share changes | Everyone in the split after the edit (who was also in it before) | Lisbon Trip | Anna changed "Dinner" — your share is now 15 EUR (was 11.25 EUR) | The group |
| E2b | …the edit doesn't change your share (only description etc.) | — | *(not sent)* | | |
| E3 | The payer adds you to an existing entry | Newly added people | Lisbon Trip | Anna added you to "Dinner" — your share is 11.25 EUR | The group |
| E4 | The payer takes you off an entry | Removed people | Lisbon Trip | Anna took you off "Dinner" — you no longer owe a share of it | The group |
| E5 | The payer deletes an entry you were part of | Everyone who was in the split | Lisbon Trip | Anna deleted "Dinner" (45 EUR) — your 11.25 EUR share is gone from your balance | The group |
| E5b | …same, entry without a description | 〃 | Lisbon Trip | Anna deleted an entry (45 EUR) — your 11.25 EUR share is gone from your balance | The group |

Entries typed offline arrive when the payer's phone syncs; they're notified then, with the same wording (no "earlier today" note).

### Settling up (`settlements`, on by default)

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| S1 | Someone records that they paid you back | The person paid | Lisbon Trip | Anna paid you back 30 EUR — you're all square | The group |
| S2 | Someone you owe marks your debt as paid (they record receiving it) | The person who owed | Lisbon Trip | Anna marked your 30 EUR debt as paid — you're all square | The group |
| S3 | Someone deletes a settle-up they recorded paying you | The person who was paid back | Lisbon Trip | Anna deleted their 30 EUR settle-up with you — it's no longer in your balance | The group |

("You're all square" only when the balance between the two is now zero, which is always the case from the app; otherwise the sentence stops after the amount.)

### All other entries (`otherExpenses`, off by default)

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| O1 | Someone adds an entry you're not part of | Active members not in the split | Lisbon Trip | Anna paid 45 EUR for "Dinner", split with Ben and Carl | The group |
| O1m | Merged | 〃 | Lisbon Trip | Anna added 3 entries (120 EUR) | The group |
| O2 | Two other members settle up | Everyone else | Lisbon Trip | Anna paid Ben back 30 EUR | The group |

Edits and deletions of entries you're not part of aren't sent.

---

## Groups

### About you (`aboutMe`, on by default)

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| A1 | An admin makes you an admin | You | Lisbon Trip | Anna made you an admin — you can now edit the group and manage its members | The group |
| A2 | The only admin leaves and you're next in line | You | Lisbon Trip | Anna left, so you're now an admin — you can edit the group and manage its members | The group |
| A3 | The sponsor removes you as admin | You | Lisbon Trip | Anna removed you as admin | The group |
| A4 | The sponsor leaves (or deletes their account) and the role goes to you | You | You're now the sponsor of Lisbon Trip | Anna left the group, so you've taken over as sponsor — you manage its pass and its seats | The group |
| A4b | …and the pass hasn't started, and you were given a seat | You | You're now the sponsor of Lisbon Trip | Anna left the group, so you've taken over as sponsor and got their seat on the pass that starts on 12 Oct | Group plan |
| A4c | …and the pass hasn't started, but it's full and you have no seat | You | You're now the sponsor of Lisbon Trip | Anna left, so you're the sponsor now. The pass starting on 12 Oct is full — take a seat back from someone and give it to yourself before then | Group plan |
| A5 | An admin removes you from the group | You | Removed from Lisbon Trip | Anna removed you from the group. Your past entries stay, and an invite link brings you back | The group list |
| A5b | …and you had a seat on a pass that hasn't started | You | Removed from Lisbon Trip | Anna removed you from the group, and your seat on its pass went back to the group | The group list |

### Members (`members`, on by default)

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| M1 | Someone joins | Everyone else in the group | Lisbon Trip | Anna joined the group | The group |
| M1b | Someone who left comes back | 〃 | Lisbon Trip | Anna is back in the group | The group |
| M1m | Merged: several join | 〃 | Lisbon Trip | Anna, Ben and 2 others joined the group | The group |
| M2 | Someone leaves | Everyone still in the group | Lisbon Trip | Anna left the group | The group |
| M2b | …because they deleted their account | 〃 | Lisbon Trip | Anna deleted their account and left the group. Their past entries stay, as "Deleted user" | The group |
| M3 | An admin removes someone | Everyone except the admin and the one removed | Lisbon Trip | Anna removed Ben from the group | The group |

### Group changes (`groupChanges`, on by default)

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| G1 | An admin renames the group | Everyone else | Lisbon Trip | Anna renamed "Portugal" to "Lisbon Trip" | The group |
| G2 | An admin changes the description | 〃 | Lisbon Trip | Anna changed the group's description | The group |
| G3 | An admin changes the photo | 〃 | Lisbon Trip | Anna changed the group's photo | The group |
| G3b | …or removes it | 〃 | Lisbon Trip | Anna removed the group's photo | The group |
| G4 | An admin changes the currency | 〃 | Lisbon Trip | Anna changed the group's currency from EUR to USD — all balances are now in USD | The group |
| G5 | An admin makes someone else an admin | Everyone except the two of them | Lisbon Trip | Anna made Ben an admin | The group |
| G6 | Someone becomes admin because the last admin left | Everyone except the new admin | Lisbon Trip | Ben is now an admin, since Anna left | The group |
| G7 | The sponsor removes someone as admin | Everyone except the two of them | Lisbon Trip | Anna removed Ben as admin | The group |
| G8 | The sponsor role passes to someone else | Everyone except the new sponsor | Lisbon Trip | Ben is now the group's sponsor, since Anna left | The group |
| G9 | The sponsor leaves and nobody can take over (everyone left has given it up before) | Admins | Lisbon Trip | Anna left and the group has no sponsor now — admins manage its pass | The group |

---

## Plans

Hidden from the settings (and never sent) while plans are hidden (`plansVisible`).

### Passes and seats (`plans`, on by default)

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| P1 | Someone sets up a group pass and gives you a seat | Seat holders except the sponsor | Lisbon Trip is unlocked | Anna set up a Trip Pass and gave you a seat — you can add entries until 26 Oct | The group |
| P1b | …that starts later | 〃 | Lisbon Trip | Anna set up a Trip Pass starting on 12 Oct and gave you a seat — you'll be unlocked until 26 Oct | The group |
| P2 | Someone sets up a group pass, and you don't have a seat | Everyone else in the group | Lisbon Trip | Anna set up a Trip Pass for the group — 5 of 8 seats are still free. Ask Anna for one | Group plan |
| P2b | …and all seats are taken | 〃 | Lisbon Trip | Anna set up a Trip Pass for the group (all 8 seats are taken) | The group |
| P3 | You're given a seat on a pass that's already set up | You | Lisbon Trip | Anna gave you a seat on the group's Trip Pass — you can add entries until 26 Oct | The group |
| P3b | …on one that starts later | You | Lisbon Trip | Anna gave you a seat on the group's Trip Pass — you'll be unlocked from 12 Oct to 26 Oct | The group |
| P4 | Your seat is taken back before the pass starts | You | Lisbon Trip | Anna took back your seat on the group's Trip Pass — you won't be unlocked when it starts on 12 Oct | Group plan |
| P5 | Someone with a seat leaves before the pass starts, so their seat is free again | Whoever manages the pass (the sponsor, or the admins if there's none) | Lisbon Trip | Anna left, so their seat on the Trip Pass is free again — 3 of 8 seats free | Group plan |
| P6 | Someone joins a group whose pass has free seats and they aren't unlocked | Whoever manages the pass | Lisbon Trip | Ben joined and isn't unlocked — you have 3 free seats on the Trip Pass | Group plan |
| P7 | The pass's start date is moved | Seat holders except whoever moved it | Lisbon Trip | Anna moved the Trip Pass — it now runs from 14 Oct to 28 Oct | Group plan |
| P8 | The pass gets more seats (upgraded to a bigger size) | Members without a seat | Lisbon Trip | The Trip Pass now has 15 seats, 7 of them free — ask Anna for one | Group plan |
| P9 | The pass is lengthened from 1 week to 2 weeks | Seat holders except the sponsor | Lisbon Trip | Anna extended the Trip Pass — you're unlocked until 2 Nov now | The group |
| P10 | A pass set up to start later starts | Seat holders | Lisbon Trip is unlocked | The Trip Pass has started — you can add entries until 26 Oct | The group |

### Reminders (`reminders`, on by default)

"Your pass" covers a seat on anyone's pass, including *Just me*. None of the "ending" reminders is sent when something else keeps you unlocked past that date (another pass, or a renewing subscription — same rule as `unlocked_on`).

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| R1 | Your group pass ends in 2 days | Seat holders | Your Trip Pass ends in 2 days | Lisbon Trip's pass runs until 26 Oct. After that, adding entries needs a new unlock — settling up always works | The group |
| R1b | Your *Just me* pass ends in 2 days | You | Your Trip Pass ends in 2 days | It runs until 26 Oct. After that, adding entries needs a new unlock — settling up always works | Plans |
| R2 | A pass you bought for a group (but have no seat on) ends in 2 days | The sponsor | Lisbon Trip's Trip Pass ends in 2 days | It runs until 26 Oct | Group plan |
| R3 | Your pass has ended | Seat holders, and the sponsor | Your Trip Pass has ended | Lisbon Trip's pass ended. Your entries and balances stay — unlock again to add new ones | Paywall |
| R3b | …*Just me* | You | Your Trip Pass has ended | Your entries and balances stay — unlock again to add new ones | Paywall |
| R4 | Your subscription renews in 2 days (the one `/paywall` promises) | The subscriber | Your subscription renews in 2 days | Your monthly subscription renews on 12 Oct for 3.99 EUR. You can cancel it until then | Subscription |
| R4b | …yearly | 〃 | Your subscription renews in 2 days | Your yearly subscription renews on 12 Oct for 29.99 EUR. You can cancel it until then | Subscription |
| R5 | Your cancelled subscription ends in 2 days | The subscriber | Your subscription ends in 2 days | You're unlocked until 12 Oct. Resume it to stay unlocked | Subscription |
| R6 | Your cancelled subscription has ended | The subscriber | Your subscription has ended | Your entries and balances stay — unlock again to add new ones | Paywall |
| R7 | A Trip Pass you bought still isn't set up, 3 days after buying it (once) | The buyer | Your Trip Pass is ready | Set it up to choose your group and when it starts — it won't count down until you do | Plan setup |
| R8 | A group pass starts tomorrow and still has free seats | Whoever manages it | Lisbon Trip's Trip Pass starts tomorrow | 3 of 8 seats are still free — give them out so everyone's unlocked from the start | Group plan |
| R9 | A member's unlock ends while the group's pass is still running and has free seats | Whoever manages it | Lisbon Trip | Ben's unlock ends on 20 Oct, before the Trip Pass does — give them a seat to keep them unlocked | Group plan |
| R10 | A group has 3 free entries left | Members who aren't unlocked | Lisbon Trip | 3 free entries left in this group. Unlock to keep adding entries once they're used | Paywall |
| R11 | A group has used all its free entries | Members who aren't unlocked | Lisbon Trip | All 15 free entries in this group are used. Unlock to keep adding entries | Paywall |

Once real store payments exist, also:

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| R12 | A renewal payment failed | The subscriber | Your subscription couldn't renew | Check your payment method in the App Store / Google Play to stay unlocked | Subscription |
| R13 | A purchase was refunded | The buyer (and seat holders on a group pass) | Your Trip Pass was refunded | It has ended — your entries and balances stay | Plans |

---

## Always (can't be turned off)

| # | When | Who gets it | Title | Body | Opens |
|---|---|---|---|---|---|
| X1 | Your password was changed | You, on your other devices | Your password was changed | If this wasn't you, reset your password right away | Account |

---

## Deliberately not sent

- Anything you did yourself, including your own purchases and seat changes you made.
- Creating a group (you're the only one in it).
- A group deleted because its last member left (nobody's left to tell).
- Leaving a group yourself, or giving up your own seat by leaving.
- An entry edit that doesn't change your share.
- Edits/deletions of entries you're not part of.
- Successful subscription renewals (the store already sends a receipt).
- Entries held for an unlock on your own phone — the app shows that itself when it's open.

## Not covered by the wording above

- **R4's price** comes from `notification_subscription_price` in `schema.sql`, a copy of the placeholder `PLAN_PRICES`.
- **Entries open the group**, not the entry itself: the group screen can't open on one entry from a link yet.
