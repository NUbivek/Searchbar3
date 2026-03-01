---
name: "lsp"
description: "Enable and use LSP-style static analysis during code work."
metadata:
  short-description: "Run static analysis pre-commit"
---
## Skill: $lsp
Run static checks before committing.

### Checks
- `npx tsc --noEmit` when TS exists
- `npx eslint ...` when eslint exists
- `npm run build`
- grep scans for risky patterns
