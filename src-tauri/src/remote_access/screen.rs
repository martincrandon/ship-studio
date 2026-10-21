//! Turning a terminal's raw output into the text a person would see on it.
//!
//! Agent CLIs are full-screen programs: they move the cursor, redraw the same
//! lines over and over, and colour everything. Stripping escape codes from the
//! byte stream leaves every intermediate frame of every spinner smeared into
//! one unreadable column, so instead the retained output is replayed through a
//! terminal emulator at the size the program drew it for, and the resulting
//! screen (plus the scrollback above it) is read back as plain lines.
//!
//! The replay starts at the ring buffer's oldest retained byte, which may be
//! mid-sequence. The emulator tolerates that, and the agent redraws its own
//! screen often enough that the bottom of the result — the part anyone asks
//! about — is accurate.

/// Lines of history kept above the visible screen during replay.
const SCROLLBACK_LINES: usize = 2_000;

/// Render `bytes` as a `rows`×`cols` terminal would show them, returning at
/// most the last `max_lines` non-trailing-blank lines (scrollback included).
pub fn render_tail(bytes: &[u8], rows: u16, cols: u16, max_lines: usize) -> Vec<String> {
    let rows = rows.max(2);
    let cols = cols.max(2);
    let mut parser = vt100::Parser::new(rows, cols, SCROLLBACK_LINES);
    parser.process(bytes);

    // Walk the scrollback from oldest to newest, one top row per offset, then
    // take the whole live screen. `set_scrollback` clamps to what exists, so
    // reading the offset back tells us how much history there is.
    parser.screen_mut().set_scrollback(usize::MAX);
    let history = parser.screen().scrollback();
    let mut lines: Vec<String> = Vec::with_capacity(history + rows as usize);
    for offset in (1..=history).rev() {
        parser.screen_mut().set_scrollback(offset);
        if let Some(top) = parser.screen().rows(0, cols).next() {
            lines.push(top);
        }
    }
    parser.screen_mut().set_scrollback(0);
    lines.extend(parser.screen().rows(0, cols));

    for line in lines.iter_mut() {
        let trimmed = line.trim_end().len();
        line.truncate(trimmed);
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    // Runs of blank lines are layout, not content; collapse them so the line
    // budget goes to things that were actually printed.
    lines.dedup_by(|a, b| a.is_empty() && b.is_empty());

    let start = lines.len().saturating_sub(max_lines);
    lines.split_off(start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_output_comes_back_as_lines() {
        let lines = render_tail(b"hello\r\nworld\r\n", 5, 20, 50);
        assert_eq!(lines, vec!["hello", "world"]);
    }

    #[test]
    fn redraws_show_only_the_final_frame() {
        // A spinner that rewrites one line in place — the raw stream contains
        // every frame; the screen holds only the last.
        let bytes = b"working |\rworking /\rworking -\rdone     \r\n";
        let lines = render_tail(bytes, 5, 20, 50);
        assert_eq!(lines, vec!["done"]);
    }

    #[test]
    fn colour_codes_are_not_text() {
        let lines = render_tail(b"\x1b[31mred\x1b[0m plain\r\n", 5, 20, 50);
        assert_eq!(lines, vec!["red plain"]);
    }

    #[test]
    fn scrollback_above_the_screen_is_kept_in_order() {
        let mut bytes = Vec::new();
        for i in 0..10 {
            bytes.extend_from_slice(format!("line {i}\r\n").as_bytes());
        }
        let lines = render_tail(&bytes, 4, 20, 50);
        let expected: Vec<String> = (0..10).map(|i| format!("line {i}")).collect();
        assert_eq!(lines, expected);
    }

    #[test]
    fn the_line_budget_keeps_the_newest_lines() {
        let mut bytes = Vec::new();
        for i in 0..10 {
            bytes.extend_from_slice(format!("line {i}\r\n").as_bytes());
        }
        let lines = render_tail(&bytes, 4, 20, 3);
        assert_eq!(lines, vec!["line 7", "line 8", "line 9"]);
    }

    #[test]
    fn blank_runs_collapse() {
        let lines = render_tail(b"a\r\n\r\n\r\n\r\nb\r\n", 10, 20, 50);
        assert_eq!(lines, vec!["a", "", "b"]);
    }
}
