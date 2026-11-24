# Pick up the right draft and check the handoff in DeepSeek Harness

I maintain SoloPup Memory, an MIT-licensed text-memory plugin for DeepSeek Harness (DSH). Version 0.26.0 is the stable text-memory release. [Install the stable release](../guides/quickstart.md)

Say you've written three versions of a chapter and decide, “Use the second draft for chapter seven, keep the original ending, and include a short revision note.” When you resume in the same workspace, version 0.26 can surface the current decisions that apply, with sources and exceptions. After a file edit, a supported DSH host can give the assistant one chance to review the handoff before the turn closes.

Try it with two fictional Markdown drafts. Save the decision, open a fresh chat, and ask the assistant to deliver the revision. Open the files to check the draft choice, the ending, and the revision note. The evaluation lists the comparison conditions, scores, and misses. [Trial instructions](tester-invite.md) · [Historical evaluation results](../runs/2026-11-18-memory-delivery.md)

Download the source or fork it and rerun the tests on your own DSH workflow. Please share the versions, steps, and a synthetic example if you find a memory decision that fails to make it into the final files. [Versioned source downloads](https://github.com/OakcoderX/solopup-memory/releases/tag/v0.26.0) · [Fork on GitHub](https://github.com/OakcoderX/solopup-memory/fork) · [Feedback](../feedback.md)

[Project](https://github.com/OakcoderX/solopup-memory) · [Installation](../guides/quickstart.md) · [Dream Review for long chats](../dream-review.md) · [Link an approved Markdown heading](../guides/markdown-reference.md)
