const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const FILE_PREFIX = 'vulnerable-transitive-dep-';
const FILE_SUFFIX = '.json';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/repos', (_req, res) => {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
    .sort();

  const repos = files.map(f => {
    const id = f.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
    const displayName = id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { id, displayName };
  });

  res.json(repos);
});

app.get('/api/data/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9-]/gi, '');
  const filePath = path.join(DATA_DIR, `${FILE_PREFIX}${id}${FILE_SUFFIX}`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Repo not found' });
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  res.json(data);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DFS Tree Visualizer running at http://localhost:${PORT}`);
});
