---
type: llm
---

Look only at the caption itself in the reply.
PASS if its first line is a hook of at most about 125 characters that makes sense on its own, it uses at most 5 hashtags, and it adds no new factual claims (no percentages, client counts, revenue or other results the user did not give). Arithmetic derived from the user's numbers, such as the time saved, is fine.
FAIL if the first line is generic filler, there are more than 5 hashtags, or it invents results the user did not give.
