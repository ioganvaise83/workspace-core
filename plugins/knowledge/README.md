# Planned knowledge plugin

Goal: expose safe `read_note`, `search_notes`, and `append_log` operations scoped to `/workspace/knowledge` and prevent path traversal. **Not implemented.** Today the directory is simply mounted and can be read/written by the Harness agent using tools already available in its active profile.
