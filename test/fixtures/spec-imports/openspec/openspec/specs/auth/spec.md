# Auth Specification

This is original fixture prose written for Latchkit's test suite; it does
not reproduce any upstream OpenSpec example text.

## Purpose

Session handling for the sample application used by this fixture.

## Requirements

### Requirement: Idle Session Timeout

The system SHALL end a signed-in session after 20 minutes without
activity.

#### Scenario: Session expires after idle period

- **WHEN** 20 minutes pass without a request from a signed-in user
- **THEN** the session is invalidated and the next request requires sign-in

### Requirement: Manual Sign-Out

The system SHALL let a signed-in user end their own session immediately.

#### Scenario: User signs out

- **WHEN** a signed-in user selects sign-out
- **THEN** the session is invalidated right away
