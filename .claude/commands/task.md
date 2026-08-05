---
description: Implement a MASAR story from Notion by its reference, e.g. /task US-001
---

Implement story **$ARGUMENTS** from the MASAR Notion workspace.

## Step 1 — Retrieve
Find the story in the Tasks database by its Ref. Read the title, user story and full acceptance criteria.
If you cannot find it, or the acceptance criteria are missing or not testable, stop and report that. Do not guess at requirements.

## Step 2 — Check dependencies
For each story in `Depends on`, check its status. If any is not Done, stop and report which one is blocking.

## Step 3 — Plan
Before writing code, output which files you will create or change, which acceptance criterion each change satisfies, any migration required, and anything ambiguous that needs my decision.
Wait for my confirmation before continuing.

## Step 4 — Implement
Write the implementation, then tests mapping one-to-one onto the acceptance criteria, each named after the criterion it proves.
If the story touches a tenant-scoped endpoint, add the cross-tenant isolation test. Not optional.

## Step 5 — Verify
Run lint, typecheck and tests. Fix what you broke. Report pre-existing failures separately rather than silently fixing them.

## Step 6 — Report
List each acceptance criterion with the test that proves it, any criterion not satisfied and why, files changed, and migrations added.
Do not update the Notion status. I mark stories Done after review.
