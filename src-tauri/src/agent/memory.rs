//! Small, revisioned working memory for one document and one signed-in account.
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Assignment,
    Thought,
    Choice,
    /// What an argument trace learned: the agent's own reading, recorded by
    /// the app, never the writer's words. The first to go when memory is full.
    Insight,
}

/// A note keeps at most this many insights; a new one replaces the oldest.
pub const MAX_INSIGHTS: usize = 4;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Open,
    Waiting,
    Done,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub key: String,
    pub kind: Kind,
    pub status: Status,
    pub summary: String,
    pub quote: Option<String>,
    pub next: Option<String>,
}

impl Entry {
    pub fn waiting_thought(&self) -> bool {
        self.kind == Kind::Thought && self.status == Status::Waiting
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct WorkingMemory {
    pub revision: u64,
    pub entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub revision: u64,
    pub entry: Entry,
}

impl WorkingMemory {
    fn check_revision(&self, revision: u64) -> Result<(), String> {
        if revision != self.revision {
            return Err("This note’s saved items changed. Review them before retrying.".into());
        }
        Ok(())
    }

    pub fn update(&mut self, update: Update) -> Result<(), String> {
        let entry = update.entry;
        let bounded =
            |text: &str, max: usize| !text.trim().is_empty() && text.chars().count() <= max;
        if !bounded(&entry.key, 64)
            || !entry
                .key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !bounded(&entry.summary, 400)
            || entry.quote.as_ref().is_some_and(|s| !bounded(s, 500))
            || entry.next.as_ref().is_some_and(|s| !bounded(s, 400))
        {
            return Err(
                "Use a short lowercase key, a concise summary, and bounded passage and next step."
                    .into(),
            );
        }
        let existing = self.entries.iter().position(|item| item.key == entry.key);
        if existing.is_some_and(|i| self.entries[i] == entry) {
            return Ok(());
        }
        self.check_revision(update.revision)?;
        if let Some(index) = existing {
            self.entries[index] = entry;
        } else {
            let insights = self.entries.iter().filter(|e| e.kind == Kind::Insight).count();
            if entry.kind == Kind::Insight && insights >= MAX_INSIGHTS {
                let oldest = self.entries.iter().position(|e| e.kind == Kind::Insight).expect("counted above");
                self.entries.remove(oldest);
            } else if self.entries.len() >= 12 {
                // Finished work makes room first, then the agent's own insights.
                let index = self.entries.iter().position(|e| e.status == Status::Done)
                    .or_else(|| self.entries.iter().position(|e| e.kind == Kind::Insight))
                    .ok_or("This note already has twelve unfinished items. Keep existing commitments and ask the writer which to drop.")?;
                self.entries.remove(index);
            }
            self.entries.push(entry);
        }
        self.revision += 1;
        Ok(())
    }

    pub fn forget(&mut self, revision: u64, key: &str) -> Result<(), String> {
        self.check_revision(revision)?;
        let index = self
            .entries
            .iter()
            .position(|entry| entry.key == key)
            .ok_or("This item is no longer in memory.")?;
        self.entries.remove(index);
        self.revision += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn update(key: &str, revision: u64, status: Status) -> Update {
        Update {
            revision,
            entry: Entry {
                key: key.into(),
                kind: Kind::Thought,
                status,
                summary: "Compare the before and after.".into(),
                quote: Some("The pilot may help.".into()),
                next: None,
            },
        }
    }

    #[test]
    fn retries_converge_and_stale_writes_cannot_restore_dropped_work() {
        let mut memory = WorkingMemory::default();
        memory.update(update("pilot", 0, Status::Waiting)).unwrap();
        memory.update(update("pilot", 0, Status::Waiting)).unwrap();
        assert_eq!(memory.revision, 1);
        assert!(memory.update(update("pilot", 0, Status::Done)).is_err());
        memory.forget(1, "pilot").unwrap();
        assert!(memory.update(update("pilot", 1, Status::Waiting)).is_err());
        assert!(memory.entries.is_empty());
    }

    #[test]
    fn only_completed_items_make_room_for_new_work() {
        let mut memory = WorkingMemory::default();
        for i in 0..12 {
            memory
                .update(update(&format!("task-{i}"), i, Status::Open))
                .unwrap();
        }
        assert!(memory
            .update(update("overflow", 12, Status::Waiting))
            .is_err());
        memory.update(update("task-7", 12, Status::Done)).unwrap();
        memory.update(update("new", 13, Status::Waiting)).unwrap();
        assert_eq!(memory.entries.len(), 12);
        assert!(!memory.entries.iter().any(|entry| entry.key == "task-7"));
    }

    fn insight(key: &str, revision: u64) -> Update {
        let mut update = update(key, revision, Status::Open);
        update.entry.kind = Kind::Insight;
        update
    }

    #[test]
    fn insights_replace_the_oldest_and_never_crowd_out_the_writers_work() {
        let mut memory = WorkingMemory::default();
        for i in 0..6 { memory.update(insight(&format!("insight-{i}"), i)).unwrap(); }
        let keys: Vec<_> = memory.entries.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["insight-2", "insight-3", "insight-4", "insight-5"]);
        for i in 0..8 { memory.update(update(&format!("task-{i}"), memory.revision, Status::Open)).unwrap(); }
        assert_eq!(memory.entries.len(), 12);
        memory.update(update("task-8", memory.revision, Status::Waiting)).unwrap();
        assert!(!memory.entries.iter().any(|e| e.key == "insight-2"));
        assert!(memory.entries.iter().any(|e| e.key == "task-0"));
    }
}
