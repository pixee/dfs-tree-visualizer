/**
 * Data Normalizer — transforms 13 inconsistent JSON formats into a unified D3 hierarchy.
 *
 * Strategy:
 * 1. When all_paths has multiple genuinely different paths, build a MERGED prefix tree
 *    so the vulnerable node appears at the end of each distinct branch.
 * 2. Otherwise, use dependency_chain.path / deepest_path / direct_path / primary_path
 *    as a single spine, then layer on sibling data from dfs_tree_context.
 */
const DataNormalizer = (() => {

  const MAX_DISPLAY_PATHS = 4;
  const MAX_SIBLINGS = 10;

  // ── Parse a path entry string into {name, version} ──────────────────────
  function parsePathEntry(entry) {
    if (!entry || typeof entry !== 'string') return { name: String(entry || ''), version: '' };

    // Strip parenthetical annotations: "pkg@1.0 (some note)" → "pkg@1.0"
    let clean = entry.replace(/\s*\(.*$/, '').trim();

    // Maven group:artifact:version  (3+ colon-separated parts)
    const mavenMatch = clean.match(/^([^@\s]+):([^:@\s]+):([^:\s]+)$/);
    if (mavenMatch) {
      return { name: `${mavenMatch[1]}:${mavenMatch[2]}`, version: mavenMatch[3] };
    }

    // Maven group:artifact@version
    const mavenAtMatch = clean.match(/^([^@\s]+:[^@\s]+)@(.+)$/);
    if (mavenAtMatch) {
      return { name: mavenAtMatch[1], version: mavenAtMatch[2] };
    }

    // Python name==version
    const pyMatch = clean.match(/^([^=\s]+)==(.+)$/);
    if (pyMatch) {
      return { name: pyMatch[1], version: pyMatch[2] };
    }

    // Python name>=ver,<ver  (range spec — no resolved version)
    const pyRange = clean.match(/^([^>=<!\s]+)[>=<].+$/);
    if (pyRange) {
      return { name: pyRange[1], version: clean.replace(pyRange[1], '') };
    }

    // npm/go name@version
    const atMatch = clean.match(/^(.+)@(.+)$/);
    if (atMatch) {
      return { name: atMatch[1], version: atMatch[2] };
    }

    // Bitwarden-style name:version  (2 colon-separated parts, not maven group:artifact)
    const colonPair = clean.match(/^([^:]+):([^:]+)$/);
    if (colonPair) {
      return { name: colonPair[1], version: colonPair[2] };
    }

    return { name: clean, version: '' };
  }

  // ── Parse a child string into {name, version} ──────────────────────────
  function parseChildString(s) {
    if (!s || typeof s !== 'string') return { name: String(s || ''), version: '' };
    let clean = s.replace(/\s*\(.*$/, '').trim();
    if (clean.startsWith('...')) return { name: clean, version: '', isTruncation: true };

    const atMatch = clean.match(/^(.+)@(.+)$/);
    if (atMatch) return { name: atMatch[1], version: atMatch[2].replace(/^[\^~>=<]+/, '') };

    const colonPair = clean.match(/^([^:]+):([^:]+)$/);
    if (colonPair) return { name: colonPair[1], version: colonPair[2] };

    return { name: clean, version: '' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MULTI-PATH: extract all paths from all_paths and build a merged tree
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract all complete paths from data.dependency_chain.all_paths.
   * Returns array of parsed path arrays, or null if not available / single path only.
   */
  function extractAllPaths(data) {
    const dc = data.dependency_chain || {};
    const allPaths = dc.all_paths;
    if (!allPaths || !Array.isArray(allPaths) || allPaths.length < 2) return null;

    const parsed = [];
    for (const p of allPaths) {
      if (Array.isArray(p) && p.length >= 2) {
        // Direct array of strings (ghost, jenkins, bitwarden)
        parsed.push(p.map(parsePathEntry));
      } else if (p && typeof p === 'object' && !Array.isArray(p)) {
        // Object with path or chain field (keycloak, matomo, discourse)
        const arr = p.path || p.chain;
        if (Array.isArray(arr) && arr.length >= 2) {
          parsed.push(arr.map(parsePathEntry));
        }
      }
    }

    if (parsed.length < 2) return null;

    // Check that paths are genuinely different (diverge before the last node)
    const hasDiversity = parsed.some((p, i) => {
      if (i === 0) return false;
      const ref = parsed[0];
      // Find first divergence point
      for (let j = 0; j < Math.min(p.length, ref.length); j++) {
        if (p[j].name !== ref[j].name) return j < Math.max(p.length, ref.length) - 1;
      }
      return p.length !== ref.length;
    });

    return hasDiversity ? parsed : null;
  }

  /**
   * Select up to MAX_DISPLAY_PATHS diverse paths from the full set.
   * Prefers paths that diverge at earlier levels and paths of different lengths.
   */
  function selectDiversePaths(allPaths) {
    if (allPaths.length <= MAX_DISPLAY_PATHS) return allPaths;

    // Sort by length descending
    const sorted = [...allPaths].sort((a, b) => b.length - a.length);
    const selected = [sorted[0]]; // Always include longest

    // Greedily add paths that maximize early divergence from existing selections
    while (selected.length < MAX_DISPLAY_PATHS && sorted.length > 0) {
      let bestPath = null;
      let bestDivergence = Infinity;

      for (const candidate of sorted) {
        if (selected.includes(candidate)) continue;

        // Find earliest divergence from ANY selected path
        let earliestDiv = Infinity;
        for (const sel of selected) {
          let div = 0;
          while (div < candidate.length && div < sel.length && candidate[div].name === sel[div].name) {
            div++;
          }
          earliestDiv = Math.min(earliestDiv, div);
        }

        if (earliestDiv < bestDivergence ||
            (earliestDiv === bestDivergence && bestPath &&
             Math.abs(candidate.length - sorted[0].length) > Math.abs(bestPath.length - sorted[0].length))) {
          bestDivergence = earliestDiv;
          bestPath = candidate;
        }
      }

      if (bestPath) {
        selected.push(bestPath);
        sorted.splice(sorted.indexOf(bestPath), 1);
      } else {
        break;
      }
    }

    return selected;
  }

  /**
   * Build a merged prefix tree from multiple paths.
   * Shared prefixes become single nodes; once paths diverge they stay separate.
   * The vulnerable node appears at the end of each distinct branch.
   */
  function buildMergedTree(allPaths, data) {
    const paths = selectDiversePaths(allPaths);
    const first = paths[0];

    const root = {
      name: first[0].name,
      version: first[0].version,
      nodeType: 'root',
      onPath: true,
      children: [],
    };

    for (const path of paths) {
      insertPathIntoTree(root, path, 1);
    }

    // Add siblings from dfs_tree_context at root level
    addSiblingsToMergedTree(root, data);

    return root;
  }

  /**
   * Insert a single path into the prefix tree starting at startIdx.
   */
  function insertPathIntoTree(node, path, startIdx) {
    if (startIdx >= path.length) return;

    const entry = path[startIdx];
    const isLast = startIdx === path.length - 1;

    // For intermediate nodes, try to merge with existing on-path child
    let existing = null;
    if (!isLast) {
      existing = node.children.find(c => c.name === entry.name && c.onPath);
    }

    if (existing) {
      insertPathIntoTree(existing, path, startIdx + 1);
    } else {
      // Create new branch from here through to the leaf
      let current = node;
      for (let i = startIdx; i < path.length; i++) {
        const e = path[i];
        const last = i === path.length - 1;
        const child = {
          name: e.name,
          version: e.version,
          nodeType: last ? 'vulnerable' : (i === 1 ? 'direct' : 'transitive'),
          onPath: true,
          children: [],
        };
        current.children.push(child);
        current = child;
      }
    }
  }

  /**
   * Add off-path siblings from dfs_tree_context to the merged tree.
   * Only adds siblings at the root level to avoid overwhelming the multi-path view.
   */
  function addSiblingsToMergedTree(root, data) {
    const siblings = extractSiblingsAtDepth(data, 0);
    if (siblings.length === 0) return;

    const existingNames = new Set(root.children.map(c => c.name));
    let added = 0;
    for (const sib of siblings) {
      if (existingNames.has(sib.name)) continue;
      if (sib.name === root.name) continue;
      if (added >= MAX_SIBLINGS) {
        const remaining = siblings.filter(s => !existingNames.has(s.name) && s.name !== root.name).length - added;
        if (remaining > 0) {
          root.children.push({
            name: `...and ${remaining} more`,
            version: '',
            nodeType: 'truncated',
            onPath: false,
            children: [],
          });
        }
        break;
      }
      root.children.push({
        name: sib.name,
        version: sib.version || '',
        nodeType: 'direct',
        onPath: false,
        children: [],
      });
      added++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SINGLE-PATH: original spine-based approach
  // ═══════════════════════════════════════════════════════════════════════

  function extractPathSpine(data) {
    const dc = data.dependency_chain || {};

    // Ghost special case: path entries are full "a -> b -> c" chains
    if (dc.all_paths && Array.isArray(dc.all_paths) && dc.all_paths.length > 0 &&
        Array.isArray(dc.all_paths[0]) && dc.all_paths[0].length > 0) {
      let longest = dc.all_paths[0];
      for (const p of dc.all_paths) {
        if (Array.isArray(p) && p.length > longest.length) longest = p;
      }
      return longest.map(parsePathEntry);
    }

    // Keycloak: all_paths may be array of {description, path} objects
    if (dc.all_paths && Array.isArray(dc.all_paths) && dc.all_paths.length > 0 &&
        typeof dc.all_paths[0] === 'object' && !Array.isArray(dc.all_paths[0]) && dc.all_paths[0].path) {
      let longest = dc.all_paths[0].path;
      for (const p of dc.all_paths) {
        if (p.path && p.path.length > longest.length) longest = p.path;
      }
      const primary = dc.primary_path || dc.path || dc.deepest_path || dc.direct_path;
      if (primary && primary.length >= longest.length) {
        return primary.map(parsePathEntry);
      }
      return longest.map(parsePathEntry);
    }

    // Priority: deepest_path > path > primary_path > direct_path
    const pathArray = dc.deepest_path || dc.path || dc.primary_path || dc.direct_path;
    if (!pathArray || !Array.isArray(pathArray)) {
      return [];
    }

    // Ghost: check if entries contain " -> " (full chain strings)
    if (pathArray.length > 0 && typeof pathArray[0] === 'string' && pathArray[0].includes(' -> ')) {
      let longest = pathArray[0];
      for (const p of pathArray) {
        if (p.split(' -> ').length > longest.split(' -> ').length) longest = p;
      }
      return longest.split(' -> ').map(s => parsePathEntry(s.trim()));
    }

    return pathArray.map(parsePathEntry);
  }

  // ── Extract siblings at a given depth from dfs_tree_context ────────────
  function extractSiblingsAtDepth(data, depth) {
    const ctx = data.dfs_tree_context;
    if (!ctx || !ctx.levels) return [];

    const levelEntries = ctx.levels.filter(l =>
      (l.depth !== undefined ? l.depth : l.level) === depth
    );
    if (levelEntries.length === 0) return [];

    const results = [];
    for (const level of levelEntries) {
      const children = extractChildrenFromLevel(level);
      for (const c of children) {
        if (!results.find(r => r.name === c.name)) {
          results.push(c);
        }
      }
    }
    return results;
  }

  function extractChildrenFromLevel(level) {
    const results = [];

    // Pattern D: children is array of objects with on_path (matomo)
    if (Array.isArray(level.children) && level.children.length > 0 && typeof level.children[0] === 'object' && level.children[0] !== null && 'name' in level.children[0]) {
      for (const c of level.children) {
        results.push({ name: c.name, version: c.version || '', onPath: !!c.on_path });
      }
      return results;
    }

    // Pattern B: children is flat array of strings (ghost, jenkins, keycloak)
    if (Array.isArray(level.children) && level.children.length > 0 && typeof level.children[0] === 'string') {
      const targetChild = level.target_child || '';
      const targetChildren = level.target_children || [];
      for (const s of level.children) {
        const parsed = parseChildString(s);
        const isTarget = isOnPathChild(parsed.name, targetChild, targetChildren);
        results.push({ name: parsed.name, version: parsed.version, onPath: isTarget });
      }
      return results;
    }

    // Also check children_subset (ghost alternate levels)
    if (Array.isArray(level.children_subset) && level.children_subset.length > 0 && typeof level.children_subset[0] === 'string') {
      const targetChild = level.target_child || '';
      const targetChildren = level.target_children || [];
      for (const s of level.children_subset) {
        const parsed = parseChildString(s);
        const isTarget = isOnPathChild(parsed.name, targetChild, targetChildren);
        results.push({ name: parsed.name, version: parsed.version, onPath: isTarget });
      }
      return results;
    }

    // Pattern A: children.list (discourse, fastapi, mastodon, sentry)
    if (level.children && typeof level.children === 'object' && !Array.isArray(level.children) && level.children.list) {
      for (const c of level.children.list) {
        results.push({ name: c.name, version: c.resolved || c.version || c.spec || '', onPath: false });
      }
      return results;
    }

    // Pattern A (root): children_summary.categories
    if (level.children_summary && level.children_summary.categories) {
      for (const cat of Object.values(level.children_summary.categories)) {
        if (Array.isArray(cat)) {
          for (const c of cat) {
            results.push({ name: c.name, version: c.resolved_in_lock || c.resolved || c.spec || c.version || '', onPath: false });
          }
        }
      }
      return results;
    }

    // Pattern C: all_children as object (bitwarden)
    if (level.all_children) {
      const ac = level.all_children;
      if (ac.dependencies || ac.devDependencies) {
        for (const arr of [ac.dependencies, ac.devDependencies].filter(Boolean)) {
          for (const s of arr) {
            if (typeof s === 'string') {
              const parsed = parseChildString(s);
              results.push({ name: parsed.name, version: parsed.version, onPath: false });
            }
          }
        }
      } else {
        for (const [name, version] of Object.entries(ac)) {
          if (typeof version === 'string') {
            results.push({ name, version: version.replace(/^[\^~>=<]+/, ''), onPath: false });
          }
        }
      }
      const onPath = level.children_on_path || [];
      for (const r of results) {
        if (onPath.some(p => parseChildString(p).name === r.name)) r.onPath = true;
      }
      return results;
    }

    // Gitea: notable_direct_siblings
    if (level.notable_direct_siblings_of_jwt_go) {
      for (const s of level.notable_direct_siblings_of_jwt_go) {
        const parsed = parseChildString(s);
        results.push({ name: parsed.name, version: parsed.version, onPath: false });
      }
      return results;
    }

    return results;
  }

  function isOnPathChild(childName, targetChild, targetChildren) {
    if (targetChild && typeof targetChild === 'string') {
      const targetParsed = parseChildString(targetChild.split(' -> ')[0]);
      if (targetParsed.name === childName) return true;
    }
    if (targetChildren && Array.isArray(targetChildren)) {
      for (const tc of targetChildren) {
        const parsed = parseChildString(tc);
        if (parsed.name === childName) return true;
      }
    }
    return false;
  }

  // ── Build single-spine tree (fallback) ─────────────────────────────────
  function buildSingleSpineTree(pathSpine, data) {
    if (pathSpine.length === 0) return null;

    const root = {
      name: pathSpine[0].name,
      version: pathSpine[0].version,
      nodeType: 'root',
      onPath: true,
      children: [],
    };

    let currentNode = root;
    for (let i = 1; i < pathSpine.length; i++) {
      const isLast = i === pathSpine.length - 1;
      const child = {
        name: pathSpine[i].name,
        version: pathSpine[i].version,
        nodeType: isLast ? 'vulnerable' : (i === 1 ? 'direct' : 'transitive'),
        onPath: true,
        children: [],
      };
      currentNode.children.push(child);
      currentNode = child;
    }

    addSiblingsToSpine(root, pathSpine, data);
    return root;
  }

  function addSiblingsToSpine(root, pathSpine, data) {
    let node = root;
    for (let depth = 0; depth < pathSpine.length; depth++) {
      const siblings = extractSiblingsAtDepth(data, depth);
      if (siblings.length > 0) {
        mergeSiblingsIntoNode(node, siblings, depth, pathSpine);
      }

      // Ghost special case: crypto-browserify siblings
      if (data.dfs_tree_context && data.dfs_tree_context.sibling_subtrees_at_crypto_browserify_level) {
        const cbSiblings = data.dfs_tree_context.sibling_subtrees_at_crypto_browserify_level.siblings || [];
        if (depth === pathSpine.length - 2) {
          const cryptoNode = findNodeByName(root, 'crypto-browserify');
          if (cryptoNode) {
            for (const sib of cbSiblings) {
              if (!cryptoNode.children.find(c => c.name === sib.name)) {
                const subChildren = (sib.children || []).map(c => {
                  const parsed = parseChildString(c);
                  return { name: parsed.name, version: parsed.version, nodeType: 'transitive', onPath: false, children: [] };
                });
                cryptoNode.children.push({
                  name: sib.name.split('@')[0] || sib.name,
                  version: sib.name.includes('@') ? sib.name.split('@').pop() : '',
                  nodeType: 'transitive',
                  onPath: false,
                  children: subChildren.slice(0, 5),
                });
              }
            }
          }
        }
      }

      const nextOnPath = node.children.find(c => c.onPath);
      if (nextOnPath) { node = nextOnPath; } else { break; }
    }
  }

  function findNodeByName(root, nameFragment) {
    if (root.name.includes(nameFragment)) return root;
    for (const c of (root.children || [])) {
      const found = findNodeByName(c, nameFragment);
      if (found) return found;
    }
    return null;
  }

  function mergeSiblingsIntoNode(node, siblings, depth, pathSpine) {
    const nextOnPathName = (depth + 1 < pathSpine.length) ? pathSpine[depth + 1].name : null;
    const existingNames = new Set(node.children.map(c => c.name));
    const offPathSiblings = [];

    for (const sib of siblings) {
      if (existingNames.has(sib.name)) continue;
      if (sib.name === nextOnPathName) continue;
      if (sib.name === node.name) continue;
      offPathSiblings.push(sib);
    }

    let added = 0;
    for (const sib of offPathSiblings) {
      if (added >= MAX_SIBLINGS) {
        const remaining = offPathSiblings.length - added;
        if (remaining > 0) {
          node.children.push({ name: `...and ${remaining} more`, version: '', nodeType: 'truncated', onPath: false, children: [] });
        }
        break;
      }
      node.children.push({
        name: sib.name,
        version: sib.version || '',
        nodeType: depth === 0 ? 'direct' : 'transitive',
        onPath: false,
        children: [],
      });
      added++;
    }
  }

  // ── Extract metadata ──────────────────────────────────────────────────
  function extractMeta(data) {
    const proj = data.project || {};
    const vtd = data.vulnerable_transitive_dependency || {};
    const vuln = vtd.vulnerability || {};
    const dc = data.dependency_chain || {};

    const projectName = proj.name || proj.display_name ||
      (dc.path && dc.path[0] ? parsePathEntry(dc.path[0]).name : 'Unknown');

    const vulnPackage = vtd.name
      ? `${vtd.name}@${vtd.version}`
      : (vtd.group ? `${vtd.group}:${vtd.artifact}@${vtd.version}` : 'Unknown');

    const pathSpine = extractPathSpine(data);
    const allPaths = extractAllPaths(data);
    const additionalVulns = [];

    if (vtd.vulnerability && vtd.vulnerability.additional_vulnerabilities) {
      for (const av of vtd.vulnerability.additional_vulnerabilities) {
        additionalVulns.push(av.id || av);
      }
    }

    let otherVulns = data.other_notable_vulnerable_transitive_deps ||
      data.other_vulnerable_dependencies_found ||
      data.other_critical_vulns_considered || [];
    if (otherVulns && typeof otherVulns === 'object' && !Array.isArray(otherVulns)) {
      otherVulns = Object.values(otherVulns).flat();
    }
    for (const ov of otherVulns) {
      if (ov.vulnerability_id) additionalVulns.push(ov.vulnerability_id);
      else if (ov.id) additionalVulns.push(ov.id);
    }

    // Count how many times the vuln appears (multi-path)
    const displayPaths = allPaths ? selectDiversePaths(allPaths).length : 1;

    return {
      projectName,
      ecosystem: proj.ecosystem || proj.framework || '',
      vulnId: vuln.id || '',
      vulnSeverity: vuln.severity || '',
      vulnDescription: vuln.description || '',
      vulnPackage,
      totalPaths: dc.total_upstream_paths || dc.total_paths || 1,
      chainDepth: pathSpine.length - 1,
      additionalVulns,
      multiPath: allPaths ? true : false,
      displayPaths,
    };
  }

  // ── Prune branches with no vulnerable descendant ─────────────────────
  function pruneNonVuln(node) {
    if (!node.children) return node.nodeType === 'vulnerable';
    node.children = node.children.filter(c => pruneNonVuln(c));
    return node.nodeType === 'vulnerable' || node.children.length > 0;
  }

  // ── Public API ────────────────────────────────────────────────────────
  function normalize(data) {
    const meta = extractMeta(data);

    let tree;

    // Try multi-path first
    const allPaths = extractAllPaths(data);
    if (allPaths) {
      tree = buildMergedTree(allPaths, data);
    } else {
      // Fall back to single spine
      const pathSpine = extractPathSpine(data);
      if (pathSpine.length === 0) {
        return { meta, tree: { name: meta.projectName, version: '', nodeType: 'root', onPath: true, children: [] } };
      }
      tree = buildSingleSpineTree(pathSpine, data);
    }

    pruneNonVuln(tree);
    return { meta, tree };
  }

  return { normalize };
})();
