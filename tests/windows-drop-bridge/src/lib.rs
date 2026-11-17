// Compile the real production module, including install/reply and its unit tests.
// A Windows host is required: this deliberately checks real WebView2 interfaces.
#![cfg(windows)]

#[path = "../../../src-tauri/src/windows_external_drop.rs"]
mod windows_external_drop;
