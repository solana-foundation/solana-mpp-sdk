//! Expiration time helpers.
//!
//! Convenience functions for generating ISO 8601 expiration timestamps.

use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

pub fn seconds(n: u64) -> String {
    offset(Duration::seconds(n as i64))
}

pub fn minutes(n: u64) -> String {
    offset(Duration::minutes(n as i64))
}

pub fn hours(n: u64) -> String {
    offset(Duration::hours(n as i64))
}

pub fn days(n: u64) -> String {
    offset(Duration::days(n as i64))
}

pub fn weeks(n: u64) -> String {
    offset(Duration::weeks(n as i64))
}

fn offset(duration: Duration) -> String {
    let dt = OffsetDateTime::now_utc() + duration;
    dt.format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minutes_format() {
        let result = minutes(5);
        assert!(result.contains('T'));
    }

    #[test]
    fn hours_later_than_minutes() {
        let m = minutes(1);
        let h = hours(1);
        assert!(h > m);
    }
}
