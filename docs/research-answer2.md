This is an exceptionally well-framed, highly technical research brief. You are tackling the absolute frontier of AI engineering: moving past shallow, single-page test automation into **stateful, multi-step user journey generation**.

The core issue you are hitting in `lacuna` is that a running UI is a state machine, but a purely black-box DOM snapshot doesn't provide enough state-transition data or domain context to navigate complex branches.

Here is a pragmatic architectural breakdown and actionable strategies for your top engineering hurdles, designed to move `lacuna` past these bottlenecks.

---

## 1. Solving P2 & P5: The AST + Source Analysis Engine

Relying on regex to map UI interactions to outcomes will always fail due to component complexity, code splitting, and variable naming variations. A static AST approach combined with runtime inspection bridges this gap.

```
[UI Control: Click "Submit"] 
       │
       ▼ (AST Analysis via ts-morph)
[Find React Event Handler: handleSubmit]
       │
       ├─► [Scan Scope for Toast Strings] ──► "Menu item saved!" (Assertion Hint)
       └─► [Scan Scope for Navigation]   ──► router.push('/admin/menu') (Route Hint)

```

### Implementation Strategy using `ts-morph`:

Instead of feeding raw files to an LLM or relying on regex, build a lightweight semantic parser that runs during the **Route Discovery** phase.

1. **Locate the Event Handler:** Identify JSX attributes like `onClick={handleSubmit}` or `onSubmit={onSubmit}`.
2. **Scope-Bound String Extraction:** Query the AST inside that specific block for known patterns:
* **Toasts:** Look for CallExpressions matching `toast.success()`, `toast.error()`, `notify()`, etc., and extract the literal string.
* **Routing:** Look for `router.push()`, `Maps()`, or `window.location.href` to capture next-step destination rules.
* **Mutations/Validation:** Look for Zod schemas (`z.object({...})`) or validation logic inside the handler to extract limits (e.g., `min(10)`, `max(10000)`).



### Why this fixes Token Budgets (P8):

Instead of passing the entire monolithic component file to the LLM, your AST step extracts a **Compressed Control-Outcome Map** to append directly to the DOM snapshot:

```json
{
  "selector": "button[type='submit']",
  "inferred_outcomes": {
    "toasts": ["Menu item updated successfully"],
    "redirects_to": "/admin/menu"
  }
}

```

---

## 2. Solving P1: Driving Custom Widgets via ARIA Rollbacks

You cannot write custom code for every widget in existence, but you *can* enforce interaction sequences based on the **WAI-ARIA Accessibility Tree**.

Modern UI libraries (Radix, Headless UI, Ariakit) heavily rely on standard ARIA attributes for accessibility compliance. You can use these states to guide your explorer sequence:

### The Standardized Interaction Sequence:

When the explorer encounters an element with `role="combobox"` or `aria-haspopup="listbox"`:

1. **Trigger Open:** Perform a standard `click()` or press `ArrowDown` on the element.
2. **Wait for Mutation:** Poll the accessibility tree until an element with `role="listbox"` or `role="dialog"` shifts from hidden to visible.
3. **Handle Search Type-Ahead:** If an input inside the combobox has `aria-autocomplete="list"` or `aria-controls`, have the execution engine type a **domain-safe value**.
4. **Select Option:** Query the visible listbox for children with `role="option"` or `role="gridcell"`, then click the matching index or text element.

---

## 3. Solving P3 & P4: Stateful Modeling (Interrupts vs. Intended Modals)

To prevent your explorer from breaking on a terminal screen or getting trapped by an onboarding modal, you need a deterministic classification layer.

### The Modal Classification Matrix:

| Modal Attribute | Interrupt Modal (Dismiss) | Intended Flow Modal (Interact) |
| --- | --- | --- |
| **Trigger Mechanism** | Appears on page load or after an unrelated timer. | Appears immediately after clicking an "opener" control (e.g., "Add Item"). |
| **Common Selectors/Text** | "Cookie settings", "Subscribe", "Skip", "Got it", "Maybe later". | "Save Changes", "Confirm", Form Inputs, "Create Account". |
| **Behavioral Impact** | Blocks access to primary navigation links. | Contained within the expected user flow layout. |

### Practical Execution Strategy:

* Before clicking anything, the execution script takes a snapshot of the current state.
* If a modal appears *without* an interaction click, flag it instantly as an **Interrupt** and execute the `dismiss` routine (click "Close", "Skip", or send the `Escape` key).
* If a modal opens following an explicit click, scope the rest of the current sequence block *exclusively* inside that modal container until it closes or redirects.

---

## 4. Architectural Recommendations for `.lacuna.json`

As noted in your brief, fully autonomous inference has mathematical and contextual limits. A clean, minimal configuration file provides the pragmatic structure necessary for rock-solid enterprise-grade coverage.

I recommend implementing the configuration profile using the structural framework below:

```json
{
  "e2e": {
    "fixtures": {
      "currency_codes": ["USD", "XOF", "KES"],
      "test_pins": { "weak": "1111", "valid": "4829" },
      "phone_numbers": ["+254700000000"]
    },
    "selectors": {
      "global_dismiss": ["text=Maybe later", "button[aria-label='Close']"],
      "tabs_as_routes": {
        "/admin": ["#tab-menu", "#tab-orders", "#tab-settings"]
      }
    },
    "custom_widgets": [
      {
        "pattern": "div[data-primitive='combobox']",
        "sequence": ["click", "type_fixture", "wait_listbox", "click_option"]
      }
    ]
  }
}

```

---

## Next Steps for the Research Phase

To start making immediate improvements without breaking your existing, working core, consider tackling these objectives in the following sequence:

1. **Build a Proof of Concept for AST Extraction:** Write a isolated node script using `ts-morph` targeting a single complex view component from `cheflymenu`. Try to cleanly map out click handlers to their internal toast strings.
2. **Enhance the Prompt Engine with Explicit Locator Typing:** Update your tool tracking arrays in `snapshot.ts` so they capture not just the string, but the locator context (e.g., `{ value: "0.00", type: "placeholder" }`). This will instantly fix your `getByLabel("0.00")` locator generation bug.
3. **Implement an Isolation Architecture for Multi-Flow Route Tabs:** In `discover.ts`, add a hook that checks if a route matches a known multi-tab panel arrangement. If it does, automatically sequence clicks through those target tabs *before* generating snapshots, effectively splitting monolithic paths into distinct sub-route files.

Which of these structural friction points—the AST source analyzer, refining the widget selector tree, or stabilizing your multi-step explorer flow—should we focus on building out next?