# FlowMap vs Explorer

They look like they do the same thing — "click X → what happens" — but they're opposites, and they cover each other's blind spots.

> **FlowMap reads the recipe. The Explorer cooks the dish and tastes it.**

| | **FlowMap** | **Explorer** |
|---|---|---|
| Method | **Static** — reads source (AST), runs nothing | **Dynamic** — drives a real browser |
| Answers | "What is *supposed* to happen?" (what to **assert**) | "What *actually* happens?" (the real steps) |
| Sees | Handlers, toast/redirect strings in code | Real rendered fields, real toast text, multi-screen flow, real data |
| Blind to | Runtime data, dynamic content, child-component internals (1 hop only) | Anything it can't reach (auth/timing/flake); and it's slow |
| Cost | Instant, deterministic | Slow, needs the app running |
| Feeds the prompt's | `CONTROL → OUTCOME MAP` | `MULTI-STEP JOURNEYS` / `FLOWS` |

## On a real page (cheflymenu `/admin`)
- **FlowMap** knows, from source alone, that **"Upgrade to Pro"** → toast `"Redirecting to upgrade page..."` + redirect `/upgrade` — without opening a browser. But it can't describe the **Add Item form**, which only exists at runtime inside a child component.
- **The Explorer** can't statically know the upgrade outcome, but it can **click Add Item, watch the fields appear, fill them, submit, and capture the real "Menu item added successfully!" toast** — runtime truth FlowMap can't derive.

## Why use both
- FlowMap gives **correct, cheap outcome assertions** for page-level controls even when the flow is hard or unsafe to drive.
- The Explorer gives the **real multi-step path and revealed selectors** that aren't knowable from source.

Using both is why a generated spec can *both* walk a deep flow *and* assert the exact outcome. The Explorer's `captureToast` is essentially it doing at runtime what FlowMap does statically — which is why, on simple controls, the two sometimes agree. They're complementary, not redundant.
