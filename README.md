# DFS Tree Visualizer — Sizzle Demo

A cinematic dependency-tree visualizer that shows how vulnerabilities hide deep inside transitive dependency chains. Built as a **sizzle piece** — a visual demo that makes the invisible problem of transitive vulnerabilities feel real and urgent.

## Why this exists

Most developers never see their transitive dependency graph. A project might have 5 direct dependencies but hundreds of transitive ones, and a single CVE can lurk 4-5 levels deep. This demo makes that concrete: you watch an amber dot trace a DFS path from the project root down through the dependency tree until it reaches the vulnerable package, showing exactly how far the risk travels.

## What it does

1. **Loads real vulnerability data** from 13 open-source projects (Jenkins, Ghost, Mastodon, FastAPI, Keycloak, etc.)
2. **Builds a pruned dependency tree** — only branches that lead to a vulnerable package are kept, with sibling dependencies shown for context
3. **Animates a DFS traversal** — an amber dot traces from root to each vulnerable node:
   - Links brighten as the dot passes over them
   - The dot backtracks to branch points, dimming non-path links
   - Vulnerable nodes pulse on arrival
   - Camera follows the dot, then zooms out to reveal the full tree
4. **Multi-path support** — projects with multiple distinct paths to the same vulnerability (Ghost, Mastodon) show a merged tree with branching paths

## Running it

```bash
npm install
node server.js
# open http://localhost:3000
```

Use the dropdown to switch between repos. The animation restarts on each selection.

## Data

The `data/` folder contains vulnerability analysis JSON for each project, including:
- `dependency_chain` — all paths from root to the vulnerable package
- `dfs_tree_context` — sibling dependencies at each level for tree context
- `vulnerable_transitive_dependency` — CVE details, severity, description

## Stack

- **D3.js v7** — tree layout, zoom/pan, transitions
- **Express** — static file serving + JSON API
- Vanilla JS, no build step
