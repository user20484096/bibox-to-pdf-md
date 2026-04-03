# BiBox Offline-Decryptor

Entschlüsselt lokal gespeicherte BiBox 2.0 Bücher und erzeugt durchsuchbare PDFs mit Text-Overlay, Klartext- und Markdown-Dateien. 
Es findet kein OCR statt. Es wird der Text direkt aus BiBox kopiert
Die Markdown-Ausgabe mit Überschriften, Listen und Absätzen eignet sich besonders gut zur Weiterverarbeitung durch KI-Modelle (z.B. als Kontext für Erklärungen, Zusammenfassungen oder Aufgabenhilfe).

## Voraussetzungen

- **Node.js** >= 18
- **BiBox 2.0 Desktop-App** mit mindestens einem offline synchronisierten Buch
- npm-Abhängigkeiten installiert (siehe unten)

## Node.js installieren

### macOS

Am einfachsten über [Homebrew](https://brew.sh/):

```bash
brew install node
```

Oder über den [offiziellen Installer](https://nodejs.org/en/download).

### Windows

1. Installer herunterladen von [nodejs.org](https://nodejs.org/en/download)
2. `.msi`-Datei ausführen und den Anweisungen folgen
3. Terminal (cmd oder PowerShell) neu öffnen
4. Prüfen: `node --version` sollte `v18.x` oder höher anzeigen

### Prüfen ob Node.js installiert ist

```bash
node --version   # sollte v18.0.0 oder höher sein
npm --version    # sollte mitgeliefert werden
```

## Installation

```bash

cd bibox-to-pdf-md
npm install
```

## Verwendung

```bash
node decrypt-local.mjs [Optionen]
```

### Optionen

| Flag | Beschreibung |
|------|-------------|
| `--output <dir>` | Ausgabeverzeichnis (Standard: `./books`) |
| `--book <id>` | Nur ein bestimmtes Buch verarbeiten (z.B. `--book 1700`) |
| `--no-text` | Kein Text-Overlay im PDF (nur Bilder) |
| `--debug-text` | Text-Overlay rot und sichtbar statt unsichtbar (zum Debuggen) |
| `--save-images` | Einzelne Seitenbilder als JPG/PNG speichern |
| `--materials` | Zusatzmaterial (DOC, PDF etc.) entschlüsseln und speichern |
| `--materials-markdown` | Zusatzmaterial nach Markdown konvertieren (siehe unten) |
| `--force` | Bereits vorhandene Bücher überschreiben |

### Ausgabe

Die Ausgabe wird pro Buch in Unterverzeichnisse organisiert, benannt nach Buchtitel und ID:

```text
books/
  Mathematik heute 7 (1721)/
    Mathematik heute 7.pdf    — Durchsuchbares PDF mit unsichtbarem Text-Overlay
    Mathematik heute 7.txt    — Klartext aller Seiten
    Mathematik heute 7.md     — Markdown mit Überschriften, Listen und Absätzen
    Zusatzmaterial.md         — Übersicht aller Zusatzmaterialien (Titel + Dateinamen)
    Zusatzmaterial/           — Nur mit --materials und/oder --materials-markdown
      3507_81278_021.doc      — Originaldatei (--materials)
      3507_81278_021.md       — Markdown-Konvertierung (--materials-markdown)
      ...
    images/                   — Nur mit --save-images
      page-0001.jpg
      page-0002.jpg
      ...
  Mathematik heute 5 (403)/
    ...
```

### Beispiele

```bash
# Alle Bücher: PDF + Text + Markdown
node decrypt-local.mjs

# Nur ein Buch
node decrypt-local.mjs --book 1721

# Alles inkl. Einzelbilder in eigenes Verzeichnis
node decrypt-local.mjs --output ~/Desktop/buecher --save-images

# Nur Bilder-PDF ohne Text (schneller, kleinere Datei)
node decrypt-local.mjs --no-text

# Zusatzmaterial als Originaldateien herunterladen
node decrypt-local.mjs --materials

# Zusatzmaterial nach Markdown konvertieren
node decrypt-local.mjs --materials-markdown
```

## Wie funktioniert es?

1. **IndexedDB lesen** — Durchsucht die Chrome IndexedDB-Blobs der BiBox-App nach Buch-Metadaten (Seiten-URLs und MD5-Hashes)
2. **Buchtitel extrahieren** — Liest Buchtitel und IDs aus der LevelDB für die Verzeichnisbenennung
3. **PageData laden** — Findet und entschlüsselt die Textdaten (Text + Zeichenkoordinaten pro Seite) aus der LevelDB
4. **Entschlüsselung** — BiBox verschlüsselt Dateien mit AES-256-CTR. Die Schlüssel sind in der Electron-App hardcoded
5. **PDF erzeugen** — Entschlüsselte Bilder werden zu einem PDF zusammengefügt, mit unsichtbarem Text-Overlay für Suche und Kopieren

## Plattform-Unterstützung

**macOS** — Vollständig unterstützt. BiBox-Daten liegen in:
```
~/Library/Application Support/BiBox 2.0/
```

**Windows** — Unterstützt (nicht getestet). BiBox-Daten liegen in:
```
%APPDATA%\BiBox 2.0\
```
Die Font-Suche nutzt `C:\Windows\Fonts\` (Arial Unicode, Arial oder Segoe UI). Verschlüsselung und PDF-Erzeugung sind plattformunabhängig (Node.js crypto + pdf-lib).

**Linux** — Nicht unterstützt. BiBox 2.0 gibt es nur für macOS und Windows.

## Zusatzmaterial-Konvertierung

`--materials-markdown` konvertiert heruntergeladenes Zusatzmaterial (DOC, PDF etc.) nach Markdown/Text. Dafür werden externe Tools benötigt:

| Dateityp    | macOS                       | Windows     | Linux       |
|-------------|-----------------------------| ------------|-------------|
| DOC/DOCX/RTF | `textutil` (vorinstalliert) | LibreOffice | LibreOffice |
| PDF         | `pdftotext` (Poppler)       | LibreOffice | LibreOffice |

**Reihenfolge:** Auf macOS werden zuerst die nativen Tools versucht (`textutil`, `pdftotext`). Wenn diese nicht verfügbar sind oder fehlschlagen, wird LibreOffice als Fallback genutzt. Auf Windows wird direkt LibreOffice verwendet.

**LibreOffice installieren (optional, nur für `--materials-markdown`):**

- macOS: `brew install --cask libreoffice` oder [libreoffice.org](https://www.libreoffice.org/download/)
- Windows: [libreoffice.org](https://www.libreoffice.org/download/) — Standardpfad `C:\Program Files\LibreOffice\` wird automatisch erkannt
- Poppler (macOS, für PDF): `brew install poppler`

Ohne Konvertierungstools werden die betroffenen Dateien still übersprungen. `--materials` (Originaldateien speichern) funktioniert immer ohne zusätzliche Abhängigkeiten.

## Abhängigkeiten

- [pdf-lib](https://www.npmjs.com/package/pdf-lib) — PDF-Erzeugung
- [@pdf-lib/fontkit](https://www.npmjs.com/package/@pdf-lib/fontkit) — Unicode-Font-Embedding

Alle anderen Funktionen nutzen Node.js Built-ins (`crypto`, `fs`, `path`, `os`).
