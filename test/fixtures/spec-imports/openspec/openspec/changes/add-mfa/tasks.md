## 1. Code Generation

- [ ] 1.1 Add a one-time-code generator in src/services/mfa-service.ts
- [x] 1.2 Store a per-account MFA secret alongside the account record

## 2. Sign-In Integration

- [ ] 2.1 Prompt for a one-time code when MFA is enabled
- [ ] 2.2 Wire the prompt to the generator; see [design](design.md) for the approach
