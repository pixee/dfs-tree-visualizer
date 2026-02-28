/**
 * Tooltip — hover details for tree nodes.
 */
const Tooltip = (() => {
  let el;
  let vulnMeta = {};

  function init() {
    el = document.getElementById('tooltip');
  }

  function setVulnMeta(meta) {
    vulnMeta = meta || {};
  }

  function show(event, nodeData) {
    if (!el) init();

    let html = `<div class="tt-name">${esc(nodeData.name)}</div>`;
    if (nodeData.version) {
      html += `<div class="tt-version">${esc(nodeData.version)}</div>`;
    }
    html += `<div class="tt-type">${esc(nodeData.nodeType)}</div>`;

    if (nodeData.nodeType === 'vulnerable' && vulnMeta.vulnId) {
      html += `<div class="tt-cve">${esc(vulnMeta.vulnId)}</div>`;
      html += `<div class="tt-severity">${esc(vulnMeta.vulnSeverity)}</div>`;
      if (vulnMeta.vulnDescription) {
        const desc = vulnMeta.vulnDescription.length > 200
          ? vulnMeta.vulnDescription.slice(0, 197) + '...'
          : vulnMeta.vulnDescription;
        html += `<div class="tt-desc">${esc(desc)}</div>`;
      }
    }

    el.innerHTML = html;
    el.style.display = 'block';
    move(event);
  }

  function move(event) {
    if (!el) return;
    const pad = 12;
    let x = event.clientX + pad;
    let y = event.clientY + pad;

    // Keep tooltip on screen
    const rect = el.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = event.clientY - rect.height - pad;

    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  function hide() {
    if (!el) return;
    el.style.display = 'none';
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  return { show, move, hide, setVulnMeta };
})();
