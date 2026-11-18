# KizamuBeam Plugins

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/kizamubeam-logo-dark.png">
    <img src="docs/brand/kizamubeam-logo.png" alt="KizamuBeam" width="520">
  </picture>
</p>

<p align="center">
  <b>Plugins (Generatoren, Pfadwerkzeuge und Erweiterungen) für KizamuBeam.</b>
</p>

<p align="center">
  <a href="https://github.com/KizamuBeam/kizamubeam">KizamuBeam</a> ·
  <a href="https://github.com/KizamuBeam/kizamubeam-packs">Pakete (Motive & Pattern)</a> ·
  <a href="https://github.com/KizamuBeam/kizamubeam-devices">Geräteprofile</a> ·
  <a href="https://kizamubeam.github.io/kizamubeam/docs/de/">Handbuch</a> ·
  <a href="https://discord.gg/SSr8VHh7EJ">Discord</a> ·
  <a href="README.md">English</a>
</p>

Dieses Repository enthält Plugins für [KizamuBeam](https://github.com/KizamuBeam/kizamubeam) – darunter parametrische Generatoren, Pfadwerkzeuge sowie SDKs und Vorlagen für TypeScript (QuickJS) und Rust (WebAssembly).

## Aufbau

| Ordner | Zweck |
| --- | --- |
| `plugins/` | Einzelne Plugins (`plugins/<name>/plugin.json` + Quellcode) |
| `sdk/` | Plugin-SDKs für TypeScript (`sdk/ts/`) und Rust (`sdk/rust/`) |
| `templates/` | Starter-Vorlagen für TypeScript- und Rust-Plugins |
| `scripts/` | Build- und Prüfskripte (`plugin-pack.mjs`, `validate.mjs`) |

## Eigenes Plugin erstellen

1. Eine Vorlage nach `plugins/` kopieren:
   - **TypeScript:** `cp -r templates/typescript plugins/mein-plugin`
   - **Rust (WASM):** `cp -r templates/rust plugins/mein-plugin`
2. In `plugins/mein-plugin/plugin.json` eine eindeutige `id`, `name`, `version` und `author` eintragen.
3. Ein `.kzp`-Erweiterungspaket bauen:
   ```bash
   npm install
   npm run pack -- plugins/mein-plugin
   ```
   Die fertige `.kzp`-Datei landet unter `plugins/mein-plugin/dist/<id>.kzp` und lässt sich in KizamuBeam über **Datei → Erweiterungspakete …** installieren.
4. Alle Plugins prüfen:
   ```bash
   npm test
   ```

Die vollständige API-Dokumentation steht in [docs/plugins.md](https://github.com/KizamuBeam/kizamubeam/blob/main/docs/plugins.md) im Haupt-Repository.

## Lizenz

GPL-3.0-or-later — siehe [LICENSE](LICENSE).
