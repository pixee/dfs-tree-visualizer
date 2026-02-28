/**
 * App Controller — wires dropdown, fetch, normalize, render, sidebar.
 */
(async function () {
  const select = document.getElementById('repo-select');
  const DEFAULT_REPO = 'jenkins';
  let resizeTimer;

  // Fetch repo list
  const repos = await fetch('/api/repos').then(r => r.json());
  select.innerHTML = repos.map(r =>
    `<option value="${r.id}" ${r.id === DEFAULT_REPO ? 'selected' : ''}>${r.displayName}</option>`
  ).join('');

  // Load on change
  select.addEventListener('change', () => loadRepo(select.value));

  // Debounced resize
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (select.value) loadRepo(select.value);
    }, 250);
  });

  // Initial load
  loadRepo(DEFAULT_REPO);

  async function loadRepo(id) {
    const raw = await fetch(`/api/data/${id}`).then(r => r.json());
    const { meta, tree } = DataNormalizer.normalize(raw);

    updateSidebar(meta);
    Tooltip.setVulnMeta(meta);
    TreeRenderer.setMeta(meta);
    TreeRenderer.clear();
    TreeRenderer.render(tree);
  }

  function updateSidebar(meta) {
    document.getElementById('sb-project').textContent = meta.projectName;
    document.getElementById('sb-ecosystem').textContent = meta.ecosystem || '--';

    const vulnIdEl = document.getElementById('sb-vuln-id');
    vulnIdEl.textContent = meta.vulnId || '--';

    const sevEl = document.getElementById('sb-vuln-severity');
    sevEl.textContent = meta.vulnSeverity || '--';
    sevEl.className = 'severity-badge';
    if (meta.vulnSeverity) {
      sevEl.classList.add(`severity-${meta.vulnSeverity}`);
    }

    document.getElementById('sb-vuln-pkg').textContent = meta.vulnPackage || '--';
    document.getElementById('sb-vuln-desc').textContent = meta.vulnDescription || '--';
    document.getElementById('sb-depth').textContent = meta.chainDepth;
    document.getElementById('sb-paths').textContent = meta.totalPaths +
      (meta.multiPath ? ` (${meta.displayPaths} shown)` : '');

    const addSection = document.getElementById('sb-additional-section');
    const addList = document.getElementById('sb-additional');
    if (meta.additionalVulns && meta.additionalVulns.length > 0) {
      addSection.style.display = '';
      addList.innerHTML = meta.additionalVulns.map(v => `<li>${escHtml(v)}</li>`).join('');
    } else {
      addSection.style.display = 'none';
    }
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
})();
