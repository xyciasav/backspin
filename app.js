(() => {
  "use strict";

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContext();
  const masterGain = audioContext.createGain();
  const recorderDestination = audioContext.createMediaStreamDestination();
  masterGain.gain.value = 0.8;
  masterGain.connect(audioContext.destination);
  masterGain.connect(recorderDestination);

  const state = {
    tracks: [],
    view: "all",
    query: "",
    sort: "title",
    focusedDeck: "a",
    mediaRecorder: null,
    recordedChunks: [],
    draggingTrackId: null,
    libraryRenderPending: false
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const filePicker = $("#filePicker");
  const trackList = $("#trackList");
  const emptyState = $("#emptyState");
  const updateButton = $("#updateButton");

  if (window.backspinDesktop?.onUpdateStatus) {
    window.backspinDesktop.onUpdateStatus(status => {
      updateButton.classList.toggle("ready", status.state === "ready");
      updateButton.classList.toggle("downloading", status.state === "downloading");
      updateButton.textContent = status.state === "ready" ? "INSTALL UPDATE" : `↻ ${status.message.toUpperCase()}`;
      updateButton.title = status.message;
      if (["ready", "error"].includes(status.state)) setStatus(status.message.toUpperCase());
    });
  } else {
    updateButton.hidden = true;
  }

  async function chooseMusic(mode = "folder") {
    if (!window.backspinDesktop) {
      filePicker.click();
      return;
    }
    setStatus(`CHOOSING MUSIC ${mode === "files" ? "FILES" : "FOLDER"}…`);
    try {
      const result = mode === "files"
        ? await window.backspinDesktop.chooseMusicFiles()
        : await window.backspinDesktop.chooseMusicFolder();
      if (!result.files.length) {
        const detail = result.warnings?.[0]?.reason;
        setStatus(detail ? `NO READABLE MUSIC FOUND · ${detail}` : "NO SUPPORTED MUSIC FOUND");
        return;
      }
      await addNativeFiles(result.files);
      if (result.skipped) setStatus(`${result.files.length} ADDED · ${result.skipped} UNREADABLE FILE${result.skipped === 1 ? "" : "S"} SKIPPED`);
    } catch (error) {
      console.error("Folder import failed", error);
      setStatus(`IMPORT FAILED · ${error.message || "COULD NOT READ MUSIC"}`);
    }
  }

  function audioMimeType(filename) {
    const extension = filename.split(".").pop().toLowerCase();
    return ({
      mp3: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      aac: "audio/aac",
      flac: "audio/flac",
      ogg: "audio/ogg",
      opus: "audio/opus"
    })[extension] || "application/octet-stream";
  }

  function makeDeck(id) {
    const root = $(`.deck-${id}`);
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    const source = audioContext.createMediaElementSource(audio);
    const low = audioContext.createBiquadFilter();
    const mid = audioContext.createBiquadFilter();
    const high = audioContext.createBiquadFilter();
    const filter = audioContext.createBiquadFilter();
    const gain = audioContext.createGain();
    const channel = audioContext.createGain();
    const analyser = audioContext.createAnalyser();

    low.type = "lowshelf"; low.frequency.value = 250;
    mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.7;
    high.type = "highshelf"; high.frequency.value = 4000;
    filter.type = "allpass";
    analyser.fftSize = 256;
    source.connect(low).connect(mid).connect(high).connect(filter).connect(gain).connect(channel).connect(analyser).connect(masterGain);

    const deck = {
      id, root, audio, source, low, mid, high, filter, gain, channel, analyser,
      track: null, baseBpm: 0, cue: 0, hotCues: [null, null, null, null],
      waveform: [], animation: null
    };

    root.addEventListener("pointerdown", () => { state.focusedDeck = id; });
    root.addEventListener("dragover", event => event.preventDefault());
    root.addEventListener("drop", event => {
      event.preventDefault();
      const trackId = event.dataTransfer.getData("application/x-backspin-track") || event.dataTransfer.getData("text/plain");
      const track = state.tracks.find(item => item.id === trackId);
      if (track) loadTrack(deck, track);
    });

    $("[data-action=play]", root).addEventListener("click", () => togglePlay(deck));
    $("[data-action=cue]", root).addEventListener("click", () => cueDeck(deck));
    $("[data-action=sync]", root).addEventListener("click", () => syncDeck(deck));
    $("[data-action=eject]", root).addEventListener("click", () => ejectDeck(deck));
    $("[data-action=load]", root).addEventListener("click", () => loadSelectedOrFirst(deck));
    $("[data-action=pitch-reset]", root).addEventListener("click", () => {
      const pitch = $("[data-control=pitch]", root);
      pitch.value = 0;
      pitch.dispatchEvent(new Event("input"));
    });
    $$("[data-hotcue]", root).forEach(button => button.addEventListener("click", () => useHotCue(deck, Number(button.dataset.hotcue))));
    $$("[data-control]", root).forEach(control => control.addEventListener("input", () => updateControl(deck, control)));
    audio.addEventListener("play", () => updatePlayingUi(deck));
    audio.addEventListener("pause", () => updatePlayingUi(deck));
    audio.addEventListener("ended", () => updatePlayingUi(deck));
    audio.addEventListener("timeupdate", () => updateTimeUi(deck));
    return deck;
  }

  const decks = { a: makeDeck("a"), b: makeDeck("b") };

  function setupRotaryControls() {
    $$(".knob-control input, .big-knob input").forEach(input => {
      let activePointer = null;
      const render = () => {
        const min = Number(input.min);
        const max = Number(input.max);
        const progress = (Number(input.value) - min) / (max - min);
        input.style.setProperty("--knob-sweep", `${Math.max(0, Math.min(1, progress)) * 270}deg`);
      };
      const setFromPointer = event => {
        const rect = input.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        let angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (angle > 180) angle -= 360;
        angle = Math.max(-135, Math.min(135, angle));
        const min = Number(input.min);
        const max = Number(input.max);
        const step = Number(input.step) || 1;
        const raw = min + ((angle + 135) / 270) * (max - min);
        input.value = Math.round(raw / step) * step;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      input.addEventListener("pointerdown", event => {
        activePointer = event.pointerId;
        input.setPointerCapture(event.pointerId);
        setFromPointer(event);
        event.preventDefault();
      });
      input.addEventListener("pointermove", event => {
        if (event.pointerId === activePointer) setFromPointer(event);
      });
      input.addEventListener("pointerup", event => {
        if (event.pointerId === activePointer) activePointer = null;
      });
      input.addEventListener("wheel", event => {
        event.preventDefault();
        const step = Number(input.step) || 1;
        const direction = event.deltaY < 0 ? 1 : -1;
        input.value = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + direction * step));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, { passive: false });
      input.addEventListener("input", render);
      render();
    });
  }

  function resumeAudio() {
    if (audioContext.state !== "running") audioContext.resume();
    $("#audioButton").innerHTML = "<span></span> AUDIO LIVE";
  }

  async function addFiles(files) {
    resumeAudio();
    const audioFiles = [...files].filter(file => file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(file.name));
    if (!audioFiles.length) return setStatus("NO AUDIO FILES FOUND");
    setStatus(`READING ${audioFiles.length} TRACK${audioFiles.length === 1 ? "" : "S"}…`);
    for (const file of audioFiles) {
      const duplicate = state.tracks.some(track => track.name === file.name && track.size === file.size);
      if (duplicate) continue;
      const metadata = parseFilename(file.name);
      const track = {
        id: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
        getArrayBuffer: () => file.arrayBuffer(),
        name: file.name,
        size: file.size,
        title: metadata.title,
        artist: metadata.artist,
        duration: 0,
        bpm: null,
        key: "—",
        energy: 0,
        favorite: false,
        selected: false,
        buffer: null,
        waveform: []
      };
      state.tracks.push(track);
      probeDuration(track);
      analyzeTrack(track);
    }
    renderLibrary();
    setStatus(`${state.tracks.length} TRACKS READY`);
  }

  async function addNativeFiles(files) {
    resumeAudio();
    if (!files.length) return setStatus("NO AUDIO FILES FOUND");
    setStatus(`ADDING ${files.length} TRACK${files.length === 1 ? "" : "S"}…`);
    for (const item of files) {
      const duplicate = state.tracks.some(track => track.name === item.name && track.size === item.size);
      if (duplicate) continue;
      const metadata = parseFilename(item.name);
      const track = {
        id: crypto.randomUUID(),
        file: null,
        url: item.url,
        getArrayBuffer: async () => {
          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Could not read track (${response.status})`);
          return response.arrayBuffer();
        },
        name: item.name,
        size: item.size,
        title: metadata.title,
        artist: metadata.artist,
        duration: 0,
        bpm: null,
        key: "—",
        energy: 0,
        favorite: false,
        selected: false,
        buffer: null,
        waveform: []
      };
      state.tracks.push(track);
      probeDuration(track);
      analyzeTrack(track);
    }
    renderLibrary();
    setStatus(`${state.tracks.length} TRACKS READY`);
  }

  function parseFilename(filename) {
    const clean = filename.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
    const parts = clean.split(/\s+-\s+/);
    return parts.length > 1
      ? { artist: parts.shift(), title: parts.join(" - ") }
      : { artist: "Unknown artist", title: clean };
  }

  function probeDuration(track) {
    const audio = new Audio(track.url);
    audio.addEventListener("loadedmetadata", () => {
      track.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      requestLibraryRender();
    }, { once: true });
  }

  async function analyzeTrack(track) {
    try {
      const raw = await track.getArrayBuffer();
      const buffer = await audioContext.decodeAudioData(raw.slice(0));
      track.buffer = buffer;
      track.duration = buffer.duration;
      track.waveform = makeWaveform(buffer, 500);
      const analysis = estimateBpm(buffer);
      track.bpm = analysis.bpm;
      track.energy = analysis.energy;
      track.key = estimateKey(buffer);
      requestLibraryRender();
      [decks.a, decks.b].filter(deck => deck.track?.id === track.id).forEach(deck => {
        deck.baseBpm = track.bpm || 0;
        deck.waveform = track.waveform;
        updateDeckMetadata(deck);
        drawWaveform(deck);
      });
    } catch (error) {
      console.warn(`Could not analyze ${track.name}`, error);
    }
  }

  function makeWaveform(buffer, points) {
    const data = buffer.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / points));
    const peaks = [];
    for (let i = 0; i < points; i++) {
      let peak = 0;
      const start = i * block;
      for (let j = 0; j < block; j += Math.max(1, Math.floor(block / 100))) peak = Math.max(peak, Math.abs(data[start + j] || 0));
      peaks.push(peak);
    }
    const max = Math.max(...peaks, 0.01);
    return peaks.map(value => value / max);
  }

  function estimateBpm(buffer) {
    const source = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const limit = Math.min(source.length, sampleRate * 90);
    const envelopeRate = 200;
    const hop = Math.max(1, Math.floor(sampleRate / envelopeRate));
    const envelope = [];
    let sum = 0;
    for (let i = 0; i < limit; i += hop) {
      let peak = 0;
      for (let j = 0; j < hop && i + j < limit; j++) peak = Math.max(peak, Math.abs(source[i + j]));
      envelope.push(peak);
      sum += peak * peak;
    }
    const avg = envelope.reduce((a, b) => a + b, 0) / Math.max(1, envelope.length);
    for (let i = 0; i < envelope.length; i++) envelope[i] = Math.max(0, envelope[i] - avg);
    let bestLag = 0, bestScore = -Infinity;
    const minLag = Math.floor(envelopeRate * 60 / 190);
    const maxLag = Math.ceil(envelopeRate * 60 / 70);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let score = 0;
      for (let i = lag; i < envelope.length; i++) score += envelope[i] * envelope[i - lag];
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    let bpm = bestLag ? Math.round(envelopeRate * 60 / bestLag) : null;
    while (bpm && bpm < 78) bpm *= 2;
    while (bpm && bpm > 180) bpm = Math.round(bpm / 2);
    return { bpm, energy: Math.min(5, Math.max(1, Math.round(Math.sqrt(sum / Math.max(1, envelope.length)) * 18))) };
  }

  function estimateKey(buffer) {
    const data = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const notes = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
    const energies = new Array(12).fill(0);
    const start = Math.floor(Math.min(data.length * .1, sampleRate * 15));
    const length = Math.min(8192, data.length - start);
    if (length < 1024) return "—";
    for (let midi = 36; midi <= 83; midi++) {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const omega = 2 * Math.PI * freq / sampleRate;
      let real = 0, imag = 0;
      for (let i = 0; i < length; i += 4) {
        real += data[start + i] * Math.cos(omega * i);
        imag -= data[start + i] * Math.sin(omega * i);
      }
      energies[midi % 12] += real * real + imag * imag;
    }
    return notes[energies.indexOf(Math.max(...energies))];
  }

  function loadTrack(deck, track) {
    resumeAudio();
    if (!deck.audio.paused) deck.audio.pause();
    deck.track = track;
    deck.audio.src = track.url;
    deck.audio.load();
    deck.cue = 0;
    deck.hotCues = [null, null, null, null];
    deck.baseBpm = track.bpm || 0;
    deck.waveform = track.waveform;
    state.focusedDeck = deck.id;
    $$("[data-hotcue]", deck.root).forEach(button => button.classList.remove("set"));
    updateDeckMetadata(deck);
    drawWaveform(deck);
    setStatus(`${track.title.toUpperCase()} → DECK ${deck.id.toUpperCase()}`);
  }

  function ejectDeck(deck) {
    deck.audio.pause();
    deck.audio.removeAttribute("src");
    deck.track = null;
    deck.waveform = [];
    updateDeckMetadata(deck);
    drawWaveform(deck);
  }

  function loadSelectedOrFirst(deck) {
    const visible = filteredTracks();
    const track = visible.find(item => item.selected) || visible[0];
    if (track) loadTrack(deck, track);
    else chooseMusic("folder");
  }

  function togglePlay(deck) {
    if (!deck.track) return loadSelectedOrFirst(deck);
    resumeAudio();
    deck.audio.paused ? deck.audio.play() : deck.audio.pause();
  }

  function cueDeck(deck) {
    if (!deck.track) return;
    if (deck.audio.paused) {
      deck.audio.currentTime = deck.cue;
    } else {
      deck.cue = deck.audio.currentTime;
      deck.audio.pause();
    }
    setStatus(`DECK ${deck.id.toUpperCase()} CUE ${formatTime(deck.cue)}`);
  }

  function useHotCue(deck, index) {
    if (!deck.track) return;
    const button = $(`[data-hotcue="${index}"]`, deck.root);
    if (deck.hotCues[index] == null) {
      deck.hotCues[index] = deck.audio.currentTime;
      button.classList.add("set");
    } else {
      deck.audio.currentTime = deck.hotCues[index];
      if (deck.audio.paused) deck.audio.play();
    }
  }

  function syncDeck(deck) {
    const other = decks[deck.id === "a" ? "b" : "a"];
    const targetBpm = currentBpm(other);
    if (!deck.baseBpm || !targetBpm) return setStatus("LOAD TWO BPM-ANALYZED TRACKS TO SYNC");
    const percent = Math.max(-16, Math.min(16, (targetBpm / deck.baseBpm - 1) * 100));
    const slider = $("[data-control=pitch]", deck.root);
    slider.value = percent;
    slider.dispatchEvent(new Event("input"));
    $("[data-action=sync]", deck.root).classList.add("synced");
    setStatus(`DECK ${deck.id.toUpperCase()} SYNCED TO ${targetBpm.toFixed(1)} BPM`);
  }

  function currentBpm(deck) {
    return deck.baseBpm ? deck.baseBpm * deck.audio.playbackRate : 0;
  }

  function updateControl(deck, input) {
    const value = Number(input.value);
    const control = input.dataset.control;
    if (control === "gain") deck.gain.gain.value = value;
    if (control === "volume") { deck.channel.gain.value = value; updateCrossfader(); }
    if (control === "low") deck.low.gain.value = value;
    if (control === "mid") deck.mid.gain.value = value;
    if (control === "high") deck.high.gain.value = value;
    if (control === "pitch") {
      deck.audio.playbackRate = 1 + value / 100;
      $("[data-action=pitch-reset]", deck.root).textContent = `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
      $("[data-action=sync]", deck.root).classList.remove("synced");
      updateDeckMetadata(deck);
    }
  }

  function updateDeckMetadata(deck) {
    const track = deck.track;
    $("[data-role=title]", deck.root).textContent = track?.title || "Load a track";
    $("[data-role=artist]", deck.root).textContent = track?.artist || "Drag from the library or use LOAD";
    $("[data-role=bpm]", deck.root).textContent = deck.baseBpm ? currentBpm(deck).toFixed(1) : "—";
    updateTimeUi(deck);
  }

  function updatePlayingUi(deck) {
    const playing = !deck.audio.paused;
    $("[data-role=platter]", deck.root).classList.toggle("playing", playing);
    const button = $("[data-action=play]", deck.root);
    button.innerHTML = playing ? "<span>Ⅱ</span> PAUSE" : "<span>▶</span> PLAY";
    if (playing) requestAnimationFrame(() => animateDeck(deck));
  }

  function animateDeck(deck) {
    if (deck.audio.paused) return;
    updateTimeUi(deck);
    requestAnimationFrame(() => animateDeck(deck));
  }

  function updateTimeUi(deck) {
    const current = Number.isFinite(deck.audio.currentTime) ? deck.audio.currentTime : 0;
    const duration = Number.isFinite(deck.audio.duration) ? deck.audio.duration : deck.track?.duration || 0;
    $("[data-role=elapsed]", deck.root).textContent = formatTime(current, true);
    $("[data-role=remaining]", deck.root).textContent = `−${formatTime(Math.max(0, duration - current), true)}`;
    const playhead = $(".wave-playhead", deck.root);
    playhead.style.left = duration ? `${current / duration * 100}%` : "50%";
  }

  function drawWaveform(deck) {
    const canvas = $("[data-role=waveform]", deck.root);
    const box = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, box.width * devicePixelRatio);
    canvas.height = Math.max(1, box.height * devicePixelRatio);
    const ctx = canvas.getContext("2d");
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.clearRect(0, 0, box.width, box.height);
    const values = deck.waveform.length ? deck.waveform : new Array(100).fill(0).map((_, i) => .08 + Math.sin(i * .7) ** 2 * .07);
    const color = deck.id === "a" ? "#ff8c1a" : "#11d9c5";
    ctx.fillStyle = color;
    const center = box.height / 2;
    values.forEach((value, index) => {
      const x = index / values.length * box.width;
      const height = Math.max(1, value * box.height * .82);
      ctx.globalAlpha = .25 + value * .75;
      ctx.fillRect(x, center - height / 2, Math.max(1, box.width / values.length - .4), height);
    });
  }

  function filteredTracks() {
    let tracks = [...state.tracks];
    if (state.view === "favorites") tracks = tracks.filter(track => track.favorite);
    if (state.view === "suggested") {
      const reference = decks[state.focusedDeck].track || decks.a.track || decks.b.track;
      if (reference?.bpm) tracks = tracks.filter(track => track.id !== reference.id).sort((a, b) => suggestionScore(a, reference) - suggestionScore(b, reference));
      else tracks.sort((a, b) => (b.energy || 0) - (a.energy || 0));
    }
    const query = state.query.toLowerCase();
    if (query) tracks = tracks.filter(track => `${track.title} ${track.artist}`.toLowerCase().includes(query));
    if (state.view !== "suggested") {
      tracks.sort((a, b) => {
        if (state.sort === "bpm") return (a.bpm || 999) - (b.bpm || 999);
        if (state.sort === "duration") return (a.duration || 0) - (b.duration || 0);
        return a.title.localeCompare(b.title);
      });
    }
    return tracks;
  }

  function suggestionScore(track, reference) {
    const bpmGap = Math.abs((track.bpm || 0) - reference.bpm);
    const foldedGap = Math.min(bpmGap, Math.abs((track.bpm || 0) * 2 - reference.bpm), Math.abs((track.bpm || 0) - reference.bpm * 2));
    const energyGap = Math.abs((track.energy || 0) - (reference.energy || 0)) * 1.5;
    const keyBonus = track.key === reference.key ? -3 : 0;
    return foldedGap + energyGap + keyBonus;
  }

  function renderLibrary() {
    const tracks = filteredTracks();
    trackList.innerHTML = tracks.map(track => `
      <tr draggable="true" data-track-id="${track.id}" class="${track.selected ? "selected" : ""}">
        <td><button class="fav ${track.favorite ? "on" : ""}" data-favorite="${track.id}" aria-label="Favorite">♥</button></td>
        <td class="title">${escapeHtml(track.title)}</td>
        <td>${escapeHtml(track.artist)}</td>
        <td>${track.bpm || '<span title="Analyzing">…</span>'}</td>
        <td>${track.key}</td>
        <td>${formatTime(track.duration)}</td>
        <td><span class="energy">${[1,2,3,4,5].map(i => `<i class="${i <= track.energy ? "on" : ""}"></i>`).join("")}</span></td>
        <td class="load-actions"><button class="load-mini load-a" data-load-a="${track.id}" title="Load on deck A">A</button><button class="load-mini load-b" data-load-b="${track.id}" title="Load on deck B">B</button></td>
      </tr>`).join("");
    emptyState.hidden = state.tracks.length > 0;
    $("#trackCount").textContent = state.tracks.length;
    $("#libraryHint").textContent = state.view === "suggested"
      ? "Ranked by BPM, key, and energy against the focused deck"
      : `${tracks.length} track${tracks.length === 1 ? "" : "s"} · drag a row onto a deck`;
    $$("tr[data-track-id]", trackList).forEach(row => {
      row.addEventListener("dragstart", event => {
        state.draggingTrackId = row.dataset.trackId;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-backspin-track", row.dataset.trackId);
        event.dataTransfer.setData("text/plain", row.dataset.trackId);
      });
      row.addEventListener("dragend", () => {
        state.draggingTrackId = null;
        if (state.libraryRenderPending) {
          state.libraryRenderPending = false;
          renderLibrary();
        }
      });
      row.addEventListener("click", event => {
        if (event.target.closest("button")) return;
        state.tracks.forEach(track => track.selected = track.id === row.dataset.trackId);
        renderLibrary();
      });
      row.addEventListener("dblclick", () => loadTrack(decks[state.focusedDeck], state.tracks.find(track => track.id === row.dataset.trackId)));
    });
    $$("[data-favorite]", trackList).forEach(button => button.addEventListener("click", () => {
      const track = state.tracks.find(item => item.id === button.dataset.favorite);
      track.favorite = !track.favorite;
      renderLibrary();
    }));
    $$("[data-load-a]", trackList).forEach(button => button.addEventListener("click", () => {
      loadTrack(decks.a, state.tracks.find(track => track.id === button.dataset.loadA));
    }));
    $$("[data-load-b]", trackList).forEach(button => button.addEventListener("click", () => {
      loadTrack(decks.b, state.tracks.find(track => track.id === button.dataset.loadB));
    }));
  }

  function requestLibraryRender() {
    if (state.draggingTrackId) {
      state.libraryRenderPending = true;
      return;
    }
    renderLibrary();
  }

  function updateCrossfader() {
    const x = Number($("#crossfader").value);
    const aVolume = Number($("[data-control=volume]", decks.a.root).value);
    const bVolume = Number($("[data-control=volume]", decks.b.root).value);
    decks.a.channel.gain.value = Math.cos(x * Math.PI / 2) * aVolume;
    decks.b.channel.gain.value = Math.cos((1 - x) * Math.PI / 2) * bVolume;
  }

  function updateFilter() {
    const value = Number($("#filterKnob").value);
    Object.values(decks).forEach(deck => {
      if (Math.abs(value) < .03) { deck.filter.type = "allpass"; deck.filter.frequency.value = 1000; }
      else if (value < 0) { deck.filter.type = "lowpass"; deck.filter.frequency.value = 18000 * Math.pow(200 / 18000, Math.abs(value)); }
      else { deck.filter.type = "highpass"; deck.filter.frequency.value = 30 * Math.pow(6000 / 30, value); }
    });
  }

  function toggleRecording() {
    const button = $("#recordButton");
    if (state.mediaRecorder?.state === "recording") {
      state.mediaRecorder.stop();
      button.classList.remove("recording");
      button.innerHTML = "<i></i> RECORD";
      return;
    }
    if (!window.MediaRecorder) return setStatus("RECORDING IS NOT SUPPORTED IN THIS BROWSER");
    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(recorderDestination.stream);
    state.mediaRecorder.ondataavailable = event => { if (event.data.size) state.recordedChunks.push(event.data); };
    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: state.mediaRecorder.mimeType });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `backspin-mix-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      link.click();
      setStatus("MIX SAVED");
    };
    state.mediaRecorder.start();
    button.classList.add("recording");
    button.innerHTML = "<i></i> STOP + SAVE";
    setStatus("RECORDING MIX");
  }

  function meterLoop() {
    Object.values(decks).forEach(deck => {
      const data = new Uint8Array(deck.analyser.frequencyBinCount);
      deck.analyser.getByteFrequencyData(data);
      const level = data.reduce((sum, value) => sum + value, 0) / Math.max(1, data.length);
      $(`.vu.${deck.id}`).classList.toggle("active", level > 4);
    });
    $(".master-meter").classList.toggle("active", !decks.a.audio.paused || !decks.b.audio.paused);
    requestAnimationFrame(meterLoop);
  }

  function formatTime(seconds, tenths = false) {
    if (!Number.isFinite(seconds)) seconds = 0;
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${tenths ? `.${Math.floor(seconds * 10) % 10}` : ""}`;
  }
  function escapeHtml(value) {
    const node = document.createElement("div");
    node.textContent = value;
    return node.innerHTML;
  }
  function setStatus(message) { $("#footerStatus").textContent = message; }

  filePicker.addEventListener("change", () => addFiles(filePicker.files));
  $("#addFolder").addEventListener("click", () => chooseMusic("folder"));
  $("#addFiles").addEventListener("click", () => chooseMusic("files"));
  $("#emptyAdd").addEventListener("click", () => chooseMusic("folder"));
  $("#audioButton").addEventListener("click", resumeAudio);
  updateButton.addEventListener("click", () => {
    if (updateButton.classList.contains("ready")) window.backspinDesktop.installUpdate();
    else window.backspinDesktop?.checkForUpdates();
  });
  $("#masterVolume").addEventListener("input", event => masterGain.gain.value = Number(event.target.value));
  $("#crossfader").addEventListener("input", updateCrossfader);
  $("#filterKnob").addEventListener("input", updateFilter);
  $("#recordButton").addEventListener("click", toggleRecording);
  $("#searchInput").addEventListener("input", event => { state.query = event.target.value; renderLibrary(); });
  $("#sortSelect").addEventListener("change", event => { state.sort = event.target.value; renderLibrary(); });
  $$("[data-view]").forEach(button => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    $$("[data-view]").forEach(item => item.classList.toggle("active", item === button));
    $("#libraryTitle").textContent = button.textContent.replace(/\d+$/, "").trim();
    renderLibrary();
  }));
  window.addEventListener("dragover", event => {
    event.preventDefault();
    if ([...event.dataTransfer.types].includes("Files")) document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", event => { if (!event.relatedTarget) document.body.classList.remove("dragging"); });
  window.addEventListener("drop", event => {
    document.body.classList.remove("dragging");
    if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(event.dataTransfer.files); }
  });
  window.addEventListener("resize", () => Object.values(decks).forEach(drawWaveform));
  window.addEventListener("keydown", event => {
    if (event.target.matches("input, select")) return;
    const deck = decks[state.focusedDeck];
    if (event.code === "Space") { event.preventDefault(); togglePlay(deck); }
    if (/^Digit[1-4]$/.test(event.code)) useHotCue(deck, Number(event.code.slice(-1)) - 1);
    if (event.key.toLowerCase() === "s") syncDeck(deck);
  });

  updateCrossfader();
  updateFilter();
  setupRotaryControls();
  Object.values(decks).forEach(drawWaveform);
  renderLibrary();
  meterLoop();
})();
