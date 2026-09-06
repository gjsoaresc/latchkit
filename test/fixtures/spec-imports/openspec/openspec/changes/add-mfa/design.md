## Context

Original fixture prose for Latchkit's test suite. See
[proposal.md](proposal.md) for the motivation; it is not repeated here.

## Goals / Non-Goals

**Goals:**

- Let an account require a one-time code after password sign-in

**Non-Goals:**

- Hardware security keys (future fixture work, not this one)

## Decisions

### Decision: Time-based codes over SMS

Time-based one-time codes were chosen over SMS codes for this fixture
because they avoid a dependency on a carrier network.

## Risks / Trade-offs

A user who loses their code-generating device needs a recovery path; that
recovery path is out of scope for this fixture change.
