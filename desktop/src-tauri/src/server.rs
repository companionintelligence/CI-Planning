//! The server address: how what the person typed becomes a URL, whether a Planning server
//! answers there, and the one copy kept on this machine. The rules mirror
//! `client/src/lib/server-config.ts`, so the desktop app and the phone shells accept the same
//! addresses and refuse the same ones.

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Url};

const SAVED_FILE: &str = "server.json";
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Why an address cannot be used. The three are kept apart because each one sends the person
/// to a different fix.
#[derive(Debug, PartialEq, Eq)]
pub enum Problem {
    /// Not a web address at all.
    Invalid,
    /// Nothing answered: check the address, the network, and that the server is running.
    Unreachable,
    /// Something answered, but it is not a Companion Planning server.
    NotPlanning,
}

impl Problem {
    pub fn message(&self) -> String {
        match self {
            Problem::Invalid => String::from(
                "That is not a web address this app can use. Try planning.example.com, or 192.168.1.20:3848.",
            ),
            Problem::Unreachable => String::from(
                "Nothing answered at that address. Check the address and your network, and that the server is running.",
            ),
            Problem::NotPlanning => String::from(
                "Something answered at that address, but it is not a Companion Planning server.",
            ),
        }
    }
}

/// Turn what was typed into a canonical server URL, or `None` if it cannot be one.
///
///   192.168.1.20:3848      → http://192.168.1.20:3848   (bare LAN address ⇒ plain http)
///   planning.example.com   → https://planning.example.com
///   https://x.y/planning/  → https://x.y/planning       (path prefix kept, trailing slash dropped)
///
/// Only http(s) is accepted. Query strings and fragments are dropped, and an address carrying
/// credentials is refused: they do not belong in a stored address.
pub fn normalize(input: &str) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let candidate = if has_scheme(raw) {
        raw.to_string()
    } else {
        let scheme = if looks_local(&bare_host(raw)) {
            "http"
        } else {
            "https"
        };
        format!("{scheme}://{raw}")
    };
    let url = Url::parse(&candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().unwrap_or("").is_empty() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    Some(format!("{}{}", url.origin().ascii_serialization(), path))
}

/// True when the text starts with a scheme, as in `https://`.
fn has_scheme(raw: &str) -> bool {
    match raw.find("://") {
        Some(end) => {
            let scheme = &raw[..end];
            scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        None => false,
    }
}

/// The host a person typed without a scheme, with any port and path taken off.
fn bare_host(raw: &str) -> String {
    let authority = raw.split(['/', '?', '#']).next().unwrap_or_default();
    let without_port = match authority.rfind(':') {
        Some(i)
            if i + 1 < authority.len()
                && authority[i + 1..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            &authority[..i]
        }
        _ => authority,
    };
    without_port
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string()
}

/// Hosts a person types without a scheme that are almost certainly on their own network.
fn looks_local(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "localhost"
        || h.ends_with(".local")
        || h.ends_with(".lan")
        || h.ends_with(".home.arpa")
        || !h.contains('.') // a single-label name, or an IPv6 literal
        || is_ipv4_literal(&h)
}

fn is_ipv4_literal(h: &str) -> bool {
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Check that `base` is a reachable Planning server before it is saved. Both endpoints are
/// public: `/api/health` must answer `{ "ok": true }`, and `/api/auth/config` must carry an
/// auth `mode`. The request is made natively, so the server's CORS policy does not apply.
pub async fn probe(base: &str) -> Result<(), Problem> {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|_| Problem::Unreachable)?;

    let (ok, body) = get_json(&client, base, "/api/health").await?;
    if !ok || body.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(Problem::NotPlanning);
    }

    let (ok, body) = get_json(&client, base, "/api/auth/config").await?;
    if !ok || body.get("mode").and_then(Value::as_str).is_none() {
        return Err(Problem::NotPlanning);
    }
    Ok(())
}

/// One GET. A transport failure or a 5xx means nothing Planning-shaped is there, so it is
/// `Unreachable`. Any other answer comes back as whether it succeeded, with its body parsed as
/// JSON (`Null` when it is not JSON).
async fn get_json(
    client: &reqwest::Client,
    base: &str,
    path: &str,
) -> Result<(bool, Value), Problem> {
    let response = client
        .get(format!("{base}{path}"))
        .send()
        .await
        .map_err(|_| Problem::Unreachable)?;
    let status = response.status();
    if status.is_server_error() {
        return Err(Problem::Unreachable);
    }
    let body = response
        .text()
        .await
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    Ok((status.is_success(), body))
}

#[derive(Serialize, Deserialize)]
struct Saved {
    url: String,
}

/// The file that holds the saved address inside the settings folder `dir`.
fn saved_file(dir: &Path) -> PathBuf {
    dir.join(SAVED_FILE)
}

/// The address saved in the settings folder `dir`. It goes through `normalize` again, so a
/// hand-edited file cannot hold anything the connect page would have refused.
fn load_from(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(saved_file(dir)).ok()?;
    let saved: Saved = serde_json::from_str(&text).ok()?;
    normalize(&saved.url)
}

/// Save `url` in the settings folder `dir`, creating the folder if it is missing.
fn save_to(dir: &Path, url: &str) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("Could not create the settings folder: {error}"))?;
    let json = serde_json::to_string_pretty(&Saved {
        url: url.to_string(),
    })
    .map_err(|error| error.to_string())?;
    fs::write(saved_file(dir), json)
        .map_err(|error| format!("Could not save the server address: {error}"))
}

fn settings_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// The address saved for this app, if one has been chosen and it still passes `normalize`.
pub fn load_saved(app: &AppHandle) -> Option<String> {
    load_from(&settings_dir(app)?)
}

pub fn save(app: &AppHandle, url: &str) -> Result<(), String> {
    let dir = settings_dir(app)
        .ok_or_else(|| String::from("This system has no settings folder for the app."))?;
    save_to(&dir, url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_documented_forms() {
        assert_eq!(
            normalize("192.168.1.20:3848").as_deref(),
            Some("http://192.168.1.20:3848")
        );
        assert_eq!(
            normalize("planning.example.com").as_deref(),
            Some("https://planning.example.com")
        );
        assert_eq!(
            normalize("https://x.y/planning/").as_deref(),
            Some("https://x.y/planning")
        );
        assert_eq!(
            normalize("http://localhost:3848/?q=1#frag").as_deref(),
            Some("http://localhost:3848")
        );
        assert_eq!(normalize("myserver").as_deref(), Some("http://myserver"));
        assert_eq!(
            normalize("nas.lan:3848").as_deref(),
            Some("http://nas.lan:3848")
        );
        assert_eq!(
            normalize("[::1]:3848").as_deref(),
            Some("http://[::1]:3848")
        );
    }

    #[test]
    fn plain_http_without_a_scheme_is_only_for_the_local_network() {
        assert_eq!(
            normalize("planning.ts.net").as_deref(),
            Some("https://planning.ts.net")
        );
        assert_eq!(
            normalize("192.168.1.20").as_deref(),
            Some("http://192.168.1.20")
        );
        assert_eq!(
            normalize("http://planning.example.com").as_deref(),
            Some("http://planning.example.com")
        );
    }

    #[test]
    fn refuses_what_is_not_a_server_address() {
        assert_eq!(normalize(""), None);
        assert_eq!(normalize("   "), None);
        assert_eq!(normalize("ftp://files.example.com"), None);
        assert_eq!(normalize("https://user:secret@planning.example.com"), None);
        assert_eq!(normalize("https://"), None);
    }

    /// A stand-in Planning server on a loopback port. It answers `/api/health` and
    /// `/api/auth/config` with the given bodies, and 404 for anything else.
    fn fake_server(health: &'static str, config: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = listener.local_addr().expect("local address").port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buffer = [0u8; 2048];
                let read = std::io::Read::read(&mut stream, &mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = match path.as_str() {
                    "/api/health" => ("200 OK", health),
                    "/api/auth/config" => ("200 OK", config),
                    _ => ("404 Not Found", "<html>not here</html>"),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn probe_accepts_a_planning_server() {
        let base = fake_server(r#"{"ok":true}"#, r#"{"mode":"standalone"}"#);
        assert_eq!(tauri::async_runtime::block_on(probe(&base)), Ok(()));
    }

    #[test]
    fn probe_refuses_a_web_server_that_is_not_planning() {
        let not_json = fake_server("<html>hello</html>", r#"{"mode":"standalone"}"#);
        assert_eq!(
            tauri::async_runtime::block_on(probe(&not_json)),
            Err(Problem::NotPlanning)
        );
        let no_mode = fake_server(r#"{"ok":true}"#, "<html>sign in</html>");
        assert_eq!(
            tauri::async_runtime::block_on(probe(&no_mode)),
            Err(Problem::NotPlanning)
        );
    }

    #[test]
    fn probe_reports_nothing_listening_as_unreachable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = listener.local_addr().expect("local address").port();
        drop(listener); // the port is closed again before the probe runs
        let base = format!("http://127.0.0.1:{port}");
        assert_eq!(
            tauri::async_runtime::block_on(probe(&base)),
            Err(Problem::Unreachable)
        );
    }

    #[test]
    fn a_saved_address_round_trips_and_is_checked_on_the_way_back() {
        let dir =
            std::env::temp_dir().join(format!("companion-planning-desktop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(load_from(&dir), None);

        save_to(&dir, "https://planning.example.com/app").expect("save the address");
        assert_eq!(
            load_from(&dir).as_deref(),
            Some("https://planning.example.com/app")
        );

        // A hand-edited file goes through the same rules as the connect page.
        fs::write(saved_file(&dir), r#"{"url":"ftp://files.example.com"}"#)
            .expect("write a bad address");
        assert_eq!(load_from(&dir), None);

        fs::write(saved_file(&dir), "not json").expect("write a damaged file");
        assert_eq!(load_from(&dir), None);

        fs::remove_dir_all(&dir).expect("clean up the test folder");
    }
}
