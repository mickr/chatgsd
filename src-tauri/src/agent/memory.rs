//! Small, revisioned working memory for one document and one signed-in account.
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Assignment,
    Thought,
    Choice,
}

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
            if self.entries.len() >= 12 {
                let index = self.entries.iter().position(|e| e.status == Status::Done)
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
}
