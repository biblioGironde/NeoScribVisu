// Petit serveur local pour consulter le tableau de bord : npm start puis http://localhost:8080
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { RACINE } from './lib.mjs';

const DOSSIER = path.join(RACINE, 'public');
const PORT = Number(process.env.PORT ?? 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const fichier = path.join(DOSSIER, url.endsWith('/') ? `${url}index.html` : url);
  if (!fichier.startsWith(DOSSIER) || !fs.existsSync(fichier)) { res.writeHead(404); res.end('Introuvable'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(fichier)] ?? 'application/octet-stream' });
  fs.createReadStream(fichier).pipe(res);
}).listen(PORT, () => console.log(`Tableau de bord : http://localhost:${PORT}`));
