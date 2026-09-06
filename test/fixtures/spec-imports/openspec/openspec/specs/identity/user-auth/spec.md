# User Auth Specification

Original fixture prose for Latchkit's test suite. This file lives under a
two-segment capability path (`identity/user-auth`) to exercise nested
capability directories.

## Purpose

Identity verification for the sample application used by this fixture.

## Requirements

### Requirement: Recovery Email Confirmation

The system SHALL require a confirmed recovery email before allowing a
password reset.

#### Scenario: Reset blocked without confirmation

- **WHEN** a user without a confirmed recovery email requests a reset
- **THEN** the request is refused with instructions to confirm an email first
