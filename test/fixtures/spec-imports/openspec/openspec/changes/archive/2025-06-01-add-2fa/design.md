## Context

Original fixture prose for Latchkit's test suite.

## Goals / Non-Goals

**Goals:**

- Extend recovery 2FA to the second account type

**Non-Goals:**

- Any change to the first account type's behavior

## Decisions

### Decision: Same code generator, second account type

No new generator is needed; the existing one is parameterized by account
type.

## Risks / Trade-offs

None significant for this fixture.
