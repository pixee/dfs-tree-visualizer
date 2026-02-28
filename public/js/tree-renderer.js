/**
 * Tree Renderer — D3.js tree layout with cinematic DFS traversal animation.
 *
 * Animation sequence:
 * 1. Amber dot appears at root
 * 2. Dot traces DFS paths to each vulnerable node, links brighten behind it
 * 3. Dot backtracks to branch points (links dim), then continues to next branch
 * 4. After all vuln nodes found, zoom out to reveal full tree
 */
const TreeRenderer = (() => {
  let svg, g, zoomBehavior;
  let currentData = null;
  let animationCancelled = false;

  const COLORS = {
    root: '#4ade80',
    rootStroke: '#22c55e',
    direct: '#60a5fa',
    directStroke: '#3b82f6',
    transitive: '#9ca3af',
    transitiveStroke: '#6b7280',
    vulnerable: '#ef4444',
    vulnerableStroke: '#dc2626',
    truncated: '#475569',
    truncatedStroke: '#334155',
    pathEdge: '#fbbf24',
    offEdge: '#4b5563',
  };

  const TIMING = {
    forward: 960,
    backtrack: 600,
    arriveVuln: 720,
    zoomOut: 1800,
    pan: 720,
  };

  function getNodeColor(d) {
    return COLORS[d.data.nodeType] || COLORS.transitive;
  }
  function getNodeStroke(d) {
    return COLORS[d.data.nodeType + 'Stroke'] || COLORS.transitiveStroke;
  }
  function getNodeRadius(d) {
    if (d.data.nodeType === 'vulnerable') return 14;
    return 10;
  }

  function truncLabel(name, version, max) {
    const full = version ? `${name}@${version}` : name;
    return full.length > max ? full.slice(0, max - 1) + '\u2026' : full;
  }

  let vulnMeta = {};

  function setMeta(meta) { vulnMeta = meta || {}; }

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════

  function render(container, treeData) {
    currentData = treeData;
    animationCancelled = false;

    const containerEl = document.getElementById(container);
    containerEl.innerHTML = '';

    const width = 600;
    const height = 600;

    svg = d3.select(`#${container}`)
      .append('svg')
      .attr('width', width)
      .attr('height', height);

    g = svg.append('g');

    zoomBehavior = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoomBehavior);

    // Create hierarchy
    const root = d3.hierarchy(treeData);

    // Compute tree layout
    const nodeCount = root.descendants().length;
    const treeWidth = Math.max(width - 100, nodeCount * 60);
    const treeHeight = Math.max(height - 100, root.height * 140);

    const treeLayout = d3.tree()
      .size([treeWidth, treeHeight])
      .separation((a, b) => a.parent === b.parent ? 1.2 : 1.8);

    treeLayout(root);

    // Draw links
    const linkGenerator = d3.linkVertical()
      .x(d => d.x)
      .y(d => d.y);

    g.selectAll('.link')
      .data(root.links())
      .join('path')
      .attr('class', 'link')
      .attr('d', linkGenerator)
      .attr('fill', 'none')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.15);

    // Draw nodes
    const nodes = g.selectAll('.node')
      .data(root.descendants())
      .join('g')
      .attr('class', d => `node ${d.data.nodeType}`)
      .attr('transform', d => `translate(${d.x},${d.y})`);

    nodes.append('circle')
      .attr('r', getNodeRadius)
      .attr('fill', getNodeColor)
      .attr('stroke', getNodeStroke)
      .attr('stroke-width', 2);

    // Labels
    nodes.append('text')
      .attr('class', 'node-label')
      .attr('dy', d => -getNodeRadius(d) - 6)
      .attr('text-anchor', 'middle')
      .text(d => truncLabel(d.data.name, d.data.version, 25));

    // CVE badge on vulnerable node
    nodes.filter(d => d.data.nodeType === 'vulnerable')
      .append('text')
      .attr('class', 'cve-badge')
      .attr('dy', getNodeRadius)
      .attr('dx', 20)
      .attr('text-anchor', 'start')
      .text(vulnMeta.vulnId || '');

    // Tooltip bindings
    nodes.on('mouseenter', (event, d) => Tooltip.show(event, d.data))
      .on('mousemove', (event) => Tooltip.move(event))
      .on('mouseleave', () => Tooltip.hide());

    // Zoom in on the root node
    const scale = 2;
    const tx = width / 2 - root.x * scale;
    const ty = 40;
    svg.call(zoomBehavior.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale));

    // Build and run DFS traversal animation
    const steps = buildTraversalSteps(root);
    if (steps.length > 0) {
      runTraversal(root, steps);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP BUILDER — buildTraversalSteps(root)
  // ═══════════════════════════════════════════════════════════════════════

  function buildTraversalSteps(root) {
    const steps = [];

    // Only traverse on-path children (the pruned tree only has vuln-path branches)
    function dfs(node) {
      if (!node.children || node.children.length === 0) return;

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];

        // Forward step: move dot from node to child
        steps.push({ type: 'forward', from: node, to: child });

        // If child is vulnerable, arrive-vuln
        if (child.data.nodeType === 'vulnerable') {
          steps.push({ type: 'arrive-vuln', node: child });
        }

        // Recurse into child's subtree
        if (child.children && child.children.length > 0) {
          dfs(child);
        }

        // Backtrack to parent — unless this is the very last node we'll visit
        // (the zoom-out handles the final state)
        const isLastChild = i === node.children.length - 1;
        const hasMoreWork = !isLastChild;
        // Also backtrack if we're not at the root and need to return to parent
        if (hasMoreWork) {
          steps.push({ type: 'backtrack', from: child, to: node });
        }
      }
    }

    dfs(root);

    // Zoom out to show the full tree
    steps.push({ type: 'zoom-out' });

    return steps;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FIND LINK PATH between two nodes
  // ═══════════════════════════════════════════════════════════════════════

  function findLinkPath(parentNode, childNode) {
    // Find the <path> element for the link from parent to child
    const links = g.selectAll('.link');
    let found = null;
    links.each(function(d) {
      if (d.source === parentNode && d.target === childNode) {
        found = this;
      }
    });
    return found;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DOT ANIMATION — animateDotAlongLink(dot, pathEl, forward, duration)
  // ═══════════════════════════════════════════════════════════════════════

  function animateDotAlongLink(dot, pathEl, forward, duration) {
    return new Promise((resolve) => {
      if (!pathEl) {
        resolve();
        return;
      }

      const totalLen = pathEl.getTotalLength();

      dot.transition()
        .duration(duration)
        .ease(d3.easeQuadInOut)
        .tween('pathFollow', function() {
          return function(t) {
            const pos = forward ? t : 1 - t;
            const pt = pathEl.getPointAtLength(pos * totalLen);
            dot.attr('cx', pt.x).attr('cy', pt.y);
          };
        })
        .on('end', resolve);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CAMERA — panToNode, fitAllNodes
  // ═══════════════════════════════════════════════════════════════════════

  function panToNode(node, scale, duration) {
    return new Promise((resolve) => {
      const width = 600;
      const height = 600;
      const tx = width / 2 - node.x * scale;
      const ty = height / 2 - node.y * scale;

      svg.transition()
        .duration(duration)
        .ease(d3.easeQuadInOut)
        .call(zoomBehavior.transform,
          d3.zoomIdentity.translate(tx, ty).scale(scale))
        .on('end', resolve);
    });
  }

  function fitAllNodes(root, duration) {
    return new Promise((resolve) => {
      const width = 600;
      const height = 600;
      const padding = 60;

      const descendants = root.descendants();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const d of descendants) {
        if (d.x < minX) minX = d.x;
        if (d.x > maxX) maxX = d.x;
        if (d.y < minY) minY = d.y;
        if (d.y > maxY) maxY = d.y;
      }

      const treeW = maxX - minX || 1;
      const treeH = maxY - minY || 1;
      const scale = Math.min(
        (width - padding * 2) / treeW,
        (height - padding * 2) / treeH,
        2 // don't zoom in more than 2x
      );

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const tx = width / 2 - cx * scale;
      const ty = height / 2 - cy * scale;

      svg.transition()
        .duration(duration)
        .ease(d3.easeQuadOut)
        .call(zoomBehavior.transform,
          d3.zoomIdentity.translate(tx, ty).scale(scale))
        .on('end', resolve);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TRAIL EFFECT — link coloring
  // ═══════════════════════════════════════════════════════════════════════

  function brightenLink(pathEl) {
    if (!pathEl) return;
    d3.select(pathEl)
      .classed('trail-visited', true)
      .classed('trail-backtracked', false)
      .transition()
      .duration(200)
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 2.5)
      .attr('opacity', 0.8);
  }

  function dimLink(pathEl) {
    if (!pathEl) return;
    d3.select(pathEl)
      .classed('trail-visited', false)
      .classed('trail-backtracked', true)
      .transition()
      .duration(200)
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.25);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NODE EFFECTS
  // ═══════════════════════════════════════════════════════════════════════

  function pulseVulnNode(node) {
    return new Promise((resolve) => {
      // Find the node group and add active class
      const nodeGroup = g.selectAll('.node')
        .filter(d => d === node);

      nodeGroup.classed('dfs-active', true);

      // Flash: scale up then back down
      nodeGroup.select('circle')
        .transition()
        .duration(TIMING.arriveVuln / 2)
        .attr('r', getNodeRadius(node) + 4)
        .transition()
        .duration(TIMING.arriveVuln / 2)
        .attr('r', getNodeRadius(node))
        .on('end', () => {
          nodeGroup.classed('dfs-active', false);
          resolve();
        });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP EXECUTOR — runTraversal(steps)
  // ═══════════════════════════════════════════════════════════════════════

  // Track which links are on a "final path" to a vuln node (should stay bright)
  const vulnPathLinks = new Set();

  async function runTraversal(root, steps) {
    vulnPathLinks.clear();

    // Pre-compute which links lead to vuln nodes (so they stay bright after traversal)
    markVulnPathLinks(root);

    // Create the traversal dot behind the node groups (insert before first .node)
    const firstNodeGroup = g.select('.node').node();
    const dotNode = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    g.node().insertBefore(dotNode, firstNodeGroup);
    const dot = d3.select(dotNode)
      .attr('class', 'traversal-dot')
      .attr('cx', root.x)
      .attr('cy', root.y)
      .attr('r', 5);

    for (const step of steps) {
      if (animationCancelled) {
        dot.remove();
        return;
      }
      await executeStep(step, dot, root);
    }
  }

  function markVulnPathLinks(root) {
    // Walk up from every vulnerable node to root, marking those links
    root.descendants().forEach(node => {
      if (node.data.nodeType === 'vulnerable') {
        let cur = node;
        while (cur.parent) {
          vulnPathLinks.add(linkKey(cur.parent, cur));
          cur = cur.parent;
        }
      }
    });
  }

  function linkKey(parent, child) {
    return `${parent.x},${parent.y}->${child.x},${child.y}`;
  }

  async function executeStep(step, dot, root) {
    switch (step.type) {
      case 'forward': {
        const pathEl = findLinkPath(step.from, step.to);
        await Promise.all([
          animateDotAlongLink(dot, pathEl, true, TIMING.forward),
          panToNode(step.to, 2, TIMING.pan),
        ]);
        brightenLink(pathEl);
        break;
      }

      case 'backtrack': {
        const pathEl = findLinkPath(step.to, step.from);
        await Promise.all([
          animateDotAlongLink(dot, pathEl, false, TIMING.backtrack),
          panToNode(step.to, 2, TIMING.pan),
        ]);
        // Only dim if this link is NOT on a final vuln path
        const key = linkKey(step.to, step.from);
        if (!vulnPathLinks.has(key)) {
          dimLink(pathEl);
        }
        break;
      }

      case 'arrive-vuln': {
        await pulseVulnNode(step.node);
        break;
      }

      case 'zoom-out': {
        dot.transition()
          .duration(300)
          .attr('r', 0)
          .attr('opacity', 0)
          .on('end', () => dot.remove());
        await fitAllNodes(root, TIMING.zoomOut);
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLEAR / CANCEL
  // ═══════════════════════════════════════════════════════════════════════

  function clear() {
    animationCancelled = true;
    const container = document.getElementById('canvas-container');
    if (container) container.innerHTML = '';
  }

  return { render: (treeData) => render('canvas-container', treeData), clear, setMeta };
})();
