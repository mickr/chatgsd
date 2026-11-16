use super::tools::ToolOutput;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

struct Pending {
    run_id: String,
    sender: oneshot::Sender<ToolOutput>,
}
#[derive(Default)]
pub struct ToolBridge {
    pending: Mutex<HashMap<String, Pending>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolRequest<'a> {
    request_id: &'a str,
    run_id: &'a str,
    name: &'a str,
    args: Value,
}
impl ToolBridge {
    /// Ask the frontend to run `name`. `timeout` is `None` for tools that wait on
    /// the user (ask_user); those end only when answered or the run is cancelled.
    pub async fn execute(
        &self,
        app: &tauri::AppHandle,
        run_id: &str,
        name: &str,
        args: Value,
        timeout: Option<Duration>,
    ) -> ToolOutput {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let state = app.state::<super::AgentState>();
            let runs = state.runs.lock().expect("agent runs mutex");
            if !runs.contains_key(run_id) {
                return ToolOutput::error("This agent run has ended");
            }
            self.pending.lock().expect("agent tools mutex").insert(
                request_id.clone(),
                Pending {
                    run_id: run_id.into(),
                    sender,
                },
            );
            if app
                .emit(
                    "agent:tool-request",
                    ToolRequest {
                        request_id: &request_id,
                        run_id,
                        name,
                        args,
                    },
                )
                .is_err()
            {
                self.pending
                    .lock()
                    .expect("agent tools mutex")
                    .remove(&request_id);
                return ToolOutput::error("Scratch could not reach the editor");
            }
        }
        let response = match timeout {
            Some(limit) => tokio::time::timeout(limit, receiver).await.ok(),
            None => Some(receiver.await),
        };
        self.pending
            .lock()
            .expect("agent tools mutex")
            .remove(&request_id);
        match response {
            Some(Ok(output)) => output,
            Some(Err(_)) => ToolOutput::error("This agent run has ended"),
            None => {
                ToolOutput::error("Scratch did not respond. Re-read the document and try again.")
            }
        }
    }
    pub fn respond(&self, request_id: &str, output: ToolOutput) {
        if let Some(pending) = self
            .pending
            .lock()
            .expect("agent tools mutex")
            .remove(request_id)
        {
            let _ = pending.sender.send(output);
        }
    }
    pub fn cleanup(&self, run_id: &str) {
        self.pending
            .lock()
            .expect("agent tools mutex")
            .retain(|_, request| request.run_id != run_id);
    }
}
