//! Keeps a long conversation's model input bounded. The ChatGPT plan route
//! has no server-side truncation, so Scratch trims what it sends.
//!
//! Two steps, cheapest first:
//! - When a new turn starts, earlier outputs of tools the agent can call again
//!   (note reads, searches) are cut to their opening if long. They are stale by
//!   now, and the agent re-reads what it needs. Doing this once per turn keeps
//!   the prefix stable for caching. Anything else, above all the user's answers
//!   to ask_user, can't be fetched again and is never cut.
//! - If the input still exceeds the budget, older rereadable outputs in the
//!   current turn are cut too, then the oldest whole turns are dropped (their
//!   calls and reasoning go together, so the input stays well formed).
use super::super::events::canonical_tool_name;
use serde_json::{json, Value};
use std::collections::HashSet;

/// Tools whose output the agent can get again by calling them.
const REREADABLE: &[&str] = &[
    "read_document",
    "read_notes",
    "find_in_note",
    "search_notes",
    "list_notes",
    "note_links",
];

/// Tool outputs from earlier turns longer than this are cut to a stub.
const STALE_OUTPUT_CHARS: usize = 1_500;
const STUB_HEAD_CHARS: usize = 400;
/// The most input to send, as serialized bytes: roughly 150k tokens.
pub const MAX_INPUT_BYTES: usize = 600_000;
/// Tool outputs from the latest rounds that are never cut while over budget.
const KEEP_RECENT_OUTPUTS: usize = 4;
const TRIMMED_NOTICE: &str = "Earlier turns of this conversation were removed to fit the context window. Re-read notes as needed, and ask the user if you need something only they said earlier.";

/// Indices of outputs from rereadable tools, in order.
fn rereadable_outputs(items: &[Value]) -> Vec<usize> {
    let calls: HashSet<&str> = items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .filter(|item| {
            item.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| REREADABLE.contains(&canonical_tool_name(name)))
        })
        .filter_map(|item| item.get("call_id").and_then(Value::as_str))
        .collect();
    (0..items.len())
        .filter(|&index| {
            items[index].get("type").and_then(Value::as_str) == Some("function_call_output")
                && items[index]
                    .get("call_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| calls.contains(id))
        })
        .collect()
}

fn is_user_turn(item: &Value) -> bool {
    item.get("role").and_then(Value::as_str) == Some("user")
}

/// Cuts a tool output to its opening, unless it's already short.
fn stub(item: &mut Value) {
    let Some(output) = item.get("output").and_then(Value::as_str) else {
        return;
    };
    let total = output.chars().count();
    if total <= STALE_OUTPUT_CHARS {
        return;
    }
    let head: String = output.chars().take(STUB_HEAD_CHARS).collect();
    item["output"] = Value::String(format!(
        "{head}\n[Earlier tool output: {} more characters omitted. Call the tool again if you need it; notes may have changed since.]",
        total - STUB_HEAD_CHARS
    ));
}

/// Cuts earlier rereadable outputs; call before a new user message is added.
pub fn compact(items: &mut [Value]) {
    for index in rereadable_outputs(items) {
        stub(&mut items[index]);
    }
}

fn size(item: &Value) -> usize {
    serde_json::to_vec(item).map(|bytes| bytes.len()).unwrap_or(0)
}

/// Brings the input under `budget` bytes, never touching the latest turn's
/// user message or its most recent tool outputs.
pub fn fit(items: &mut Vec<Value>, budget: usize) {
    let mut total: usize = items.iter().map(size).sum();
    if total <= budget {
        return;
    }
    let outputs = rereadable_outputs(items);
    for &index in outputs.iter().rev().skip(KEEP_RECENT_OUTPUTS).rev() {
        let before = size(&items[index]);
        stub(&mut items[index]);
        total = total - before + size(&items[index]);
        if total <= budget {
            return;
        }
    }
    let notice = json!({"role": "developer", "content": TRIMMED_NOTICE});
    let skip = usize::from(items.first() == Some(&notice));
    let turns: Vec<usize> = (skip..items.len()).filter(|&index| is_user_turn(&items[index])).collect();
    // Drop whole turns from the front until the rest fits; the last turn is
    // the current one and always stays.
    let mut cut = skip;
    for &start in turns.iter().skip_while(|&&start| start <= skip) {
        if total <= budget {
            break;
        }
        total -= items[cut..start].iter().map(size).sum::<usize>();
        cut = start;
    }
    if cut > skip {
        items.drain(skip..cut);
        if skip == 0 {
            items.insert(0, notice);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> Value {
        json!({"role": "user", "content": text})
    }
    /// A tool call and its output; names come back namespaced, as from ChatGPT.
    fn call(name: &str, id: &str, chars: usize) -> [Value; 2] {
        [
            json!({"type": "function_call", "call_id": id, "name": format!("scratch.{name}"), "arguments": "{}"}),
            json!({"type": "function_call_output", "call_id": id, "output": "x".repeat(chars)}),
        ]
    }
    fn output_len(items: &[Value], id: &str) -> usize {
        items
            .iter()
            .find(|item| item["type"] == "function_call_output" && item["call_id"] == id)
            .map(|item| item["output"].as_str().unwrap().chars().count())
            .unwrap()
    }

    #[test]
    fn compact_cuts_only_long_rereadable_outputs() {
        let mut items = vec![user("hi")];
        items.extend(call("read_document", "read", 10_000));
        items.extend(call("search_notes", "search", 100));
        compact(&mut items);
        assert!(output_len(&items, "read") < STALE_OUTPUT_CHARS);
        assert!(items[2]["output"].as_str().unwrap().contains("9600 more characters omitted"));
        assert_eq!(output_len(&items, "search"), 100);
        let once = items.clone();
        compact(&mut items);
        assert_eq!(items, once, "compacting twice changes nothing");
    }

    #[test]
    fn the_users_answers_survive_compaction_and_the_budget() {
        // A long form submission and a long typed answer can't be re-read.
        let mut items = vec![user("plan the trip")];
        items.extend(call("ask_user", "form", 6_000));
        items.extend(call("ask_user", "typed", 3_000));
        items.extend(call("edit_note", "decision", 2_000));
        items.extend(call("read_document", "read", 6_000));
        compact(&mut items);
        items.push(user("now the budget"));
        items.extend((0..6).flat_map(|n| call("read_notes", &format!("r{n}"), 20_000)));
        fit(&mut items, 100_000);
        assert_eq!(output_len(&items, "form"), 6_000);
        assert_eq!(output_len(&items, "typed"), 3_000);
        assert_eq!(output_len(&items, "decision"), 2_000);
        assert!(output_len(&items, "read") < STALE_OUTPUT_CHARS);
        assert!(output_len(&items, "r0") < STALE_OUTPUT_CHARS, "older reads in the turn are cut");
        assert_eq!(output_len(&items, "r5"), 20_000, "the latest reads stay whole");
    }

    #[test]
    fn fit_cuts_older_outputs_in_the_turn_before_dropping_turns() {
        let mut items = vec![user("only turn")];
        items.extend((0..8).flat_map(|n| call("read_notes", &format!("r{n}"), 50_000)));
        fit(&mut items, 250_000);
        assert_eq!(items[0], user("only turn"));
        let whole = (0..8).filter(|n| output_len(&items, &format!("r{n}")) == 50_000).count();
        assert!(whole >= KEEP_RECENT_OUTPUTS, "the latest outputs stay whole");
        assert!(items.iter().map(size).sum::<usize>() <= 250_000);
    }

    #[test]
    fn fit_drops_oldest_whole_turns_and_leaves_one_notice() {
        let turn = |text: &str| vec![user(text), json!({"type": "message", "role": "assistant", "content": "y".repeat(40_000)})];
        let mut items: Vec<Value> = ["one", "two", "three", "four"].iter().flat_map(|text| turn(text)).collect();
        fit(&mut items, 100_000);
        assert_eq!(items[0]["role"], "developer");
        assert_eq!(items[1], user("three"));
        assert_eq!(items.last().unwrap()["role"], "assistant");

        items.extend(turn("five"));
        fit(&mut items, 100_000);
        assert_eq!(items.iter().filter(|item| item["role"] == "developer").count(), 1);
        assert_eq!(items[1], user("four"));
    }
}
