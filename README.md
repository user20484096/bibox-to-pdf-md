# BiBox Offline-Decryptor

Entschlüsselt lokal gespeicherte BiBox 2.0 Bücher und erzeugt durchsuchbare PDFs mit Text-Overlay, Klartext- und Markdown-Dateien.
Es findet kein OCR statt. Es wird der Text direkt aus BiBox kopiert.
Die Markdown-Ausgabe mit Überschriften, Listen und Absätzen eignet sich besonders gut zur Weiterverarbeitung durch KI-Modelle (z.B. als Kontext für Erklärungen, Zusammenfassungen oder Aufgabenhilfe).

## Voraussetzungen

- **BiBox 2.0 Desktop-App** mit mindestens einem offline synchronisierten Buch
- **[`uv`](https://docs.astral.sh/uv/)** (empfohlen) oder **Node.js** >= 18

## Installation

### uv (empfohlen)

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Keine weitere Installation nötig — `uv` installiert Python und alle Dependencies automatisch beim ersten Start.

## Verwendung

### Python (uv)

```bash
uv run bibox.py [Optionen]
```

### Node.js (Alternative)

```bash
npm install
node bibox.js [Optionen]
```

### Optionen

| Flag | Beschreibung |
|------|-------------|
| `--output <dir>` | Ausgabeverzeichnis (Standard: `./books`) |
| `--book <id>` | Nur ein bestimmtes Buch verarbeiten (z.B. `--book 1700`) |
| `--no-text` | Kein Text-Overlay im PDF (nur Bilder) |
| `--debug-text` | Text-Overlay rot und sichtbar statt unsichtbar (zum Debuggen) |
| `--save-images` | Einzelne Seitenbilder als JPG/PNG speichern |
| `--no-materials` | Ohne Zusatzmaterialien |
| `--materials` | Zusatzmaterial (DOC, PDF etc.) entschlüsseln und speichern |
| `--materials-markdown` | Zusatzmaterial nach Markdown konvertieren |
| `--markdown` | Volltext als .md statt .txt |
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
    Zusatzmaterial/           — Entschlüsselte Materialien + Markdown-Konvertierung
      3507_81278_021.doc
      3507_81278_021.md
      ...
    images/                   — Nur mit --save-images
      page-0001.jpg
      page-0002.jpg
      ...
```

### Beispiele

```bash
# Alle Bücher: PDF + Text + Markdown (Python)
uv run bibox.py

# Nur ein Buch
uv run bibox.py --book 1721

# Alles inkl. Einzelbilder in eigenes Verzeichnis
uv run bibox.py --output ~/Desktop/buecher --save-images

# Nur Bilder-PDF ohne Text (schneller, kleinere Datei)
uv run bibox.py --no-text

# Node.js Alternative
node bibox.js --book 1721
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

**Windows** — Unterstützt. BiBox-Daten liegen in:
```
%APPDATA%\BiBox 2.0\
```

**Linux** — Nicht unterstützt. BiBox 2.0 gibt es nur für macOS und Windows.

## Dependencies

### Python (bibox.py)

- [PyMuPDF](https://pymupdf.readthedocs.io/) — PDF-Erzeugung + Text-Overlay
- [cryptography](https://cryptography.io/) — AES-256-CTR Entschlüsselung

Werden von `uv` automatisch installiert (PEP 723 inline metadata).

### Node.js (bibox.js)

- [pdf-lib](https://www.npmjs.com/package/pdf-lib) — PDF-Erzeugung
- [@pdf-lib/fontkit](https://www.npmjs.com/package/@pdf-lib/fontkit) — Unicode-Font-Embedding
