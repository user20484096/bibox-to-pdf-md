# BiBox Offline-Decryptor

Entschlüsselt lokal gespeicherte BiBox 2.0 Bücher und erzeugt durchsuchbare PDFs mit Text-Overlay, Klartext- und Markdown-Dateien.
Kein OCR — die Buchtexte werden direkt aus den BiBox-Daten übernommen. Keine Zugangsdaten nötig, es werden nur die lokal synchronisierten Dateien gelesen.
Die Markdown-Ausgabe eignet sich besonders gut zur Weiterverarbeitung durch KI-Modelle.

## Voraussetzungen

- BiBox 2.0 Desktop-App (`https://bibox2.westermann.de`) mit mindestens einem offline synchronisierten Buch

## Download (empfohlen)

Unter [Releases](../../releases) stehen fertige Executables zum Download — keine Installation von Python oder Node.js nötig:

- **macOS**: `bibox-macos.zip` — entpacken, dann im Terminal `./bibox` ausführen
- **Windows**: `bibox.exe` — direkt ausführen oder ins Terminal ziehen

### macOS: Gatekeeper-Warnung

macOS blockiert unsignierte Programme. Beim ersten Start:

1. Doppelklick auf `bibox` → "kann nicht geöffnet werden" Meldung
2. **Systemeinstellungen → Datenschutz & Sicherheit** → nach unten scrollen
3. Bei "bibox wurde blockiert" auf **Trotzdem öffnen** klicken

Alternativ im Terminal: `xattr -cr bibox && ./bibox`

### Windows: SmartScreen-Warnung

Beim ersten Start erscheint "Der Computer wurde durch Windows geschützt":

1. Auf **Weitere Informationen** klicken
2. **Trotzdem ausführen** klicken

## Alternative: Python oder Node.js

### uv (Python)

```bash
# uv installieren (macOS / Linux)
curl -LsSf https://astral.sh/uv/install.sh | sh

# uv installieren (Windows)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Ausführen — uv installiert Python und Dependencies automatisch
uv run bibox.py
```

### Node.js

```bash
npm install && node bibox.js
```

## Optionen

| Flag | Beschreibung |
|------|-------------|
| `--output <dir>` | Ausgabeverzeichnis (Standard: `./books`) |
| `--book <id>` | Nur ein bestimmtes Buch (z.B. `--book 1700`) |
| `--no-text` | Kein Text-Overlay im PDF (nur Bilder) |
| `--debug-text` | Text-Overlay rot sichtbar (zum Debuggen) |
| `--save-images` | Einzelne Seitenbilder als JPG/PNG |
| `--no-materials` | Ohne Zusatzmaterialien |
| `--markdown` | Volltext als .md statt .txt |
| `--force` | Vorhandene Bücher überschreiben |

## Ausgabe

```text
books/
  Mathematik heute 7 (1721)/
    Mathematik heute 7.pdf    — Durchsuchbares PDF mit Text-Overlay
    Mathematik heute 7.txt    — Klartext aller Seiten
    Zusatzmaterial.md         — Übersicht Zusatzmaterialien
    Zusatzmaterial/           — Entschlüsselte Materialien + Markdown
```

## Wie funktioniert es?

1. **IndexedDB lesen** — Seiten-URLs und MD5-Hashes aus Chrome IndexedDB
2. **Buchtitel extrahieren** — Titel und IDs aus LevelDB
3. **PageData laden** — Text + Zeichenkoordinaten pro Seite entschlüsseln
4. **Entschlüsselung** — AES-256-CTR (Schlüssel hardcoded in der Electron-App)
5. **PDF erzeugen** — Bilder + unsichtbares Text-Overlay für Suche/Kopieren

## Plattform-Unterstützung

| Plattform | BiBox-Daten |
|---|---|
| macOS | `~/Library/Application Support/BiBox 2.0/` |
| Windows | `%APPDATA%\BiBox 2.0\` |
