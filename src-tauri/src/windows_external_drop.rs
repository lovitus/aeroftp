// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2024-2026 axpnet: AI-assisted (see AI-TRANSPARENCY.md)

//! Resolve OS-backed HTML5 File objects without enabling Tauri's native DnD handler.
//! This is deliberately separate from Tauri IPC and never consumes JavaScript paths.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::{Emitter, Manager, WebviewWindow};
use url::Url;
use webview2_com::{
    CoTaskMemPWSTR,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
        ICoreWebView2WebMessageReceivedEventArgs2,
    },
    WebMessageReceivedEventHandler,
};
use windows_core::{Interface, PWSTR};

const KIND: &str = "aeroftp.external-drop.resolve";
const EVENT: &str = "aeroftp:external-drop-resolved";
const MAX_FILES: u32 = 1024;
const MAX_PENDING: usize = 8;
const MAX_MESSAGE_UNITS: usize = 4096;
const MAX_PATH_UNITS: usize = 32767;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    kind: String,
    version: u32,
    request_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Resolved {
    request_id: String,
    paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

fn parse_request(message: &str) -> Option<Request> {
    let request: Request = serde_json::from_str(message).ok()?;
    (request.kind == KIND
        && request.version == 1
        && !request.request_id.is_empty()
        && request.request_id.len() <= 128
        && request
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then_some(request)
}

// Every getter below returns CoTaskMem-allocated UTF-16. Own it even on a failed
// HRESULT, and bound the scan before allocating a Rust string. Reject invalid
// UTF-16 rather than silently changing a filesystem path.
fn com_string(
    getter: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>,
    max_units: usize,
) -> Result<String, &'static str> {
    let mut raw = PWSTR::null();
    let result = getter(&mut raw);
    let _owned = CoTaskMemPWSTR::from(raw);
    result.map_err(|_| "webview2_read_failed")?;
    if raw.is_null() {
        return Err("empty_value");
    }
    // SAFETY: a successful WebView2 string getter supplies a NUL-terminated
    // UTF-16 allocation. _owned keeps it alive and frees it on every return path.
    unsafe {
        for len in 0..=max_units {
            if *raw.0.add(len) == 0 {
                return String::from_utf16(std::slice::from_raw_parts(raw.0, len))
                    .map_err(|_| "invalid_unicode");
            }
        }
    }
    Err("value_too_long")
}

fn trusted_source(source: &str, current: &str, trusted: &Url) -> bool {
    let (Ok(source), Ok(current)) = (Url::parse(source), Url::parse(current)) else {
        return false;
    };
    source.origin() == trusted.origin()
        && current.origin() == trusted.origin()
        && source.username().is_empty()
        && source.password().is_none()
        && source == current
}

fn resolve_files(
    args: &ICoreWebView2WebMessageReceivedEventArgs,
) -> Result<Vec<String>, &'static str> {
    let args: ICoreWebView2WebMessageReceivedEventArgs2 =
        args.cast().map_err(|_| "additional_objects_unavailable")?;
    // SAFETY: COM interfaces are used only on the WebView2 UI callback thread.
    unsafe {
        let objects = args
            .AdditionalObjects()
            .map_err(|_| "additional_objects_unavailable")?;
        let mut count = 0;
        objects.Count(&mut count).map_err(|_| "invalid_files")?;
        if count == 0 || count > MAX_FILES {
            return Err("invalid_file_count");
        }
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            // Null/undefined entries fail GetValueAtIndex; every other non-File
            // object fails QueryInterface. Never fall back to JSON or filenames.
            let file: ICoreWebView2File = objects
                .GetValueAtIndex(index)
                .and_then(|object| object.cast())
                .map_err(|_| "invalid_file_object")?;
            let path = com_string(|value| file.Path(value), MAX_PATH_UNITS)?;
            let filesystem_path = Path::new(&path);
            if path.is_empty() || !filesystem_path.is_absolute() {
                return Err("invalid_file_path");
            }
            // Preserve exact spelling/order (including Unicode, spaces and UNC).
            paths.push(path);
        }
        Ok(paths)
    }
}

fn receive(
    sender: &ICoreWebView2,
    args: &ICoreWebView2WebMessageReceivedEventArgs,
    trusted: &Url,
) -> Option<(Resolved, String)> {
    // Check both message source and current top-level document: navigating main
    // to an external site must never inherit this bridge's filesystem access.
    let source = com_string(|value| unsafe { args.Source(value) }, MAX_PATH_UNITS).ok()?;
    let current = com_string(|value| unsafe { sender.Source(value) }, MAX_PATH_UNITS).ok()?;
    if !trusted_source(&source, &current, trusted) {
        return None;
    }
    let message = com_string(
        // Wry handles this event first and requires a string message too.
        |value| unsafe { args.TryGetWebMessageAsString(value) },
        MAX_MESSAGE_UNITS,
    )
    .ok()?;
    let request = parse_request(&message)?;
    let (paths, error) = match resolve_files(args) {
        Ok(paths) => (paths, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    Some((
        Resolved {
            request_id: request.request_id,
            paths,
            error,
        },
        source,
    ))
}

// Keep filesystem metadata off the WebView2 UI thread: a disconnected UNC share
// can block stat. Revalidate the top-level document on the UI thread before any
// asynchronous reply, so a navigation cannot receive the former page's paths.
fn reply(app: tauri::AppHandle, trusted: Url, source: String, payload: Resolved) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(move |platform| {
        let Ok(webview) = (unsafe { platform.controller().CoreWebView2() }) else {
            return;
        };
        let Ok(current) = com_string(|value| unsafe { webview.Source(value) }, MAX_PATH_UNITS)
        else {
            return;
        };
        if trusted_source(&source, &current, &trusted) {
            if let Err(error) = app.emit_to("main", EVENT, payload) {
                log::warn!("External file drop reply failed: {error}");
            }
        }
    });
}

struct Pending(Arc<AtomicUsize>);

impl Drop for Pending {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

pub fn install(window: &WebviewWindow) {
    if window.label() != "main" {
        return;
    }
    // Match main's WebviewUrl::App and its default HTTP custom-protocol scheme.
    // Dev gets the configured exact origin, never a wildcard localhost rule.
    #[cfg(dev)]
    let trusted = window.config().build.dev_url.clone();
    #[cfg(not(dev))]
    let trusted = Url::parse("http://tauri.localhost").ok();
    let Some(trusted) = trusted else {
        log::warn!("External file drop bridge has no trusted app URL");
        return;
    };
    let app = window.app_handle().clone();
    let pending = Arc::new(AtomicUsize::new(0));
    if let Err(error) = window.with_webview(move |platform| {
        // Add a listener alongside Wry/Tauri IPC. Do not replace postMessage,
        // subscribe to frame events, or enable the native drag/drop handler.
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|webview| {
                let handler =
                    WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
                        if let (Some(sender), Some(args)) = (sender, args) {
                            if let Some((mut payload, source)) = receive(&sender, &args, &trusted) {
                                let app = app.clone();
                                let trusted = trusted.clone();
                                if payload.error.is_some() {
                                    reply(app, trusted, source, payload);
                                } else if pending
                                    .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                                        (count < MAX_PENDING).then_some(count + 1)
                                    })
                                    .is_err()
                                {
                                    payload.paths.clear();
                                    payload.error = Some("too_many_requests");
                                    reply(app, trusted, source, payload);
                                } else {
                                    let guard = Pending(Arc::clone(&pending));
                                    tauri::async_runtime::spawn_blocking(move || {
                                        let _guard = guard;
                                        if payload
                                            .paths
                                            .iter()
                                            .any(|path| !Path::new(path).is_file())
                                        {
                                            payload.paths.clear();
                                            payload.error = Some("not_a_regular_file");
                                        }
                                        reply(app, trusted, source, payload);
                                    });
                                }
                            }
                        }
                        Ok(())
                    }));
                // WebView2 owns the handler reference until the view is closed.
                let mut token = 0;
                webview.add_WebMessageReceived(&handler, &mut token)
            })
        };
        if let Err(error) = result {
            log::warn!("External file drop bridge registration failed: {error}");
        }
    }) {
        log::warn!("External file drop bridge dispatch failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_closed_and_bounded() {
        let valid =
            r#"{"kind":"aeroftp.external-drop.resolve","version":1,"requestId":"drop_123-abc"}"#;
        assert!(parse_request(valid).is_some());
        for invalid in [
            valid.replace("drop_123-abc", ""),
            valid.replace("drop_123-abc", &"a".repeat(129)),
            valid.replace("drop_123-abc", "../path"),
            valid.replace(r#""version":1"#, r#""version":2"#),
            valid.replace("external-drop.resolve", "other"),
            valid.replace(r#""requestId""#, r#""paths""#),
            valid.replace("}", r#","paths":["C:/secret"]}"#),
        ] {
            assert!(parse_request(&invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn only_the_current_trusted_top_level_url_is_accepted() {
        let trusted = Url::parse("http://tauri.localhost").unwrap();
        let main = "http://tauri.localhost/index.html";
        assert!(trusted_source(main, main, &trusted));
        for other in [
            "https://example.com/index.html",
            "http://tauri.localhost.evil/index.html",
            "http://tauri.localhost:8080/index.html",
            "http://user@tauri.localhost/index.html",
            "http://tauri.localhost/other.html",
            "null",
        ] {
            assert!(!trusted_source(other, main, &trusted));
            assert!(!trusted_source(main, other, &trusted));
        }
    }
}
