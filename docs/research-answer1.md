# Feedback on Lacuna Deep E2E Coverage Research

## Overall Impression

This is a very good articulation of the problem space.

One observation stood out while reading it:

Lacuna probably does **not** need to become a fully autonomous testing agent.

It likely needs to become a **journey discovery engine**.

Most of the infrastructure problems already appear to be solved:

* Authentication
* Route discovery
* Snapshots
* Verification
* Repair loops
* Protected route detection
* Flow exploration

The remaining problem feels less like "generate tests" and more like:

> Recover the application's latent workflow graph and expected outcomes.

Once that graph exists, generating Playwright becomes largely a serialization problem.

---

# P2 is probably the linchpin

The most important issue appears to be:

> "I clicked THIS button. What is supposed to happen?"

P1, P3, P4, P5, P6 and P7 all become significantly easier once that question can be answered reliably.

Examples:

* Custom widgets
* Interrupt modals
* Cleanup
* Domain fixtures
* Correct locator choice
* Monolithic admin pages

---

# Regex probably cannot solve P2

Consider:

```tsx
<Button onClick={saveMenu}>
  Save
</Button>

async function saveMenu() {

   await api.createMenu();

   toast.success("Menu created");

   if (isTrial)
      router.push("/upgrade");

}
```

Regex extraction discovers:

```ts
"Menu created"

"/upgrade"
```

But cannot determine:

```text
Save button
    ↓
saveMenu()
    ↓
toast.success()
```

versus

```text
Upgrade button
    ↓
goToUpgrade()
    ↓
router.push()
```

At this point, an AST-based solution seems necessary.

---

# Consider producing a FlowMap

Rather than extracting loose assertions, build an intermediate representation.

Example:

```ts
interface FlowAction {

    id:string;

    locator:string;

    handler:string;

    outcomes:{

        toast?:string;

        redirect?:string;

        mutation?:string;

        modal?:string;

    };

    services:string[];

}
```

Generated output:

```ts
[
{
    id:"saveMenu",

    handler:"saveMenu",

    locator:"button[Save]",

    outcomes:{
        toast:"Menu created"
    },

    services:[
        "menuService.create"
    ]
}
]
```

The prompt then becomes:

```text
User clicked Save.

Expected outcome:

Toast:
Menu created

Mutation:
menuService.create()

Assert appropriately.
```

This potentially eliminates most incorrect assertions.

---

# P1 may not need LLM calls initially

The proposal mentions LLM microcalls.

They are elegant.

However, they are probably expensive.

A widget adapter approach feels more practical.

## Adapter 1

### Combobox

Detect:

```html
role="combobox"
```

Open.

Inspect:

```html
role="option"
```

Choose first valid option.

---

## Adapter 2

### Radix

Detect:

```html
data-radix
```

Driver:

```ts
click();

type();

arrowdown();

enter();
```

---

## Adapter 3

### MUI

Detect:

```html
MuiAutocomplete
```

---

## Adapter 4

### Headless UI

Detect:

```html
aria-expanded

aria-controls
```

---

Only when none of the adapters match should a small LLM call be considered.

Example:

```text
Widget tree:

...

How do I progress?

Answer:

Click option 2
```

This should be significantly cheaper.

---

# P3 may be solvable heuristically

There seem to be two modal categories.

## Intended modal

Appears immediately after our action.

Contains:

```text
Confirm

Delete

Continue
```

Expected behavior.

Interact with it.

---

## Interrupt modal

Appears spontaneously.

Contains:

```text
Maybe later

Skip

Close

No thanks

Upgrade

Cookie
```

Dismiss.

---

Possible scoring approach:

```ts
score =

appeared_after_action ? +3

contains_skip ? +5

contains_cookie ? +10

contains_upgrade ? +10
```

Dismiss when score exceeds a threshold.

---

# P4 probably wants a graph

Rather than storing a simple journey,

```text
Journey
```

consider generating a

```text
StateGraph
```

Example:

```text
Home

├── Add Item

│
▼

Form

├── SuccessToast

└── ValidationError



Transactions

└── Details
```

Benefits:

* Wizard detection
* Terminal detection
* Cleanup generation
* Branch handling
* Retry support

---

# P7 may be the second most important problem

The monolithic admin issue is difficult.

Instead of treating routes as pages, consider introducing:

```ts
FeatureBoundary
```

Example:

```text
Admin

├── Menu

├── Orders

├── Team

├── Upgrade

├── Settings
```

Detection signals:

* Tabs
* Sidebar navigation
* Section headings
* Feature buttons

Explorer execution then happens per feature.

---

# Suggested roadmap

| Priority | Research Area        |
| -------- | -------------------- |
| 1        | AST FlowMap          |
| 2        | Widget adapters      |
| 3        | Feature boundaries   |
| 4        | State graph explorer |
| 5        | Fixtures inference   |
| 6        | Interrupt classifier |
| 7        | LLM microcalls       |
| 8        | Record-assist        |

---

# Closing Thought

Lacuna appears to have already solved the difficult infrastructure layer.

The remaining challenge increasingly resembles:

> Recovering the application's workflow graph and expected outcomes.

If that graph can be recovered reliably, high quality Playwright generation may become a fairly deterministic code generation task rather than an open-ended inference problem.
