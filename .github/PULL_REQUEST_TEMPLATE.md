## What does this PR do?

<!-- Concise summary of the change and the problem it solves. -->

## Related issue(s)

<!-- Link any issues/discussions, or write "none". -->

## Definition of done

Before requesting review, confirm all of the following:

- [ ] **No regressions.** I ran the baseline (before) and post-change (after)
      tests for every file I touched and everything that imports them.
- [ ] **No performance glitches.** Any change to per-message/per-thread/per-frame
      work is measured (before/after numbers) or clearly justified.
- [ ] **Real feature.** I use this today, and it serves a group of people with
      the same problem. No vanity features.
- [ ] **Scoped verification passes.** `bun run check`, `bun run lint`,
      `bun run format`, and `bun run test` on the files I changed.
- [ ] **Engineering standards.** TypeScript strict (no `any`/`as any`),
      Svelte 5 idioms, no `console.*` (use the `Logger`), no checkbox inputs.
- [ ] **Documented.** User-facing behavior reflected in README/CHANGELOG where
      relevant.
- [ ] **No hidden destructive changes.** Removals, renames, or state-shape
      changes are called out explicitly here.

## How did you verify?

<!-- Include the exact commands you ran and before/after numbers for
performance-sensitive changes. -->

## Checklist

- [ ] I read `CONTRIBUTING.md` and `APP-BIBLE.md`.
- [ ] I committed contextually, scoped to my files, with a clear message.
