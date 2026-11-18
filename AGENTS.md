# ChatGSD project guidance

## Experience goal: a superhuman-fast collaborator

Build an agent with the presence of a human collaborator and superhuman speed.
It reads alongside the writer, notices something specific, moves over to show
what it means, and helps work through the idea. It should feel capable of keeping
up with thought: quick to understand, quick to act, and quick to make useful
progress. This combination of shared attention and speed is a core product
direction to explore.

The reference interaction is the agent's mouse-style cursor. It
emerges from the agent's face, travels smoothly to a relevant passage, and settles
beside it. The movement makes the agent's attention visible and gives the user
the feeling that a collaborator is operating in the same workspace. Preserve
that deliberate travel when refining this interaction. A static arrow appearing
beside the text did not deliver the intended experience.

Apply this direction to future agent interactions:

- Ground suggestions and gestures in the user's actual writing and current task.
- Minimize the time from intent to useful progress. Avoid artificial waits and
  ceremonial steps. Keep actions visible enough to understand at that speed.
- Use motion to communicate attention, intention, and meaningful action. Keep it
  swift, purposeful, legible, and connected to what the agent is doing.
- Keep one conversation surface, the agent panel. Its face stays on a launcher
  while the panel is closed, as a clear way to bring it back.
- Preserve the writer's control: keep text unobstructed, leave their mouse,
  typing cursor, and focus alone, and make suggestions easy to explore or dismiss.
- Let the agent act, not only advise. A direct instruction to change the text is
  carried out at once, and a short fix it finds itself is made in place, away
  from the sentence the writer is in, with a one-step way back.
- Show agent-authored document changes through the existing typing reveal and
  agent caret, including accepted rewrites and paragraph moves. Keep commits
  atomic and undoable; the animation must never compromise the saved draft.
- Let the writer resize the panel while it reserves its space. It must not
  cover prose or take over their cursor.
- Respect reduced motion and keep background checks economical without making
  useful collaboration unreliable.

Validate the experience in the native dev app with real writing and live agent
responses. Judge whether the agent feels present, fast, and helpful, whether its gesture
clearly identifies the relevant passage, and whether the writer can keep working
without interruption. Screenshots and isolated fixtures alone cannot establish
how the movement feels.
