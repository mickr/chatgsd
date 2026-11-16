//! Paged views of note text, so the agent can work through notes thousands of
//! lines long without pulling the whole note into every request.

/// Notes up to this size come back whole when no range is asked for.
const FULL_LINES: usize = 400;
const FULL_CHARS: usize = 40_000;
/// The most one ranged read returns.
const PAGE_LINES: usize = 400;
const PAGE_CHARS: usize = 40_000;
/// What an unranged read of a long note shows after its outline.
const OPENING_LINES: usize = 120;
const MAX_OUTLINE: usize = 150;
const MAX_MATCHES: usize = 40;
const MATCH_LINE_CHARS: usize = 200;

/// The note's text for a read: all of it when short, otherwise an outline and
/// the opening, or the requested 1-based inclusive line range.
pub fn view(markdown: &str, start: Option<usize>, end: Option<usize>) -> String {
    let lines: Vec<&str> = markdown.lines().collect();
    let total = lines.len();
    if total == 0 {
        return "The note is empty.".into();
    }
    if start.is_none() && end.is_none() {
        if total <= FULL_LINES && markdown.len() <= FULL_CHARS {
            return format!("Lines 1-{total} of {total} (the whole note)\n\n{markdown}");
        }
        let (shown, text) = page(&lines, 1, OPENING_LINES);
        return format!(
            "This note is long: {total} lines. Read it in parts with start_line/end_line, or use find_in_note.\n\nOutline (line: heading):\n{}\n\nLines 1-{shown} of {total}:\n\n{text}",
            outline(&lines)
        );
    }
    let first = start.unwrap_or(1).clamp(1, total);
    let last = end.unwrap_or(first + PAGE_LINES - 1).clamp(first, total);
    let (shown, text) = page(&lines, first, last.min(first + PAGE_LINES - 1));
    let more = if shown < total {
        format!(" Continue from line {}.", shown + 1)
    } else {
        String::new()
    };
    format!("Lines {first}-{shown} of {total}.{more}\n\n{text}")
}

/// Lines `first..=last` (1-based), stopping early at the size cap. Returns the
/// last line included.
fn page(lines: &[&str], first: usize, last: usize) -> (usize, String) {
    let mut text = String::new();
    let mut shown = first - 1;
    for line in &lines[first - 1..last] {
        if !text.is_empty() && text.len() + line.len() + 1 > PAGE_CHARS {
            break;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(line);
        shown += 1;
    }
    (shown, text)
}

fn outline(lines: &[&str]) -> String {
    let mut fenced = false;
    let mut entries = Vec::new();
    let mut count = 0;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        let hashes = trimmed.bytes().take_while(|byte| *byte == b'#').count();
        if fenced || !(1..=6).contains(&hashes) || trimmed.as_bytes().get(hashes) != Some(&b' ') {
            continue;
        }
        count += 1;
        if entries.len() < MAX_OUTLINE {
            entries.push(format!("{}: {}", index + 1, trimmed));
        }
    }
    if entries.is_empty() {
        return "(no headings)".into();
    }
    if count > entries.len() {
        entries.push(format!("…and {} more headings", count - entries.len()));
    }
    entries.join("\n")
}

/// Lines containing `query`, case-insensitively, with their line numbers.
pub fn find(markdown: &str, query: &str) -> String {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return "query must not be empty".into();
    }
    let mut matches = Vec::new();
    let mut count = 0;
    for (index, line) in markdown.lines().enumerate() {
        if !line.to_lowercase().contains(&needle) {
            continue;
        }
        count += 1;
        if matches.len() < MAX_MATCHES {
            let mut shown: String = line.trim().chars().take(MATCH_LINE_CHARS).collect();
            if line.trim().chars().nth(MATCH_LINE_CHARS).is_some() {
                shown.push('…');
            }
            matches.push(format!("{}: {shown}", index + 1));
        }
    }
    match count {
        0 => format!("No lines contain {query:?}."),
        _ if count > matches.len() => format!(
            "{count} lines contain {query:?}; the first {}:\n{}",
            matches.len(),
            matches.join("\n")
        ),
        _ => format!("{count} lines contain {query:?}:\n{}", matches.join("\n")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_note(lines: usize) -> String {
        (1..=lines)
            .map(|n| if n % 100 == 1 { format!("## Part {n}") } else { format!("line {n}") })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn short_notes_come_back_whole() {
        let view = view("# Hi\n\ntext", None, None);
        assert!(view.starts_with("Lines 1-3 of 3 (the whole note)"));
        assert!(view.ends_with("# Hi\n\ntext"));
    }

    #[test]
    fn long_notes_open_with_an_outline_and_page_by_range() {
        let note = long_note(3000);
        let opening = view(&note, None, None);
        assert!(opening.contains("This note is long: 3000 lines"));
        assert!(opening.contains("2901: ## Part 2901"));
        assert!(opening.contains("Lines 1-120 of 3000:"));
        assert!(!opening.contains("line 121\n"));

        let middle = view(&note, Some(1502), Some(1504));
        assert!(middle.starts_with("Lines 1502-1504 of 3000. Continue from line 1505."));
        assert!(middle.ends_with("line 1502\nline 1503\nline 1504"));

        let capped = view(&note, Some(10), Some(5000));
        assert!(capped.starts_with(&format!("Lines 10-{} of 3000.", 10 + PAGE_LINES - 1)));
        assert!(view(&note, Some(2999), None).starts_with("Lines 2999-3000 of 3000.\n"));
    }

    #[test]
    fn outline_ignores_hashes_in_code_and_tags() {
        let note = "# Title\n```\n# not a heading\n```\n#tag\n## Real";
        assert_eq!(outline(&note.lines().collect::<Vec<_>>()), "1: # Title\n6: ## Real");
    }

    #[test]
    fn find_reports_line_numbers_and_caps_results() {
        let note = long_note(500);
        assert_eq!(find(&note, "LINE 250"), "1 lines contain \"LINE 250\":\n250: line 250");
        assert!(find(&note, "line").starts_with(&format!("495 lines contain \"line\"; the first {MAX_MATCHES}:")));
        assert_eq!(find(&note, "zebra"), "No lines contain \"zebra\".");
    }
}
