# Windows external file uploads with rsync preference

This fork adds Explorer-to-remote-panel uploads. Drop regular files on the remote panel background to upload into its current directory, or on a remote folder row to upload into that folder. Existing local-panel selections are ignored for this gesture.

On Windows, WebView2 passes OS-backed File objects to a small native bridge. The bridge resolves their actual paths without reading file contents into JavaScript or creating temporary copies. Tauri's native drag/drop handler stays disabled, preserving existing internal HTML5 drag/drop. The bridge accepts only the current main application origin, validates File objects and bounds pending work; filesystem metadata checks run off the UI thread.

Resolved paths enter the existing upload planner. SFTP external uploads keep the single-file command and its default delta attempt, including new or renamed files. Overwrite questions, Skip/Rename/Resume, staged transfers, retry callbacks and Stop continue through the existing machinery. A pending drop retains its original server and destination.

This is a preference, not a forced-rsync policy: the existing native engine settings and eligibility gates still apply. The server needs rsync and SSH execution. Small files below the existing 1 MiB threshold and unavailable delta transports can use normal transfer. Commit-backed GitHub/GitLab uploads and AeroVault sessions continue to use their dedicated upload UI; OS drops are refused for those sessions. Provider crypt overlays retain their existing encrypted transfer path. This patch handles external regular files; external folder drops are refused rather than silently misinterpreted.

## Validation

- TypeScript typecheck, production frontend build and focused Vitest tests cover external drop routing, bridge replies/timeouts, internal drag regression, and rsync-first single-file routing.
- Windows Drop Bridge CI compiles the exact production module against real Tauri/WebView2 interfaces and runs request/origin tests in a small harness. It does not emulate Explorer dragging.
- The real SSH/rsync test single_file_native_delta_overwrite_reuses_blocks_and_preserves_sha256 is in src-tauri/tests/integration_delta_sync.rs. It seeds an 8 MiB file, changes three 4 KiB areas while preserving size and mtime, invokes the single-file GUI delta adapter, and requires reused blocks, reduced wire bytes, progress and a matching remote SHA-256. It never invokes directory sync. Run it using the existing SFTP rsync Docker fixture.

Windows Explorer interaction and the real SSH fixture must be reported separately from unit and compile checks. A successful compile is not proof that a physical drop or a wire-level delta transfer was exercised.
