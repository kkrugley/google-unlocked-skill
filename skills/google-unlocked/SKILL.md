---
name: google-unlocked
description: Search Google for results and inspect the Lumen DMCA notices linked from the result page. Use when the user asks for Google Unlocked, domains named in Google's removal notices, or a specific Lumen notice.
---

Call the Google Unlocked MCP tool `search_google_unlocked` with the user's original query. Pass `region` for a requested Google domain and `notice_ids` only when the user supplies Lumen references or asks to look up known notices directly.

For each reported domain, cite the relevant `notice_urls`, give the reported URL count, and offer `site_search_url` when useful. Treat notices as allegations. A domain can appear in a notice even when many of its pages are still indexed. Label any `reported_urls` as addresses listed in the notice.

Distinguish ordinary Google results from complaint data. Explain partial results using the tool's statuses. When Google or Lumen asks for browser verification in a visible session, give the user the relevant source link and rerun the same query after verification. When a service returns a retry time, wait until that time before retrying. A successful search with zero Lumen links describes only the inspected Google page.

If the tool is unavailable, point to the MCP connection instructions for the current client in the repository README.
