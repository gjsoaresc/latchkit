Original fixture prose for Latchkit's test suite. Delta spec for the `auth`
capability, describing what this change proposes to add.

## ADDED Requirements

### Requirement: MFA Gate On Sign-In

The system SHALL check whether an account requires a one-time code before
completing sign-in.

#### Scenario: MFA-enabled account is prompted

- **WHEN** an account with MFA enabled completes password sign-in
- **THEN** a one-time-code prompt is shown before the session is created
