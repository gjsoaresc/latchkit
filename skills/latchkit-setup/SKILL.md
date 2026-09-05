---
name: latchkit-setup
description: Inspect a repository and prepare scoped Latchkit guidance through provider adapters, with previews, conflict reporting, and preservation of existing user instructions.
---

# Latchkit setup

Prepare a project for the selected coding agents without changing the user's global configuration or weakening provider policy. Read the repository guidance and inspect bounded manifests and existing instruction roots before proposing changes.

## Inspect and preview

Use Latchkit's provider and rule-discovery interfaces to identify selected providers, supported skill destinations, project scopes, duplicate discovery roots, and existing instructions. Treat discovered commands as declared metadata; never run a project command merely to inspect it. Preview the exact skill and instruction changes with `sync --dry-run` before applying them.

Report provider capabilities and verification separately. An unavailable adapter or gate remains unavailable; setup must not infer authentication, trust, hook activation, or enforcement from an executable name or a generated file.

## Preserve user intent

Apply changes only through the managed transaction path after the preview is reviewed. Existing unowned files, edited managed files, conflicting guidance, symlinks, and shadowing roots must produce a reviewable conflict. Keep the original bytes and permissions; never silently overwrite, delete, rewrite global files, or create duplicate copies for compatible shared roots.

When multiple providers share `.agents/skills`, export it once and report that compatible tools may discover the same skill. When Claude and a shared-root provider coexist, report the duplicate visibility rather than pretending provider selection is an isolation boundary.

## Finish honestly

After an authorized sync, inspect the result and tell the user what was installed, what remains unverified, and how to reload the provider. If setup cannot proceed, leave the source untouched and report the exact conflict and recovery action. This workflow does not log in, enable hooks, change approval settings, or claim an agent live-discovered a skill without evidence.
