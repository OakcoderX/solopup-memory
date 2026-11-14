# What survives a compacted DSH conversation?

I maintain SoloPup Memory, a text-memory plugin for DeepSeek Harness. A writing project gave me a useful test case. The author picked draft two for chapter seven and kept the original ending. Both details have to survive when the assistant picks up the work later.

DSH compacts the model's working context and keeps the earlier events in the session log. That gives us a concrete regression test. Supply a summary that leaves out the ending, then check whether the plugin can still locate the author's original words. A second case withdraws the decision and checks that the old wording stays out of current memory. This separates a source-retrieval result from a model's ability to continue the draft.

SoloPup records a decision's scope and revision history. Model-assisted review can still miss a decision or misread an exception. The release notes record the tested hosts, cases, and limits. [DSH compaction](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.md) · [Release evidence](../../RELEASE.md) · [Dream Review research](../research/dreaming-in-dsh/README.en.md)

If you build against DSH's session log, I'd like to hear which compaction or withdrawal cases you test. [Project](https://github.com/OakcoderX/solopup-memory) · [Feedback](../feedback.md)
