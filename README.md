# Backspin for Windows

A free, local-first two-deck DJ application. Music is decoded and analyzed on your computer; no files are uploaded.

## Run the Windows app

Install dependencies once:

```powershell
npm install
```

Launch Backspin:

```powershell
npm start
```

## Build the installer

```powershell
npm run dist
```

The Windows installer is written to `dist`.

## Automatic updates

Installed builds check the public GitHub Releases feed on launch. Updates download in the background; when ready, the top-bar update button installs the new version and restarts Backspin.

Maintainers publish a release by updating the version in `package.json` and pushing a matching tag:

```powershell
git tag v0.1.3
git push origin v0.1.3
```

## Current features

- Two decks with play/pause, cue points, four hot cues, pitch (±16%), gain, three-band EQ, channel volume, crossfader, and master volume
- Drag tracks from the library onto either deck
- Local audio import by picker or drag-and-drop
- In-browser waveform, BPM, approximate key, and energy analysis
- Smart Picks ranked against the focused deck by BPM, key, and energy
- One-click tempo sync
- Global low-pass/high-pass filter
- Record the master mix to a local WebM audio file
- Keyboard controls: Space plays the focused deck, 1–4 operate hot cues, and S syncs

## Notes

The crate must currently be re-imported each session. Track analysis is intentionally lightweight; BPM/key detection will not yet match professional offline analysis software.
