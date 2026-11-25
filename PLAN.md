# Fortress Rollback Plan

<!-- Claim format: - [ ] <outcome>. Claimed: <session> <ISO-8601>. Expires: <ISO-8601>. Exit: <criterion>. TTL <= 180 minutes. -->

> Active and ordered future work only. Put scope and discussion in the linked issue or skill,
> and put completed work and evidence in local, gitignored `progress/session-*.md` files (never commit them). See
> [Plan hygiene](.agents/skills/fortress-development/SKILL.md#plan-hygiene).

## In progress

- [ ] #559 Retry Python lease owner publication when a reaper moves the lock directory. Claimed: ses_deb2f847effe7tPlN9eLdOcovn 2026-11-25T22:27:15Z. Expires: 2026-11-26T01:27:15Z. Exit: deterministic pytest reproduces the reaper window, the lock retries within its deadline, and the Python and JS lock suites pass.

## Future

_None._
