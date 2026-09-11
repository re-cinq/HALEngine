# Pull Request

## Why

<!-- Explain the motivation for this change. What problem does it solve? What feature does it enable? -->

## What Changed

<!-- Describe the changes you made. Be specific about what was added, modified, or removed. -->

## Alternatives Considered

<!-- What other approaches did you consider? Why did you choose this one? -->

## ADRs & Architecture

<!-- Reference any Architecture Decision Records (ADRs) or architectural patterns this PR follows or establishes. Link to relevant documentation (e.g., specs/hal-engine-architecture/spec.md). -->

## Testing

<!-- Describe how you tested these changes. Include:
- New tests added
- Manual testing performed
- Edge cases covered
- How to reproduce or verify the changes
-->

---

## Code Quality Checklist

- [ ] **Lint**: `npm run eslint` passes with no warnings
- [ ] **Types**: `npm run typecheck` passes (strict mode)
- [ ] **Tests**: `npm test` passes (new tests added for new code)
- [ ] **No Secrets**: No API keys, tokens, or credentials committed
- [ ] **Formatting**: Code follows project style (`npm run prettier:check` or `npm run prettier`)
- [ ] **Documentation**: Updated relevant docs or added inline comments for complex logic
- [ ] **Layer Adherence**: Changes respect the 5-layer architecture (types → providers → infrastructure → orchestration → transport)
- [ ] **No console.log**: Uses `log` from `shared/logger.js` instead

---

## Related Issues

<!-- Link to any related issues: Closes #123, Relates to #456 -->