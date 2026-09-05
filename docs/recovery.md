# Installer recovery

Latchkit records an exact transaction journal before changing registered project resources. Normal sync and removal stop when that journal or a stale lock indicates interrupted work.

Run `latchkit recover --dry-run --project <path>` first. It reports whether the owner is live, the manifest committed, files need rollback, or user edits conflict. The preview never removes a lock, journal, or project file. Run the same command without `--dry-run` to reclaim a proven stale lock and perform the reported recovery.

Pending transactions restore the journaled original bytes and modes. Committed transactions retain the new resources and remove completed metadata. Recovery can be repeated after an I/O failure. It never changes a resource whose bytes match neither recorded state.

Do not manually remove a live, invalid, or ambiguous lock. For malformed metadata, stop all Latchkit processes, preserve copies of `.latchkit/lock`, `.latchkit/transaction.json`, and `.latchkit/manifest.json`, and compare every journaled path with its recorded hashes. Only remove metadata after establishing the intended file and manifest state. Keep conflicting user files and request review rather than substituting either journal snapshot automatically.

The durability boundary is a local filesystem that honors exclusive creation, file synchronization, rename, and directory-entry persistence. Latchkit attempts parent-directory synchronization but some platforms and filesystems reject or ignore it. Hardware failure, noncompliant network storage, and hostile same-user processes are outside the guarantee.
