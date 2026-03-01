---
name: "simplify"
description: "Reduce a file, function, or module to its simplest correct form — remove dead code, flatten unnecessary abstractions, consolidate duplicated logic, and eliminate over-engineering without changing behavior."
metadata:
  short-description: "Refactor code to simplest correct form without changing behavior"
---
## Skill: $simplify
Invoked by mentioning `$simplify` followed by a target (file path, function name, or description).

### What this does
- Removes dead code and redundant abstractions
- Consolidates duplicated logic
- Keeps behavior and public API unchanged

### Process
1. Read target carefully
2. List simplification opportunities
3. Remove only behavior-preserving complexity
4. Verify build/tests
5. Commit with clear message
