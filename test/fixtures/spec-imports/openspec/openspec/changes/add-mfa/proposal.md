## Why

Original fixture prose for Latchkit's test suite. Some accounts hold
sensitive data and a password alone is not enough assurance for them.

## What Changes

Add an optional one-time-code step after password sign-in for accounts that
opt in. See the [research notes](research-notes.md) for the options that
were considered.

## Capabilities

### New Capabilities

- `mfa`: one-time-code verification after password sign-in

### Modified Capabilities

- `auth`: sign-in now checks whether MFA is required before completing

## Impact

Touches the sign-in flow and the session model; no other systems are
affected by this fixture change.
