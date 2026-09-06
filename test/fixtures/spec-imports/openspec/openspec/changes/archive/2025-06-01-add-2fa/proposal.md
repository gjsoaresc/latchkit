## Why

Original fixture prose for Latchkit's test suite. A second, later archived
change intentionally reuses the base name `add-2fa` (with a different date
prefix) to exercise duplicate-slug detection across archived changes.

## What Changes

Extend the earlier two-factor recovery work to a second account type.

## Capabilities

### Modified Capabilities

- `recovery-2fa`: also applies to the second account type

## Impact

Touches the account-recovery flow only.
