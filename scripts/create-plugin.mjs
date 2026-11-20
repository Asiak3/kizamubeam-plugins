#!/usr/bin/env node
// Interactive TUI scaffolding script for new KizamuBeam plugins (similar to create-vite).
// Zero external dependencies; uses Node.js built-in ANSI terminal control.
//
// Usage:
//   npm run create
//   node scripts/create-plugin.mjs [slug] [--template ts|rust] [--type part|assembly|pathtool] [--yes]

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGINS_DIR = join(ROOT, 'plugins');

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  bgCyan: '\x1b[46m',
  black: '\x1b[30m',
};

const S = {
  bar: `${c.gray}│${c.reset}`,
  barActive: `${c.cyan}│${c.reset}`,
  barEnd: `${c.gray}└${c.reset}`,
  stepActive: `${c.cyan}◆${c.reset}`,
  stepDone: `${c.green}◇${c.reset}`,
  stepCancel: `${c.red}■${c.reset}`,
  radioOn: `${c.green}●${c.reset}`,
  radioOff: `${c.gray}○${c.reset}`,
};

const hideCursor = () => process.stdout.write('\x1b[?25l');
const showCursor = () => process.stdout.write('\x1b[?25h');
const clearLines = (n) => {
  if (n <= 0) return;
  for (let i = 0; i < n; i++) {
    process.stdout.write('\x1b[2K'); // clear current line
    if (i < n - 1) process.stdout.write('\x1b[1A'); // move up
  }
  process.stdout.write('\r');
};

function cancelAndExit(msg = 'Vorgang abgebrochen.') {
  showCursor();
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    try { process.stdin.setRawMode(false); } catch {}
  }
  console.log(`${S.bar}`);
  console.log(`${S.stepCancel}  ${c.red}${msg}${c.reset}\n`);
  process.exit(1);
}

// Buffered key-token reader in raw mode (handles pasted text & multi-byte chunks)
function startRawInput() {
  const queue = [];
  let waiting = null;

  const tokenize = (str) => {
    const tokens = [];
    for (let i = 0; i < str.length; ) {
      if (str[i] === '\x1b') {
        if (str[i + 1] === '[' && i + 2 < str.length) {
          tokens.push(str.slice(i, i + 3));
          i += 3;
        } else {
          tokens.push('\x1b');
          i += 1;
        }
      } else {
        const cp = str.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        tokens.push(ch);
        i += ch.length;
      }
    }
    return tokens;
  };

  const onData = (buf) => {
    const tokens = tokenize(buf.toString('utf8'));
    for (const t of tokens) {
      if (waiting) {
        const res = waiting;
        waiting = null;
        res(t);
      } else {
        queue.push(t);
      }
    }
  };

  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', onData);

  return {
    nextKey() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((r) => { waiting = r; });
    },
    stop() {
      process.stdin.off('data', onData);
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdin.pause();
    },
  };
}

// ---------------------------------------------------------------------------
// TUI Prompt Components
// ---------------------------------------------------------------------------

async function promptText({ message, defaultValue = '', placeholder = '', validate }) {
  let value = '';
  let error = '';
  let renderedLines = 0;

  const render = (first = false) => {
    if (!first) clearLines(renderedLines);
    const lines = [];
    lines.push(`${S.stepActive}  ${c.bold}${message}${c.reset}`);
    const display = value.length > 0
      ? `${value}${c.cyan}█${c.reset}`
      : `${c.gray}${placeholder || defaultValue}${c.reset}${c.cyan}█${c.reset}`;
    lines.push(`${S.barActive}  ${display}`);
    if (error) {
      lines.push(`${S.barActive}  ${c.red}▲ ${error}${c.reset}`);
    } else if (defaultValue) {
      lines.push(`${S.barActive}  ${c.dim}Enter für Standard (${defaultValue})${c.reset}`);
    } else {
      lines.push(`${S.barActive}`);
    }
    process.stdout.write(lines.join('\n'));
    renderedLines = lines.length;
  };

  hideCursor();
  render(true);
  const input = startRawInput();

  try {
    while (true) {
      const str = await input.nextKey();

      // Ctrl+C or Escape
      if (str === '\x03' || str === '\x1b') {
        clearLines(renderedLines);
        cancelAndExit();
      }

      // Enter
      if (str === '\r' || str === '\n') {
        const finalVal = (value.trim() === '' && defaultValue !== '') ? defaultValue : value.trim();
        const err = validate ? validate(finalVal) : '';
        if (err) {
          error = err;
          render(false);
          continue;
        }
        clearLines(renderedLines);
        showCursor();
        console.log(`${S.stepDone}  ${c.bold}${message}${c.reset}`);
        console.log(`${S.bar}  ${c.dim}${finalVal}${c.reset}`);
        console.log(`${S.bar}`);
        return finalVal;
      }

      // Backspace
      if (str === '\x7f' || str === '\b') {
        if (value.length > 0) value = value.slice(0, -1);
        error = '';
        render(false);
        continue;
      }

      // Ignore other control / escape sequences
      if (str.startsWith('\x1b') || str.charCodeAt(0) < 32) {
        continue;
      }

      value += str;
      error = '';
      render(false);
    }
  } finally {
    input.stop();
  }
}

async function promptSelect({ message, options }) {
  let index = 0;
  let renderedLines = 0;

  const render = (first = false) => {
    if (!first) clearLines(renderedLines);
    const lines = [];
    lines.push(`${S.stepActive}  ${c.bold}${message}${c.reset}`);
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const active = i === index;
      const radio = active ? S.radioOn : S.radioOff;
      const label = active ? `${c.cyan}${c.bold}${opt.label}${c.reset}` : `${c.dim}${opt.label}${c.reset}`;
      const hint = opt.hint ? ` ${c.gray}— ${opt.hint}${c.reset}` : '';
      lines.push(`${S.barActive}  ${radio} ${label}${hint}`);
    }
    lines.push(`${S.barActive}  ${c.dim}↑/↓ zum Wählen, Enter zum Bestätigen${c.reset}`);
    process.stdout.write(lines.join('\n'));
    renderedLines = lines.length;
  };

  hideCursor();
  render(true);
  const input = startRawInput();

  try {
    while (true) {
      const str = await input.nextKey();

      if (str === '\x03' || str === '\x1b') {
        clearLines(renderedLines);
        cancelAndExit();
      }

      if (str === '\x1b[A' || str === 'k') {
        index = (index - 1 + options.length) % options.length;
        render(false);
        continue;
      }

      if (str === '\x1b[B' || str === 'j') {
        index = (index + 1) % options.length;
        render(false);
        continue;
      }

      if (str === '\r' || str === '\n') {
        const chosen = options[index];
        clearLines(renderedLines);
        showCursor();
        console.log(`${S.stepDone}  ${c.bold}${message}${c.reset}`);
        console.log(`${S.bar}  ${c.dim}${chosen.label}${c.reset}`);
        console.log(`${S.bar}`);
        return chosen.value;
      }
    }
  } finally {
    input.stop();
  }
}

async function promptConfirm({ message, initialValue = true }) {
  let value = initialValue;
  let renderedLines = 0;

  const render = (first = false) => {
    if (!first) clearLines(renderedLines);
    const yes = value ? `${S.radioOn} ${c.cyan}${c.bold}Ja${c.reset}` : `${S.radioOff} ${c.dim}Ja${c.reset}`;
    const no = !value ? `${S.radioOn} ${c.cyan}${c.bold}Nein${c.reset}` : `${S.radioOff} ${c.dim}Nein${c.reset}`;
    const lines = [
      `${S.stepActive}  ${c.bold}${message}${c.reset}`,
      `${S.barActive}  ${yes}   ${no}   ${c.dim}(←/→, j/n, Enter)${c.reset}`,
    ];
    process.stdout.write(lines.join('\n'));
    renderedLines = lines.length;
  };

  hideCursor();
  render(true);
  const input = startRawInput();

  try {
    while (true) {
      const str = await input.nextKey();

      if (str === '\x03' || str === '\x1b') {
        clearLines(renderedLines);
        cancelAndExit();
      }

      if (str === '\x1b[D' || str === '\x1b[C' || str === '\t' || str === 'h' || str === 'l') {
        value = !value;
        render(false);
        continue;
      }
      if (str.toLowerCase() === 'y' || str.toLowerCase() === 'j') {
        value = true;
        render(false);
        continue;
      }
      if (str.toLowerCase() === 'n') {
        value = false;
        render(false);
        continue;
      }

      if (str === '\r' || str === '\n') {
        clearLines(renderedLines);
        showCursor();
        console.log(`${S.stepDone}  ${c.bold}${message}${c.reset}`);
        console.log(`${S.bar}  ${c.dim}${value ? 'Ja' : 'Nein'}${c.reset}`);
        console.log(`${S.bar}`);
        return value;
      }
    }
  } finally {
    input.stop();
  }
}

// ---------------------------------------------------------------------------
// Helpers & CLI parsing
// ---------------------------------------------------------------------------

function slugToTitle(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getGitUserName() {
  try {
    return execSync('git config user.name', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const opts = { slug: '', template: '', type: '', yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-y' || a === '--yes') opts.yes = true;
    else if (a === '--template' && argv[i + 1]) opts.template = argv[++i];
    else if (a === '--type' && argv[i + 1]) opts.type = argv[++i];
    else if (!a.startsWith('-') && !opts.slug) opts.slug = a;
  }
  return opts;
}

function printHelp() {
  console.log(`
${c.bold}KizamuBeam Plugin Creator${c.reset}

Verwendung:
  npm run create
  node scripts/create-plugin.mjs [slug] [Optionen]

Optionen:
  --template <ts|rust>            Sprache / Runtime (ts oder rust)
  --type <part|assembly|pathtool> Plugin-Typ (part, assembly oder pathtool)
  -y, --yes                       Ohne Rückfragen mit Standardwerten erstellen
  -h, --help                      Diese Hilfe anzeigen
`);
}

// ---------------------------------------------------------------------------
// File Generators
// ---------------------------------------------------------------------------

function buildManifest(cfg) {
  const isRust = cfg.template === 'rust';
  const isPathTool = cfg.type === 'pathtool';

  const build = isRust
    ? [{ rust: '.', out: 'dist/plugin.wasm' }]
    : [{ esbuild: 'src/index.ts', out: 'dist/plugin.js' }];

  const pluginEntry = {
    id: cfg.id,
    type: isPathTool ? 'pathtool' : 'generator',
    api: 1,
    version: 1,
    ...(isPathTool ? {} : { kind: cfg.type }),
    runtime: isRust ? 'wasm' : 'js',
    code: isRust ? '@dist/plugin.wasm' : '@dist/plugin.js',
    ...(isPathTool ? { host: ['boolean'] } : {}),
    dialog: { version: 1 },
    icon: cfg.icon,
    params: isPathTool
      ? [
          { key: 'offset', type: 'length', min: 0.5, max: 20, def: 2 },
        ]
      : [
          { key: 'width', type: 'length', min: 10, max: 500, def: 80 },
          { key: 'height', type: 'length', min: 10, max: 300, def: 40 },
          { key: 'corner', type: 'length', min: 0, max: 50, def: 4 },
        ],
    texts: isPathTool
      ? {
          en: {
            name: cfg.nameEn,
            desc: cfg.descEn,
            keys: cfg.slug.replace(/-/g, ' '),
            offset: 'Offset',
            'no-selection': 'Please select at least one shape.',
          },
          de: {
            name: cfg.nameDe,
            desc: cfg.descDe,
            keys: cfg.slug.replace(/-/g, ' '),
            offset: 'Abstand',
            'no-selection': 'Bitte mindestens eine Form auswählen.',
          },
        }
      : {
          en: {
            name: cfg.nameEn,
            desc: cfg.descEn,
            keys: cfg.slug.replace(/-/g, ' '),
            label: `${cfg.nameEn} {width} × {height}`,
            width: 'Width',
            height: 'Height',
            corner: 'Corner radius',
            'corner-too-large': 'The corner radius is larger than half the part.',
            area: 'Area',
          },
          de: {
            name: cfg.nameDe,
            desc: cfg.descDe,
            keys: cfg.slug.replace(/-/g, ' '),
            label: `${cfg.nameDe} {width} × {height}`,
            width: 'Breite',
            height: 'Höhe',
            corner: 'Eckenradius',
            'corner-too-large': 'Der Eckenradius ist größer als die halbe Seite.',
            area: 'Fläche',
          },
        },
  };

  return JSON.stringify(
    {
      format: 'kizamubeam-pack',
      formatVersion: 2,
      id: cfg.id,
      version: cfg.version,
      name: {
        en: cfg.nameEn,
        de: cfg.nameDe,
      },
      description: {
        en: cfg.descEn,
        de: cfg.descDe,
      },
      author: cfg.author,
      build,
      plugins: [pluginEntry],
    },
    null,
    2,
  ) + '\n';
}

function buildTypeScriptSource(cfg) {
  if (cfg.type === 'pathtool') {
    return `// ${cfg.nameDe} — KizamuBeam Path Tool Plugin (${cfg.id})
import { definePathTool, type Issue } from '../../../sdk/ts';

interface Params {
  [k: string]: number | string | boolean;
  offset: number;
}

definePathTool<Params>({
  validate(_p, selection) {
    const issues: Issue[] = [];
    if (!selection || selection.length === 0) {
      issues.push({ level: 'error', code: 'no-selection' });
    }
    return issues;
  },
  apply({ params, selection }) {
    // TODO: Pfade aus \`selection\` verarbeiten (params.offset nutzen)
    return {
      polys: selection.flatMap((s) => s.polys),
      info: [['offset', \`\${params.offset} mm\`]],
    };
  },
});
`;
  }

  if (cfg.type === 'assembly') {
    return `// ${cfg.nameDe} — KizamuBeam Assembly Generator (${cfg.id})
import { definePlugin, mm, roundedRect, type Issue } from '../../../sdk/ts';

interface Params {
  [k: string]: number | string | boolean;
  width: number;
  height: number;
  corner: number;
}

definePlugin<Params>({
  validate(p) {
    const out: Issue[] = [];
    if (p.corner * 2 > Math.min(p.width, p.height)) {
      out.push({ key: 'corner', level: 'error', code: 'corner-too-large' });
    }
    return out;
  },
  generate(p) {
    const base = roundedRect(p.width, p.height, p.corner);
    const lid = roundedRect(p.width, p.height, p.corner);
    return {
      parts: [
        { key: 'base', subs: [base], at: { x: 0, y: 0 } },
        { key: 'lid', subs: [lid], at: { x: p.width + 10, y: 0 } },
      ],
      info: [['area', \`\${mm(p.width * p.height)} mm²\`]],
    };
  },
});
`;
  }

  return `// ${cfg.nameDe} — KizamuBeam Generator Plugin (${cfg.id})
import { definePlugin, mm, roundedRect, type Issue } from '../../../sdk/ts';

interface Params {
  [k: string]: number | string | boolean;
  width: number;
  height: number;
  corner: number;
}

definePlugin<Params>({
  validate(p) {
    const out: Issue[] = [];
    if (p.corner * 2 > Math.min(p.width, p.height)) {
      out.push({ key: 'corner', level: 'error', code: 'corner-too-large' });
    }
    return out;
  },
  generate(p) {
    const subs = [roundedRect(p.width, p.height, p.corner)];
    return {
      parts: [{ key: 'part', subs, at: { x: 0, y: 0 } }],
      info: [['area', \`\${mm(p.width * p.height)} mm²\`]],
    };
  },
});
`;
}

function buildCargoToml(cfg) {
  return `[package]
name = "kzb-${cfg.slug}"
version = "${cfg.version}"
edition = "2021"
license = "GPL-3.0-or-later"
description = "${cfg.descEn.replace(/"/g, '\\"')}"
publish = false

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
kzb-plugin = { path = "../../sdk/rust" }
serde = { version = "1", features = ["derive"] }

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = true

[workspace]
`;
}

function buildRustSource(cfg) {
  return `//! ${cfg.nameDe} — KizamuBeam Generator Plugin (${cfg.id})
use kzb_plugin::{export_plugin, geom, GenResult, Issue, Part, Plugin};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub width: f64,
    pub height: f64,
    pub corner: f64,
}

pub struct MyPlugin;

impl Plugin for MyPlugin {
    type Params = Params;

    fn validate(p: &Params) -> Vec<Issue> {
        let mut out = vec![];
        if p.corner * 2.0 > p.width.min(p.height) {
            out.push(Issue::error("corner-too-large").on("corner"));
        }
        out
    }

    fn generate(p: &Params) -> Result<GenResult, String> {
        let subs = vec![geom::rounded_rect(p.width, p.height, p.corner)];
        let area = (p.width * p.height * 1000.0).round() / 1000.0;
        Ok(GenResult::new()
            .part(Part::new("part", subs))
            .info("area", format!("{area} mm²")))
    }
}

export_plugin!(MyPlugin);
`;
}

function writePluginFiles(cfg) {
  const targetDir = join(PLUGINS_DIR, cfg.slug);
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(join(targetDir, 'src'), { recursive: true });

  writeFileSync(join(targetDir, 'plugin.json'), buildManifest(cfg), 'utf8');

  if (cfg.template === 'rust') {
    writeFileSync(join(targetDir, 'Cargo.toml'), buildCargoToml(cfg), 'utf8');
    writeFileSync(join(targetDir, '.gitignore'), '/target\n/dist\n', 'utf8');
    writeFileSync(join(targetDir, 'src', 'lib.rs'), buildRustSource(cfg), 'utf8');
  } else {
    writeFileSync(join(targetDir, 'src', 'index.ts'), buildTypeScriptSource(cfg), 'utf8');
  }

  return targetDir;
}

// ---------------------------------------------------------------------------
// Main Flow
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // Handle Ctrl+C gracefully even outside raw prompts
  process.on('SIGINT', () => cancelAndExit());

  if (!isTTY && !args.yes) {
    console.error('Fehler: Interaktive TUI benötigt ein TTY. Nutze `--yes` für nicht-interaktive Ausführung.');
    process.exit(1);
  }

  if (isTTY && !args.yes) {
    console.log('');
    console.log(`${c.bgCyan}${c.black}${c.bold}  KizamuBeam Plugin Creator  ${c.reset}`);
    console.log(`${S.bar}`);
  }

  // 1. Slug
  let slug = args.slug || 'mein-plugin';
  if (!args.yes) {
    slug = await promptText({
      message: 'Plugin-Name (Ordnername unter plugins/)',
      defaultValue: args.slug || 'mein-plugin',
      validate: (v) => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) {
          return 'Nur Kleinbuchstaben, Ziffern und Bindestriche erlaubt (z. B. mein-plugin).';
        }
        return '';
      },
    });
  }

  const targetDir = join(PLUGINS_DIR, slug);
  if (existsSync(targetDir) && !args.yes) {
    const overwrite = await promptConfirm({
      message: `Ordner plugins/${slug} existiert bereits. Überschreiben?`,
      initialValue: false,
    });
    if (!overwrite) cancelAndExit('Bestehender Ordner wurde nicht überschrieben.');
  }

  // 2. Template / Runtime
  let template = args.template;
  if (!template && !args.yes) {
    template = await promptSelect({
      message: 'Sprache / Runtime wählen',
      options: [
        { value: 'ts', label: 'TypeScript (QuickJS)', hint: 'Empfohlen · schneller Build mit esbuild' },
        { value: 'rust', label: 'Rust (WebAssembly)', hint: 'Kompiliert nach .wasm' },
      ],
    });
  }
  template = template || 'ts';

  // 3. Plugin type
  let type = args.type;
  if (!type && !args.yes) {
    const typeOptions = template === 'rust'
      ? [
          { value: 'part', label: 'Generator · Einzelteil (part)', hint: 'Erzeugt ein parametrisches Bauteil' },
          { value: 'assembly', label: 'Generator · Baugruppe (assembly)', hint: 'Mehrere Bauteile / 3D-Pose' },
        ]
      : [
          { value: 'part', label: 'Generator · Einzelteil (part)', hint: 'Erzeugt ein parametrisches Bauteil' },
          { value: 'assembly', label: 'Generator · Baugruppe (assembly)', hint: 'Mehrere Bauteile / 3D-Pose' },
          { value: 'pathtool', label: 'Pfadwerkzeug (pathtool)', hint: 'Bearbeitet ausgewählte Konturen' },
        ];
    type = await promptSelect({
      message: 'Plugin-Typ wählen',
      options: typeOptions,
    });
  }
  type = type || 'part';

  const defaultTitle = slugToTitle(slug);
  const gitAuthor = getGitUserName() || 'Your name';

  // 4. Reverse-domain ID
  let id = `com.example.${slug}`;
  if (!args.yes) {
    id = await promptText({
      message: 'Eindeutige Plugin-ID (Reverse-Domain)',
      defaultValue: id,
      validate: (v) =>
        /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)
          ? ''
          : 'Bitte gültige Reverse-Domain-ID angeben (z. B. com.example.mein-plugin).',
    });
  }

  // 5. Display names & descriptions
  let nameDe = defaultTitle;
  let nameEn = defaultTitle;
  let descDe = `Parametrisches KizamuBeam-Plugin: ${defaultTitle}.`;
  let descEn = `Parametric KizamuBeam plugin: ${defaultTitle}.`;

  if (!args.yes) {
    nameDe = await promptText({
      message: 'Anzeigename (Deutsch)',
      defaultValue: nameDe,
    });
    nameEn = await promptText({
      message: 'Anzeigename (Englisch)',
      defaultValue: nameDe,
    });
    descDe = await promptText({
      message: 'Kurzbeschreibung (Deutsch)',
      defaultValue: descDe,
    });
    descEn = await promptText({
      message: 'Kurzbeschreibung (Englisch)',
      defaultValue: descEn,
    });
  }

  // 6. Author & Version
  let author = gitAuthor;
  let version = '1.0.0';
  if (!args.yes) {
    author = await promptText({
      message: 'Autor',
      defaultValue: author,
    });
    version = await promptText({
      message: 'Version (SemVer)',
      defaultValue: version,
      validate: (v) =>
        /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(v) ? '' : 'Bitte gültige Version angeben (z. B. 1.0.0).',
    });
  }

  // 7. Icon
  let icon = type === 'pathtool' ? 'text' : type === 'assembly' ? 'box' : 'rect';
  if (!args.yes) {
    icon = await promptSelect({
      message: 'Icon in KizamuBeam wählen',
      options: [
        { value: 'rect', label: 'rect', hint: 'Rechteck / Schild' },
        { value: 'box', label: 'box', hint: 'Box / Gehäuse' },
        { value: 'grid', label: 'grid', hint: 'Raster / Spielfeld' },
        { value: 'pattern', label: 'pattern', hint: 'Muster / Lochplatte' },
        { value: 'stack', label: 'stack', hint: 'Ebenen / Schichten' },
        { value: 'measure', label: 'measure', hint: 'Lineal / Maß' },
        { value: 'text', label: 'text', hint: 'Text / Schablone' },
        { value: 'target', label: 'target', hint: 'Ziel / Karte' },
      ],
    });
  }

  const cfg = { slug, template, type, id, nameDe, nameEn, descDe, descEn, author, version, icon };

  // 8. Summary & Confirm
  if (!args.yes) {
    console.log(`${S.stepDone}  ${c.bold}Zusammenfassung${c.reset}`);
    console.log(`${S.bar}  ${c.dim}Ordner:${c.reset}   plugins/${cfg.slug}`);
    console.log(`${S.bar}  ${c.dim}Sprache:${c.reset}  ${cfg.template === 'rust' ? 'Rust (WASM)' : 'TypeScript (QuickJS)'}`);
    console.log(`${S.bar}  ${c.dim}Typ:${c.reset}      ${cfg.type}`);
    console.log(`${S.bar}  ${c.dim}ID:${c.reset}       ${cfg.id}`);
    console.log(`${S.bar}  ${c.dim}Name:${c.reset}     ${cfg.nameDe} / ${cfg.nameEn}`);
    console.log(`${S.bar}  ${c.dim}Autor:${c.reset}    ${cfg.author} (v${cfg.version})`);
    console.log(`${S.bar}`);

    const ok = await promptConfirm({
      message: 'Plugin-Projekt jetzt anlegen?',
      initialValue: true,
    });
    if (!ok) cancelAndExit();
  }

  const created = writePluginFiles(cfg);

  console.log(`${S.barEnd}  ${c.green}${c.bold}Plugin erfolgreich erstellt!${c.reset} ${c.dim}(${created})${c.reset}\n`);
  console.log(`${c.bold}Nächste Schritte:${c.reset}`);
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.log(`  ${c.cyan}npm install${c.reset}`);
  }
  console.log(`  ${c.cyan}npm run pack -- plugins/${cfg.slug}${c.reset}`);
  console.log(`  ${c.cyan}npm test${c.reset}\n`);
}

main().catch((err) => {
  showCursor();
  console.error(err);
  process.exit(1);
});
