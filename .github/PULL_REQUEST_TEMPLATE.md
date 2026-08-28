## Behavioral summary

<!-- Describe user-visible behavior and the phase implemented. -->

## Risk assessment

<!-- Include privacy, Discord API, provider, persistence, and UI lifecycle risks. -->

## Validation

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build:vencord`
- [ ] Local/cloud smoke tests completed when configured

## Privacy and read-only checklist

- [ ] Every Discord target is scope-validated before retrieval
- [ ] Guild-wide candidates are post-filtered before model/citation exposure
- [ ] No Discord write endpoint or mutation tool was added
- [ ] Diagnostics contain no secrets, tokens, message content, or attachment bodies

## Provider compatibility

<!-- State capability/payload changes for every preset and custom endpoints. -->

## Bloat report

- Production LOC before:
- Production LOC after:
- Largest touched files:
- Deleted duplication:
- Remaining large-file hotspots:

## Acceptance and review

- [ ] Phase acceptance criteria pass
- [ ] Bloat budget passes
- [ ] Reviewer confirms this phase may be merged before the next phase begins
