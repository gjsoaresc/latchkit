Original fixture prose for Latchkit's test suite. Delta spec for the `auth`
capability, preserved as part of this archived change.

## ADDED Requirements

### Requirement: Recovery Second Factor

The system SHALL require a second factor to complete account recovery.

#### Scenario: Recovery requires a valid code

- **WHEN** a user completes the recovery form
- **THEN** a one-time code is required before recovery finishes
