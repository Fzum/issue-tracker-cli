# Work-package templates

Copy the shape that matches the level. Replace every bracketed placeholder.

## Milestone — `wps/wp-mN.md`

A milestone is a business theme that delivers one or more PRD outcomes.

```markdown
---
short_description: "[What the business can do after this milestone]"
---

## Theme

[The business change this milestone delivers, in one or two sentences.]

## Serves

- OUT-01

## Out of scope

- [Boundary that a reader could expect here but that belongs elsewhere, or "None"]
```

## Epic — `wps/wp-mNeN.md`

An epic is one business capability inside the milestone.

```markdown
---
short_description: "[The capability this epic delivers]"
---

## Capability

[What a person can do once every story in this epic is finished.]

## Serves

- OUT-01
```

## Story — `wps/wp-mNeNuN.md`

A story is one business intent a person can accept or reject.

```markdown
---
status: todo
blocked_by: []
short_description: "[The result, in one line]"
---

## Intent

As a [role from the PRD target users],
I want [the result],
so that [the benefit].

## Acceptance criteria

- [ ] [Observable result in the user's world]
- [ ] [Observable result in the user's world]

## Out of scope

- [Boundary that stays outside this story, or "None"]

## Serves

- OUT-01
```

## Worked example

`wps/wp-m1e1u1.md`

```markdown
---
status: todo
blocked_by: []
short_description: "A returning person reaches their own information"
---

## Intent

As a returning customer,
I want to identify myself,
so that I see only my own information.

## Acceptance criteria

- [ ] A person who proves who they are reaches their own information
- [ ] A person who cannot prove who they are is told clearly, and sees nothing
- [ ] A person who fails many times in a row is stopped for a while
- [ ] A person who steps away is signed out, and must identify again

## Out of scope

- Using an account from another company to identify
- Recovering a forgotten way to identify

## Serves

- OUT-01
```

Note what the example does not say. It does not say password, cookie, token, session, `401`, form, or database. Those are technical answers, and they belong to `/architecture` and to the later build.

It still gives a full definition of done, because each line names a result a person can observe.
