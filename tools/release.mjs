// Publica o instalador numa release do GitHub (usada pela atualização automática).
// Uso: npm run release   (gera o exe e publica)   ou   node tools/release.mjs --notes "texto"
// Precisa do GitHub CLI (gh) logado com acesso ao repositório.
// A release leva o exe, o .blockmap e o latest.yml: o app instalado lê o latest.yml
// para saber se há versão nova.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { owner, repo } = pkg.build.publish[0];
const version = pkg.version;
const tag = `v${version}`;
const out = path.join(ROOT, pkg.build.directories.output);
const exe = path.join(out, `Trama-Setup-${version}.exe`);
const files = [exe, `${exe}.blockmap`, path.join(out, 'latest.yml')];

for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`Falta ${path.relative(ROOT, f)}. Rode "npm run dist" antes.`);
    process.exit(1);
  }
}
const yml = fs.readFileSync(files[2], 'utf8');
if (!yml.includes(`version: ${version}`)) {
  console.error(`O latest.yml não é da versão ${version}. Rode "npm run dist" de novo.`);
  process.exit(1);
}

const gh = (args, opts = {}) => execFileSync('gh', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
const exists = (() => {
  try {
    gh(['release', 'view', tag, '-R', `${owner}/${repo}`]);
    return true;
  } catch {
    return false;
  }
})();
if (exists) {
  console.error(`A release ${tag} já existe. Suba a versão em package.json antes de publicar outra.`);
  process.exit(1);
}

const i = process.argv.indexOf('--notes');
const notes = i > 0 ? process.argv[i + 1] : `Trama ${version}. Baixe e rode Trama-Setup-${version}.exe. Quem já tem o Trama instalado recebe o aviso de atualização no próprio app.`;
// A tag aponta para o commit atual, que precisa já estar no GitHub.
const target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
try {
  execFileSync('git', ['branch', '-r', '--contains', target], { cwd: ROOT, encoding: 'utf8' }).trim() || (() => { throw 0; })();
} catch {
  console.error('O commit atual ainda não está no GitHub. Faça git push antes de publicar.');
  process.exit(1);
}

gh(['release', 'create', tag, ...files, '-R', `${owner}/${repo}`, '--title', `Trama ${version}`, '--notes', notes, '--target', target], { stdio: 'inherit' });
console.log(`Publicado: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
