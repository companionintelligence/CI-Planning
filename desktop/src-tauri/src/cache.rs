//! The offline cache: the last response the app got for each read from the server, kept in
//! SQLite so the app can still show it when the server cannot be reached.
//!
//! The web client decides what is worth caching (`client/src/lib/desktop-shell.ts`). This file
//! only stores strings under keys. A key is the full request URL, so the server and its path are
//! part of it, and two servers never share an answer.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

pub struct Cache {
    conn: Mutex<Connection>,
}

impl Cache {
    /// Open the cache database at `path`, creating its folder and table if they are missing.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|error| format!("Could not create the cache folder: {error}"))?;
        }
        let conn = Connection::open(path).map_err(|error| error.to_string())?;
        Self::with_connection(conn)
    }

    /// A cache that lives only as long as the app runs. Used when the cache file cannot be opened.
    pub fn in_memory() -> Result<Self, String> {
        Self::with_connection(Connection::open_in_memory().map_err(|error| error.to_string())?)
    }

    fn with_connection(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS responses (
                key TEXT PRIMARY KEY,
                body TEXT NOT NULL,
                saved_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );",
        )
        .map_err(|error| error.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| String::from("The offline cache is unavailable."))
    }

    /// Store `body` under `key`, replacing whatever was there.
    pub fn put(&self, key: &str, body: &str) -> Result<(), String> {
        self.conn()?
            .execute(
                "INSERT OR REPLACE INTO responses (key, body) VALUES (?1, ?2)",
                params![key, body],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// The body stored under `key`, if there is one.
    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        self.conn()?
            .query_row(
                "SELECT body FROM responses WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    /// Forget everything. The client calls this on sign-in, sign-out and a server change, so one
    /// person's data is never shown to the next.
    pub fn clear(&self) -> Result<(), String> {
        self.conn()?
            .execute("DELETE FROM responses", [])
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory() -> Cache {
        Cache::in_memory().expect("an in-memory database")
    }

    #[test]
    fn a_path_that_is_not_a_database_is_refused_so_the_app_can_fall_back() {
        let dir =
            std::env::temp_dir().join(format!("companion-planning-cache-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a folder to try to open as a database");
        assert!(Cache::open(&dir).is_err());
        std::fs::remove_dir_all(&dir).expect("clean up the test folder");
        in_memory().put("k", "v").expect("the in-memory fallback works");
    }

    #[test]
    fn a_response_comes_back_under_its_full_url() {
        let cache = in_memory();
        cache
            .put("https://planning.example.com/api/tasks", "[]")
            .expect("put");
        assert_eq!(
            cache
                .get("https://planning.example.com/api/tasks")
                .expect("get")
                .as_deref(),
            Some("[]")
        );
        assert_eq!(
            cache
                .get("https://planning.example.com/api/goals")
                .expect("get"),
            None
        );
        assert_eq!(
            cache
                .get("https://other.example.com/api/tasks")
                .expect("get"),
            None
        );
    }

    #[test]
    fn a_second_put_replaces_the_first() {
        let cache = in_memory();
        cache.put("k", "old").expect("put");
        cache.put("k", "new").expect("put again");
        assert_eq!(cache.get("k").expect("get").as_deref(), Some("new"));
    }

    #[test]
    fn clear_forgets_everything() {
        let cache = in_memory();
        cache.put("a", "1").expect("put");
        cache.put("b", "2").expect("put");
        cache.clear().expect("clear");
        assert_eq!(cache.get("a").expect("get"), None);
        assert_eq!(cache.get("b").expect("get"), None);
    }

    #[test]
    fn the_cache_survives_reopening_the_file() {
        let dir =
            std::env::temp_dir().join(format!("companion-planning-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("offline-cache.sqlite");
        Cache::open(&path).expect("open").put("k", "kept").expect("put");
        let reopened = Cache::open(&path).expect("reopen");
        assert_eq!(reopened.get("k").expect("get").as_deref(), Some("kept"));
        std::fs::remove_dir_all(&dir).expect("clean up the test folder");
    }
}
