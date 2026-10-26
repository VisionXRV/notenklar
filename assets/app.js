/*!
 * notenklar – interface
 * Vanilla JS, no dependencies, no network.
 */
(function () {
  'use strict';

  const Midi = window.NotenklarMidi;
  if (!Midi) {
    console.error('notenklar: MIDI-Modul nicht geladen.');
    return;
  }

  const $ = (selector, context) => (context || document).querySelector(selector);
  const $$ = (selector, context) => Array.from((context || document).querySelectorAll(selector));

  const MAX_FILES = 24;
  const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointerQuery = window.matchMedia('(pointer: fine)');

  const state = {
    files: [],
    mergeTracks: false,
    nextId: 1,
    playing: null,
    toastTimer: 0,
    dragTimer: 0
  };

  let audioPlayer = null;

  const els = {
    header: $('#siteHeader'),
    menuBtn: $('#menuBtn'),
    nav: $('#primaryNav'),
    dropzone: $('#dropzone'),
    fileInput: $('#fileInput'),
    fileList: $('#fileList'),
    fileItems: $('#fileItems'),
    fileSummary: $('#fileSummary'),
    downloadAll: $('#downloadAll'),
    studio: $('#studio'),
    studioStatus: $('#studioStatus'),
    studioStatusText: $('#studioStatusText'),
    dropOverlay: $('#dropOverlay'),
    toast: $('#toast'),
    toastText: $('#toast .toast__text'),
    tpl: $('#tplFileCard'),
    year: $('#year'),
    mergeButtons: $$('.segmented__btn'),
    pickerTriggers: $$('[data-open-picker]')
  };

  /* =======================================================
     Small helpers
     ======================================================= */

  const numberFormat = new Intl.NumberFormat('de-DE');

  function formatNumber(value) {
    return numberFormat.format(Math.max(0, Math.round(value || 0)));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
    return `${value.toLocaleString('de-DE', { maximumFractionDigits: digits })} ${units[unit]}`;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
    return `${pad(minutes)}:${pad(secs)}`;
  }

  function formatDuration(seconds) {
    return formatTime(Math.ceil(seconds || 0));
  }

  function sanitizeName(name) {
    return String(name || 'MIDI')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
  }

  function outputFileName(originalName) {
    const base = sanitizeName(String(originalName || 'MIDI').replace(/\.(mid|midi)$/i, '')) || 'MIDI';
    return `${base} - nur Noten.mid`;
  }

  function uniqueFileName(name, used) {
    const key = name.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      return name;
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let index = 2;
    let candidate = `${stem} (${index})${extension}`;
    while (used.has(candidate.toLowerCase())) {
      index += 1;
      candidate = `${stem} (${index})${extension}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function showToast(message, type) {
    if (!els.toast) return;
    els.toastText.textContent = message;
    els.toast.classList.toggle('is-error', type === 'error');
    els.toast.classList.add('is-visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, type === 'error' ? 4200 : 2800);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  function isFileDrag(event) {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    const types = transfer.types;
    if (!types) return false;
    if (typeof types.includes === 'function') return types.includes('Files');
    return Array.prototype.indexOf.call(types, 'Files') > -1;
  }

  function prefersReducedMotion() {
    return motionQuery.matches;
  }

  function scrollStudioIntoView() {
    const rect = els.studio.getBoundingClientRect();
    if (rect.top < -20 || rect.top > window.innerHeight - 180) {
      window.setTimeout(() => {
        els.studio.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'start'
        });
      }, 50);
    }
  }

  /* =======================================================
     Header, navigation, reveals
     ======================================================= */

  function handleScroll() {
    els.header.classList.toggle('is-scrolled', window.scrollY > 12);
  }

  function setMenu(open) {
    const isOpen = Boolean(open);
    els.nav.classList.toggle('is-open', isOpen);
    els.menuBtn.setAttribute('aria-expanded', String(isOpen));
    els.menuBtn.setAttribute('aria-label', isOpen ? 'Menü schließen' : 'Menü öffnen');
    document.body.classList.toggle('menu-open', isOpen && window.innerWidth <= 860);
  }

  function setupReveals() {
    const items = $$('[data-reveal]');
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
      items.forEach((item) => item.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -7% 0px', threshold: 0.08 }
    );

    items.forEach((item) => observer.observe(item));
  }

  function setupSpotlight() {
    if (!pointerQuery.matches || prefersReducedMotion()) return;
    const hero = $('.hero');
    if (!hero) return;
    let frame = 0;
    let lastX = 0;
    let lastY = 0;

    hero.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerType === 'touch') return;
        lastX = event.clientX;
        lastY = event.clientY;
        if (frame) return;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          const rect = hero.getBoundingClientRect();
          hero.style.setProperty('--mx', `${lastX - rect.left}px`);
          hero.style.setProperty('--my', `${lastY - rect.top}px`);
        });
      },
      { passive: true }
    );
  }

  /* =======================================================
     File input & drag and drop
     ======================================================= */

  function openPicker() {
    els.fileInput.click();
  }

  function showDragOverlay() {
    document.body.classList.add('is-dragging');
    els.dropzone.classList.add('is-dragover');
    window.clearTimeout(state.dragTimer);
    state.dragTimer = window.setTimeout(hideDragOverlay, 180);
  }

  function hideDragOverlay() {
    window.clearTimeout(state.dragTimer);
    document.body.classList.remove('is-dragging');
    els.dropzone.classList.remove('is-dragover');
  }

  function handleFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const availableSlots = MAX_FILES - state.files.length;
    if (availableSlots <= 0) {
      showToast(`Maximal ${MAX_FILES} Dateien gleichzeitig. Entferne zuerst eine Datei.`, 'error');
      return;
    }

    let totalBytes = state.files.reduce((sum, entry) => sum + entry.size, 0);
    let added = 0;

    for (let i = 0; i < incoming.length; i += 1) {
      if (added >= availableSlots) {
        showToast(`Maximal ${MAX_FILES} Dateien gleichzeitig.`, 'error');
        break;
      }

      const file = incoming[i];
      if (file.size === 0) {
        showToast(`„${file.name}“ ist leer.`, 'error');
        continue;
      }
      if (file.size > Midi.MAX_FILE_BYTES) {
        showToast(`„${file.name}“ ist größer als 25 MB.`, 'error');
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_BYTES) {
        showToast('Die ausgewählten Dateien sind zusammen zu groß für eine Sitzung.', 'error');
        break;
      }

      totalBytes += file.size;
      addFile(file, added);
      added += 1;
    }

    if (added) scrollStudioIntoView();
  }

  function addFile(file, index) {
    if (!els.tpl) return;

    const entry = {
      id: `file-${state.nextId++}`,
      file,
      name: file.name || `MIDI ${state.nextId}.mid`,
      size: file.size,
      buffer: null,
      result: null,
      resultMode: null,
      error: null,
      el: null,
      roll: null,
      state: 'processing',
      cancelled: false,
      finished: false,
      playing: false,
      progressRAF: 0,
      finishTimer: 0,
      revealTimer: 0
    };

    state.files.push(entry);

    const fragment = els.tpl.content.cloneNode(true);
    const card = fragment.querySelector('.filecard');
    entry.el = card;
    card.dataset.id = entry.id;

    const nameEl = $('.filecard__name', card);
    nameEl.textContent = entry.name;
    nameEl.title = entry.name;
    $('.filecard__meta', card).textContent = `${formatBytes(entry.size)} · Wird lokal gelesen …`;

    $('[data-role="remove"]', card).addEventListener('click', () => removeFile(entry));
    $('[data-role="play"]', card).addEventListener('click', () => togglePlayback(entry));
    $('[data-role="download"]', card).addEventListener('click', () => downloadEntry(entry));

    els.fileItems.appendChild(fragment);
    els.fileList.hidden = false;
    updateListSummary();
    updateStudioStatus();

    processEntry(entry, index);
  }

  /* =======================================================
     Processing
     ======================================================= */

  function stageForProgress(percent) {
    if (percent < 20) return 'MIDI wird gelesen …';
    if (percent < 45) return 'Spuren werden analysiert …';
    if (percent < 72) return 'Controller & Presets entfernen …';
    if (percent < 89) return 'Noten werden geschrieben …';
    return 'Letzter Schliff …';
  }

  function animateProgress(entry, startedAt, minDelay) {
    const card = entry.el;
    if (!card || prefersReducedMotion() || minDelay <= 0) return;

    const bar = $('[data-role="bar"]', card);
    const percentEl = $('[data-role="pct"]', card);
    const stageEl = $('[data-role="stage"]', card);

    function frame(now) {
      if (entry.cancelled || entry.finished) return;
      const progress = Math.min(1, (now - startedAt) / minDelay);
      const eased = 1 - Math.pow(1 - progress, 2.25);
      const percent = Math.min(92, Math.round(eased * 92));

      if (bar) bar.style.width = `${percent}%`;
      if (percentEl) percentEl.textContent = `${percent} %`;
      if (stageEl) stageEl.textContent = stageForProgress(percent);

      if (progress < 1) entry.progressRAF = window.requestAnimationFrame(frame);
    }

    entry.progressRAF = window.requestAnimationFrame(frame);
  }

  async function processEntry(entry, index) {
    const startedAt = performance.now();
    const minDelay = prefersReducedMotion() ? 0 : 920 + Math.min(index, 4) * 110;

    animateProgress(entry, startedAt, minDelay);

    try {
      const buffer = await entry.file.arrayBuffer();
      if (entry.cancelled) return;
      entry.buffer = buffer;
      const mode = state.mergeTracks;
      const result = Midi.cleanMidi(buffer, { mergeTracks: mode });
      if (entry.cancelled) return;
      entry.result = result;
      entry.resultMode = mode;
    } catch (error) {
      if (entry.cancelled) return;
      entry.error = error instanceof Error ? error : new Error('Unbekannter Fehler beim Lesen der Datei.');
      entry.state = 'error';
    }

    if (entry.cancelled) return;

    const elapsed = performance.now() - startedAt;
    const wait = Math.max(0, minDelay - elapsed);
    entry.finishTimer = window.setTimeout(() => finishEntry(entry), wait);
  }

  function finishEntry(entry) {
    if (entry.cancelled || entry.finished) return;
    entry.finished = true;
    window.cancelAnimationFrame(entry.progressRAF);

    const card = entry.el;
    if (!card) return;

    const bar = $('[data-role="bar"]', card);
    const percentEl = $('[data-role="pct"]', card);
    const stageEl = $('[data-role="stage"]', card);

    if (entry.error) {
      entry.state = 'error';
      const process = $('[data-role="process"]', card);
      const errorBox = $('[data-role="error"]', card);
      const errorText = $('[data-role="errorText"]', card);
      if (process) process.hidden = true;
      if (errorBox) errorBox.hidden = false;
      if (errorText) errorText.textContent = entry.error.message || 'Die Datei konnte nicht verarbeitet werden.';
      $('.filecard__meta', card).textContent = `${formatBytes(entry.size)} · Nicht lesbar`;
      card.classList.remove('is-processing');
      card.classList.add('is-error');
      setBadge(entry, 'error', 'Fehler');
      updateListSummary();
      updateStudioStatus();
      showToast(`„${entry.name}“: ${entry.error.message || 'Datei konnte nicht gelesen werden.'}`, 'error');
      return;
    }

    if (bar) bar.style.width = '100%';
    if (percentEl) percentEl.textContent = '100 %';
    if (stageEl) stageEl.textContent = 'Fertig';
    entry.state = 'revealing';
    updateStudioStatus();

    entry.revealTimer = window.setTimeout(
      () => {
        if (entry.cancelled) return;
        if (entry.resultMode !== state.mergeTracks && entry.buffer) {
          try {
            entry.result = Midi.cleanMidi(entry.buffer, { mergeTracks: state.mergeTracks });
            entry.resultMode = state.mergeTracks;
          } catch (error) {
            entry.error = error;
            entry.state = 'error';
            entry.finished = false;
            finishEntry(entry);
            return;
          }
        }
        renderResult(entry);
        entry.state = 'ready';
        updateListSummary();
        updateStudioStatus();
      },
      prefersReducedMotion() ? 0 : 280
    );
  }

  function setBadge(entry, kind, text) {
    if (!entry.el) return;
    const badge = $('[data-role="badge"]', entry.el);
    const label = $('[data-role="badgeText"]', entry.el);
    if (!badge || !label) return;
    badge.className = `badge badge--${kind}`;
    label.textContent = text;
  }

  function cardMeta(entry) {
    if (!entry.result) return formatBytes(entry.size);
    const stats = entry.result.stats;
    const parts = [
      `${formatBytes(stats.sizeIn)} → ${formatBytes(stats.sizeOut)}`,
      `${formatNumber(stats.tracksOut)} ${stats.tracksOut === 1 ? 'Spur' : 'Spuren'}`,
      formatDuration(stats.durationSec)
    ];
    if (stats.bpm) parts.push(`${stats.bpm} BPM`);
    return parts.join(' · ');
  }

  function animateValue(element, value) {
    if (!element) return;
    const target = Math.max(0, Math.round(value || 0));
    if (prefersReducedMotion() || target === 0) {
      element.textContent = formatNumber(target);
      return;
    }

    const start = performance.now();
    const duration = Math.min(900, 420 + Math.log10(target + 1) * 190);

    function frame(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatNumber(Math.round(target * eased));
      if (progress < 1) window.requestAnimationFrame(frame);
    }

    window.requestAnimationFrame(frame);
  }

  function renderBreakdown(entry) {
    const container = $('[data-role="breakdown"]', entry.el);
    if (!container || !entry.result) return;
    const stats = entry.result.stats;

    const categories = [
      { count: stats.dropped.cc, label: 'CC', title: 'Control Changes', color: '#8fa7ff' },
      { count: stats.dropped.program, label: 'Program', title: 'Program Changes', color: '#b79cff' },
      { count: stats.dropped.bend, label: 'Bend', title: 'Pitch-Bend', color: '#8bead2' },
      { count: stats.dropped.aftertouch, label: 'Aftertouch', title: 'Aftertouch', color: '#ffd28f' },
      { count: stats.dropped.sysex, label: 'SysEx', title: 'System Exclusive', color: '#ffa8c3' },
      { count: stats.dropped.meta, label: 'Meta', title: 'Sonstige Metadaten', color: '#93a0ba' }
    ];

    if (stats.orphanOffs > 0) {
      categories.push({
        count: stats.orphanOffs,
        label: 'Einzel-Offs',
        title: 'Note-Offs ohne zugehöriges Note-On',
        color: '#ff9d9d'
      });
    }

    if (stats.zeroLength > 0) {
      categories.push({
        count: stats.zeroLength * 2,
        label: 'Leere Noten',
        title: 'Leere Note-On/Note-Off-Paare',
        color: '#c1c9dc'
      });
    }

    container.textContent = '';
    categories.forEach((category) => {
      const item = document.createElement('span');
      item.className = `breakdown__item${category.count === 0 ? ' is-zero' : ''}`;
      item.title = `${category.title}: ${formatNumber(category.count)}`;

      const dot = document.createElement('span');
      dot.className = 'breakdown__dot';
      dot.style.setProperty('--dot-color', category.color);

      const label = document.createElement('span');
      label.textContent = category.label;

      const value = document.createElement('b');
      value.textContent = formatNumber(category.count);

      item.append(dot, label, value);
      container.appendChild(item);
    });
  }

  function renderResult(entry) {
    if (!entry.el || !entry.result) return;
    const card = entry.el;
    const result = entry.result;
    const stats = result.stats;

    const process = $('[data-role="process"]', card);
    const errorBox = $('[data-role="error"]', card);
    const resultBox = $('[data-role="result"]', card);
    if (process) process.hidden = true;
    if (errorBox) errorBox.hidden = true;
    if (resultBox) resultBox.hidden = false;

    card.classList.remove('is-processing', 'is-error');
    card.classList.add('is-ready');
    setBadge(entry, 'success', 'Bereinigt');

    const meta = $('.filecard__meta', card);
    meta.textContent = cardMeta(entry);
    meta.title = meta.textContent;

    animateValue($('[data-role="notes"]', card), stats.notes);
    animateValue($('[data-role="removed"]', card), stats.removed);
    animateValue($('[data-role="tracks"]', card), stats.tracksOut);
    const length = $('[data-role="length"]', card);
    if (length) length.textContent = formatDuration(stats.durationSec);

    renderBreakdown(entry);

    const total = formatDuration(stats.durationSec);
    const time = $('[data-role="time"]', card);
    if (time) time.textContent = `00:00 / ${total}`;

    const range = $('[data-role="range"]', card);
    if (range) range.textContent = stats.noteRange || '';

    const truncated = $('[data-role="truncated"]', card);
    if (truncated) truncated.hidden = !result.notesTruncated;

    const playBtn = $('[data-role="play"]', card);
    if (playBtn) {
      playBtn.disabled = false;
      playBtn.setAttribute('aria-label', `Vorschau von ${entry.name} abspielen`);
    }

    const downloadBtn = $('[data-role="download"]', card);
    if (downloadBtn) downloadBtn.setAttribute('aria-label', `Bereinigte MIDI-Datei von ${entry.name} herunterladen`);

    const canvas = $('[data-role="canvas"]', card);
    if (canvas) {
      canvas.setAttribute(
        'aria-label',
        `Piano-Roll-Vorschau mit ${formatNumber(stats.notes)} Noten, Tonumfang ${stats.noteRange || 'unbekannt'}.`
      );
      window.requestAnimationFrame(() => {
        if (entry.cancelled) return;
        if (entry.roll) entry.roll.destroy();
        try {
          entry.roll = new PianoRoll(canvas, result.notes, stats.durationSec);
        } catch (error) {
          console.error('notenklar: Piano-Roll konnte nicht gezeichnet werden.', error);
        }
      });
    }
  }

  function refreshResultPresentation(entry) {
    if (!entry.el || !entry.result) return;
    const meta = $('.filecard__meta', entry.el);
    if (meta) {
      meta.textContent = cardMeta(entry);
      meta.title = meta.textContent;
    }
    const tracks = $('[data-role="tracks"]', entry.el);
    if (tracks) tracks.textContent = formatNumber(entry.result.stats.tracksOut);
  }

  function updateListSummary() {
    const ready = state.files.filter((entry) => entry.result && entry.state === 'ready');
    const errors = state.files.filter((entry) => entry.state === 'error');
    const processing = state.files.some((entry) => entry.state === 'processing' || entry.state === 'revealing');
    const total = state.files.length;

    if (!total) {
      els.fileList.hidden = true;
      els.downloadAll.disabled = true;
      return;
    }

    els.fileList.hidden = false;
    const notes = ready.reduce((sum, entry) => sum + entry.result.stats.notes, 0);
    const removed = ready.reduce((sum, entry) => sum + entry.result.stats.removed, 0);
    let summary = '';

    if (!ready.length) {
      if (processing) {
        summary = `${total} ${total === 1 ? 'Datei' : 'Dateien'} · wird lokal verarbeitet`;
      } else if (errors.length === total) {
        summary = `${total} ${total === 1 ? 'Datei' : 'Dateien'} · nicht lesbar`;
      } else {
        summary = `${total} ${total === 1 ? 'Datei' : 'Dateien'} · keine bereinigte Datei`;
      }
    } else if (ready.length === total) {
      summary = `${total} ${total === 1 ? 'Datei' : 'Dateien'} bereinigt · ${formatNumber(notes)} ${notes === 1 ? 'Note' : 'Noten'} · ${formatNumber(removed)} ${removed === 1 ? 'Ereignis' : 'Ereignisse'} entfernt`;
    } else {
      summary = `${ready.length} von ${total} bereit · ${formatNumber(notes)} ${notes === 1 ? 'Note' : 'Noten'}`;
      if (errors.length) summary += ` · ${errors.length} Fehler`;
    }

    els.fileSummary.textContent = summary;
    els.downloadAll.disabled = ready.length === 0 || els.downloadAll.classList.contains('is-loading');
  }

  function updateStudioStatus() {
    const processing = state.files.some((entry) => entry.state === 'processing' || entry.state === 'revealing');
    const ready = state.files.filter((entry) => entry.state === 'ready').length;
    const errors = state.files.filter((entry) => entry.state === 'error').length;

    els.dropzone.classList.toggle('is-busy', processing);
    els.studioStatus.classList.toggle('is-busy', processing);
    els.studioStatus.classList.toggle('is-error', !processing && errors > 0 && ready === 0);

    if (processing) {
      els.studioStatusText.textContent = 'Bereinigt …';
    } else if (ready > 0 && errors > 0) {
      els.studioStatusText.textContent = `${ready} ${ready === 1 ? 'Datei' : 'Dateien'} bereit · ${errors} Fehler`;
    } else if (ready > 0) {
      els.studioStatusText.textContent = ready === 1 ? '1 Datei bereit' : `${ready} Dateien bereit`;
    } else if (errors > 0) {
      els.studioStatusText.textContent = errors === 1 ? '1 Fehler' : `${errors} Fehler`;
    } else {
      els.studioStatusText.textContent = 'Bereit';
    }
  }

  /* =======================================================
     Download & settings
     ======================================================= */

  function downloadEntry(entry) {
    if (!entry.result) return;
    const blob = new Blob([entry.result.bytes], { type: 'audio/midi' });
    triggerDownload(blob, outputFileName(entry.name));
    showToast('Bereinigte MIDI-Datei wird heruntergeladen.');
  }

  function downloadAll() {
    const ready = state.files.filter((entry) => entry.result && entry.state === 'ready');
    if (!ready.length) return;

    const button = els.downloadAll;
    const label = $('span', button);
    const originalLabel = label ? label.textContent : '';
    button.classList.add('is-loading');
    button.disabled = true;
    if (label) label.textContent = 'ZIP wird gepackt …';

    window.requestAnimationFrame(() => {
      try {
        const used = new Set();
        const entries = ready.map((entry) => ({
          name: uniqueFileName(outputFileName(entry.name), used),
          data: entry.result.bytes
        }));
        const zipBytes = Midi.createZip(entries);
        const now = new Date();
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        triggerDownload(new Blob([zipBytes], { type: 'application/zip' }), `notenklar-${stamp}.zip`);
        showToast(`${ready.length} ${ready.length === 1 ? 'Datei' : 'Dateien'} als ZIP heruntergeladen.`);
      } catch (error) {
        console.error('notenklar: ZIP konnte nicht erstellt werden.', error);
        showToast('Das ZIP konnte nicht erstellt werden. Lade die Dateien einzeln herunter.', 'error');
      } finally {
        button.classList.remove('is-loading');
        if (label) label.textContent = originalLabel;
        updateListSummary();
      }
    });
  }

  function setMergeMode(value) {
    const merge = Boolean(value);
    if (merge === state.mergeTracks) return;
    state.mergeTracks = merge;

    els.mergeButtons.forEach((button) => {
      const active = (button.dataset.merge === 'true') === merge;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    let refreshed = 0;
    state.files.forEach((entry) => {
      if (!entry.result || !entry.buffer) return;
      try {
        entry.result = Midi.cleanMidi(entry.buffer, { mergeTracks: merge });
        entry.resultMode = merge;
        refreshResultPresentation(entry);
        refreshed += 1;
      } catch (error) {
        console.error('notenklar: Ausgabemodus konnte nicht angewendet werden.', error);
      }
    });

    updateListSummary();
    if (refreshed > 0) {
      showToast(merge ? 'Ausgabe aktualisiert: alles in einer Spur.' : 'Ausgabe aktualisiert: Spuren bleiben getrennt.');
    }
  }

  function removeFile(entry) {
    entry.cancelled = true;
    window.cancelAnimationFrame(entry.progressRAF);
    window.clearTimeout(entry.finishTimer);
    window.clearTimeout(entry.revealTimer);

    if (entry.playing || (state.playing && state.playing.entry === entry)) {
      stopPlayback();
    }
    if (entry.roll) {
      entry.roll.destroy();
      entry.roll = null;
    }

    state.files = state.files.filter((item) => item !== entry);
    const card = entry.el;
    if (!card) {
      updateListSummary();
      updateStudioStatus();
      return;
    }

    if (state.files.length > 0) updateListSummary();
    updateStudioStatus();

    card.classList.add('is-leaving');
    window.setTimeout(
      () => {
        card.remove();
        updateListSummary();
        updateStudioStatus();
      },
      prefersReducedMotion() ? 0 : 240
    );
  }

  /* =======================================================
     Piano roll canvas
     ======================================================= */

  function roundedRectPath(context, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  class PianoRoll {
    constructor(canvas, notes, duration) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d');
      this.notes = Array.isArray(notes) ? notes.slice() : [];
      this.duration = Math.max(0.1, Number(duration) || 0.1);
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = 0;
      this.height = 0;
      this.offscreen = null;
      this.progress = null;
      this.reveal = 1;
      this.revealRaf = 0;
      this.destroyed = false;

      if ('ResizeObserver' in window) {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(canvas.parentElement);
      } else {
        this.onWindowResize = () => this.resize();
        window.addEventListener('resize', this.onWindowResize);
      }

      this.resize();

      if (!prefersReducedMotion()) {
        this.reveal = 0;
        const started = performance.now();
        const step = (now) => {
          if (this.destroyed) return;
          const progress = Math.min(1, (now - started) / 850);
          this.reveal = 1 - Math.pow(1 - progress, 3);
          this.draw();
          if (progress < 1) this.revealRaf = window.requestAnimationFrame(step);
        };
        this.revealRaf = window.requestAnimationFrame(step);
      }
    }

    resize() {
      if (this.destroyed) return;
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;

      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width === this.width && height === this.height && this.offscreen) return;

      this.width = width;
      this.height = height;
      this.canvas.width = Math.max(1, Math.round(width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(height * this.dpr));
      this.buildStatic();
      this.draw();
    }

    buildStatic() {
      if (!this.notes.length || !this.width || !this.height) {
        this.offscreen = null;
        return;
      }

      const width = this.width;
      const height = this.height;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * this.dpr);
      canvas.height = Math.round(height * this.dpr);
      const context = canvas.getContext('2d');
      context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      const background = context.createLinearGradient(0, 0, 0, height);
      background.addColorStop(0, '#0b0e16');
      background.addColorStop(1, '#080a0f');
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);

      const topGlow = context.createLinearGradient(0, 0, 0, height * 0.65);
      topGlow.addColorStop(0, 'rgba(143, 167, 255, 0.055)');
      topGlow.addColorStop(1, 'rgba(143, 167, 255, 0)');
      context.fillStyle = topGlow;
      context.fillRect(0, 0, width, height);

      let lowest = 127;
      let highest = 0;
      for (let i = 0; i < this.notes.length; i += 1) {
        const pitch = this.notes[i].pitch;
        if (pitch < lowest) lowest = pitch;
        if (pitch > highest) highest = pitch;
      }

      if (highest - lowest < 7) {
        const middle = (highest + lowest) / 2;
        lowest = Math.max(0, Math.round(middle - 4));
        highest = Math.min(127, Math.round(middle + 4));
      } else {
        const padding = Math.max(1, Math.round((highest - lowest) * 0.06));
        lowest = Math.max(0, lowest - padding);
        highest = Math.min(127, highest + padding);
      }

      const topPadding = 8;
      const bottomPadding = 8;
      const rowHeight = (height - topPadding - bottomPadding) / (highest - lowest + 1);

      context.lineWidth = 0.5;
      for (let pitch = Math.ceil(lowest); pitch <= highest; pitch += 1) {
        if (pitch % 12 !== 0) continue;
        const y = topPadding + (highest - pitch + 0.5) * rowHeight;
        context.strokeStyle = 'rgba(255, 255, 255, 0.038)';
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }

      context.strokeStyle = 'rgba(255, 255, 255, 0.025)';
      for (let i = 1; i < 8; i += 1) {
        const x = Math.round((width * i) / 8) + 0.5;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }

      const noteHeight = Math.max(2.2, Math.min(9, rowHeight * 0.67));
      const duration = this.duration;

      for (let i = 0; i < this.notes.length; i += 1) {
        const note = this.notes[i];
        const start = Math.max(0, Math.min(duration, note.start));
        const end = Math.max(start + 0.008, Math.min(duration, note.end));
        const x = (start / duration) * width;
        const noteWidth = Math.max(2, ((end - start) / duration) * width);
        const y = topPadding + (highest - note.pitch) * rowHeight + (rowHeight - noteHeight) / 2;

        const spread = Math.max(1, highest - lowest);
        const normalized = Math.min(1, Math.max(0, (note.pitch - lowest) / spread));
        const velocity = Math.max(1, Math.min(127, note.velocity || 80)) / 127;
        let hue = 224 - normalized * 55;
        if (note.channel === 9) hue = 32;
        const lightness = 56 + velocity * 15;
        const alpha = 0.52 + velocity * 0.4;

        context.fillStyle = `hsla(${hue.toFixed(1)}, 88%, ${lightness.toFixed(1)}%, ${alpha.toFixed(3)})`;
        roundedRectPath(context, x, y, noteWidth, noteHeight, Math.min(noteHeight / 2, 2.4));
        context.fill();
      }

      const fade = context.createLinearGradient(0, height - 30, 0, height);
      fade.addColorStop(0, 'rgba(6, 8, 12, 0)');
      fade.addColorStop(1, 'rgba(6, 8, 12, 0.34)');
      context.fillStyle = fade;
      context.fillRect(0, height - 30, width, 30);

      this.offscreen = canvas;
    }

    draw() {
      if (!this.width || !this.height || !this.context) return;
      const context = this.context;
      const width = this.width;
      const height = this.height;

      context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      if (!this.offscreen) return;

      const reveal = this.progress !== null ? 1 : this.reveal;
      context.save();
      if (reveal < 1) {
        context.beginPath();
        context.rect(0, 0, width * reveal, height);
        context.clip();
      }
      context.drawImage(this.offscreen, 0, 0, width, height);
      context.restore();

      if (this.progress === null) return;

      const progress = Math.max(0, Math.min(1, this.progress));
      const x = progress * width;

      context.save();
      const shade = context.createLinearGradient(Math.max(0, x - 90), 0, x, 0);
      shade.addColorStop(0, 'rgba(143, 167, 255, 0)');
      shade.addColorStop(1, 'rgba(143, 167, 255, 0.07)');
      context.fillStyle = shade;
      context.fillRect(Math.max(0, x - 90), 0, Math.min(90, x), height);

      context.strokeStyle = 'rgba(237, 242, 255, 0.86)';
      context.lineWidth = 1;
      context.shadowColor = 'rgba(143, 167, 255, 0.75)';
      context.shadowBlur = 9;
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();

      context.shadowBlur = 0;
      context.fillStyle = '#eef2ff';
      context.beginPath();
      context.arc(x, 5.5, 2, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }

    setProgress(value) {
      this.progress = value === null || value === undefined ? null : Math.max(0, Math.min(1, value));
      if (this.progress !== null) this.reveal = 1;
      this.draw();
    }

    destroy() {
      this.destroyed = true;
      window.cancelAnimationFrame(this.revealRaf);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.onWindowResize) window.removeEventListener('resize', this.onWindowResize);
      this.offscreen = null;
      this.notes = [];
    }
  }

  /* =======================================================
     Synth preview
     ======================================================= */

  class SynthPlayer {
    constructor() {
      this.context = null;
      this.master = null;
      this.send = null;
      this.voices = new Set();
      this.notes = [];
      this.duration = 0;
      this.index = 0;
      this.startAt = 0;
      this.playing = false;
      this.scheduleTimer = 0;
      this.uiRaf = 0;
      this.endTimer = 0;
      this.onTick = null;
      this.onEnd = null;
    }

    ensureContext() {
      if (this.context) return;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Dein Browser unterstützt die Audiovorschau nicht.');

      const context = new AudioContextClass();
      const master = context.createGain();
      master.gain.value = 0.72;

      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.knee.value = 22;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.005;
      compressor.release.value = 0.3;

      const lowpass = context.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 6800;
      lowpass.Q.value = 0.35;

      master.connect(compressor);
      compressor.connect(lowpass);
      lowpass.connect(context.destination);

      const reverb = context.createConvolver();
      reverb.buffer = this.createImpulse(context, 1.7, 2.8);

      const wet = context.createGain();
      wet.gain.value = 0.24;

      const send = context.createGain();
      send.gain.value = 0.55;

      send.connect(reverb);
      reverb.connect(wet);
      wet.connect(master);

      this.context = context;
      this.master = master;
      this.send = send;
    }

    createImpulse(context, seconds, decay) {
      const rate = context.sampleRate;
      const length = Math.max(1, Math.floor(rate * seconds));
      const buffer = context.createBuffer(2, length, rate);
      for (let channel = 0; channel < 2; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i += 1) {
          const progress = i / length;
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - progress, decay) * 0.55;
        }
      }
      return buffer;
    }

    play(notes, duration, onTick, onEnd) {
      this.stop();
      this.ensureContext();
      const context = this.context;
      if (context.state === 'suspended') context.resume();

      this.notes = notes
        .slice(0, Midi.MAX_PREVIEW_NOTES)
        .sort((a, b) => a.start - b.start);
      this.duration = Math.max(0.05, duration || 0);
      this.index = 0;
      this.playing = true;
      this.onTick = onTick;
      this.onEnd = onEnd;

      const now = context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(0.72, now);
      this.startAt = now + 0.09;

      this.schedule();
      this.scheduleTimer = window.setInterval(() => this.schedule(), 70);

      const tick = () => {
        if (!this.playing) return;
        const elapsed = Math.max(0, this.context.currentTime - this.startAt);
        if (this.onTick) this.onTick(Math.min(elapsed, this.duration));
        if (elapsed < this.duration + 0.35) this.uiRaf = window.requestAnimationFrame(tick);
      };
      this.uiRaf = window.requestAnimationFrame(tick);
      this.endTimer = window.setTimeout(() => this.finish(), (this.duration + 0.7) * 1000);
    }

    schedule() {
      if (!this.playing) return;
      const horizon = this.context.currentTime - this.startAt + 0.65;
      while (this.index < this.notes.length && this.notes[this.index].start <= horizon) {
        const note = this.notes[this.index];
        this.index += 1;
        if (!note || note.end <= 0) continue;
        this.scheduleNote(note);
      }
    }

    scheduleNote(note) {
      const context = this.context;
      const now = context.currentTime;
      const when = this.startAt + Math.max(0, note.start);
      if (when < now - 0.08) return;

      const start = Math.max(when, now + 0.006);
      const duration = Math.max(0.05, Math.min(note.end - note.start, this.duration - note.start, 30));
      const velocity = Math.max(0.05, Math.min(1, (note.velocity || 80) / 127));
      const frequency = 440 * Math.pow(2, (note.pitch - 69) / 12);
      if (!Number.isFinite(frequency) || frequency < 18 || frequency > 12000) return;

      const pitchFactor = note.pitch < 48 ? 0.82 : note.pitch > 84 ? 0.66 : 1;
      const peak = (0.033 + velocity * 0.034) * pitchFactor;

      const amp = context.createGain();
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.linearRampToValueAtTime(peak, start + 0.013);
      amp.gain.linearRampToValueAtTime(peak * 0.62, start + Math.min(duration, 0.2));
      amp.gain.setValueAtTime(peak * 0.55, start + duration);
      amp.gain.linearRampToValueAtTime(0.0001, start + duration + 0.27);

      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(8200, 2200 + velocity * 3400);
      filter.Q.value = 0.4;
      amp.connect(filter);

      let output = filter;
      if (typeof context.createStereoPanner === 'function') {
        const panner = context.createStereoPanner();
        panner.pan.value = Math.max(-0.32, Math.min(0.32, ((note.pitch - 60) / 60) * 0.55));
        filter.connect(panner);
        output = panner;
      }
      output.connect(this.master);
      output.connect(this.send);

      const oscillatorA = context.createOscillator();
      oscillatorA.type = 'triangle';
      oscillatorA.frequency.setValueAtTime(frequency, start);
      const gainA = context.createGain();
      gainA.gain.value = 0.76;

      const oscillatorB = context.createOscillator();
      oscillatorB.type = 'sine';
      oscillatorB.frequency.setValueAtTime(Math.min(16000, frequency * 2), start);
      oscillatorB.detune.value = 4;
      const gainB = context.createGain();
      gainB.gain.value = 0.16;

      oscillatorA.connect(gainA);
      gainA.connect(amp);
      oscillatorB.connect(gainB);
      gainB.connect(amp);

      const stopAt = start + duration + 0.32;
      const voices = this.voices;
      [oscillatorA, oscillatorB].forEach((oscillator) => {
        oscillator.start(start);
        oscillator.stop(stopAt);
        voices.add(oscillator);
        oscillator.onended = () => voices.delete(oscillator);
      });
    }

    stopTimers() {
      window.clearInterval(this.scheduleTimer);
      window.cancelAnimationFrame(this.uiRaf);
      window.clearTimeout(this.endTimer);
      this.scheduleTimer = 0;
      this.uiRaf = 0;
      this.endTimer = 0;
    }

    stopSources() {
      this.voices.forEach((oscillator) => {
        try {
          oscillator.stop();
        } catch (error) {
          /* already stopped */
        }
        oscillator.disconnect();
      });
      this.voices.clear();
    }

    finish() {
      if (!this.playing) return;
      this.playing = false;
      this.stopTimers();
      this.stopSources();
      const callback = this.onEnd;
      this.onTick = null;
      this.onEnd = null;
      if (callback) callback();
    }

    stop() {
      this.playing = false;
      this.stopTimers();
      this.stopSources();
      if (this.master && this.context) {
        const now = this.context.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(this.master.gain.value, now);
        this.master.gain.linearRampToValueAtTime(0.0001, now + 0.03);
        const context = this.context;
        const master = this.master;
        window.setTimeout(() => {
          if (this.playing || this.context !== context) return;
          master.gain.cancelScheduledValues(context.currentTime);
          master.gain.setValueAtTime(0.72, context.currentTime);
        }, 110);
      }
      this.onTick = null;
      this.onEnd = null;
    }
  }

  /* =======================================================
     Playback UI
     ======================================================= */

  function setPlayButtonState(entry, playing) {
    if (!entry.el) return;
    const button = $('[data-role="play"]', entry.el);
    const label = $('[data-role="playLabel"]', entry.el);
    if (!button) return;
    button.classList.toggle('is-playing', playing);
    button.setAttribute('aria-pressed', String(playing));
    button.setAttribute('aria-label', playing ? `Vorschau von ${entry.name} stoppen` : `Vorschau von ${entry.name} abspielen`);
    if (label) label.textContent = playing ? 'Stopp' : 'Anhören';
  }

  function resetPlaybackTime(entry) {
    if (!entry.el || !entry.result) return;
    const time = $('[data-role="time"]', entry.el);
    if (time) time.textContent = `00:00 / ${formatDuration(entry.result.stats.durationSec)}`;
  }

  function updatePlaybackUI(entry, seconds) {
    if (!entry.el || !entry.result) return;
    const duration = Math.max(0.1, entry.result.stats.durationSec);
    if (entry.roll) entry.roll.setProgress(Math.min(1, seconds / duration));
    const time = $('[data-role="time"]', entry.el);
    if (time) {
      const text = `${formatTime(seconds)} / ${formatDuration(duration)}`;
      if (time.textContent !== text) time.textContent = text;
    }
  }

  function finishPlaybackUI(entry) {
    if (state.playing && state.playing.entry === entry) state.playing = null;
    entry.playing = false;
    setPlayButtonState(entry, false);
    if (entry.roll) entry.roll.setProgress(null);
    resetPlaybackTime(entry);
  }

  function stopPlayback() {
    const current = state.playing;
    if (audioPlayer) audioPlayer.stop();
    state.playing = null;
    if (current) {
      const entry = current.entry;
      entry.playing = false;
      setPlayButtonState(entry, false);
      if (entry.roll) entry.roll.setProgress(null);
      resetPlaybackTime(entry);
    }
  }

  function togglePlayback(entry) {
    if (!entry.result) return;
    if (state.playing && state.playing.entry === entry) {
      stopPlayback();
      return;
    }

    stopPlayback();
    if (!audioPlayer) audioPlayer = new SynthPlayer();

    const duration = Math.max(0.1, entry.result.stats.durationSec);
    try {
      audioPlayer.play(
        entry.result.notes,
        duration,
        (seconds) => updatePlaybackUI(entry, seconds),
        () => finishPlaybackUI(entry)
      );
      state.playing = { entry };
      entry.playing = true;
      setPlayButtonState(entry, true);
      updatePlaybackUI(entry, 0);
    } catch (error) {
      console.error('notenklar: Audiovorschau fehlgeschlagen.', error);
      showToast(error.message || 'Die Vorschau konnte nicht abgespielt werden.', 'error');
      entry.playing = false;
      setPlayButtonState(entry, false);
      if (state.playing && state.playing.entry === entry) state.playing = null;
    }
  }

  /* =======================================================
     Init
     ======================================================= */

  function init() {
    if (els.year) els.year.textContent = String(new Date().getFullYear());
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });

    if (els.menuBtn) {
      els.menuBtn.addEventListener('click', () => {
        setMenu(!els.nav.classList.contains('is-open'));
      });
    }

    $$('.nav__link, .footer__nav a').forEach((link) => {
      link.addEventListener('click', () => setMenu(false));
    });

    document.addEventListener('click', (event) => {
      if (!els.nav.classList.contains('is-open')) return;
      if (els.nav.contains(event.target) || els.menuBtn.contains(event.target)) return;
      setMenu(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setMenu(false);
    });

    window.addEventListener(
      'resize',
      () => {
        if (window.innerWidth > 860) setMenu(false);
      },
      { passive: true }
    );

    els.dropzone.addEventListener('click', openPicker);
    els.dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        openPicker();
      }
    });

    els.pickerTriggers.forEach((button) => button.addEventListener('click', openPicker));

    els.fileInput.addEventListener('change', () => {
      const files = Array.from(els.fileInput.files || []);
      els.fileInput.value = '';
      handleFiles(files);
    });

    els.mergeButtons.forEach((button) => {
      button.addEventListener('click', () => setMergeMode(button.dataset.merge === 'true'));
    });

    els.downloadAll.addEventListener('click', downloadAll);

    window.addEventListener('dragenter', (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      showDragOverlay();
    });

    window.addEventListener('dragover', (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      showDragOverlay();
    });

    window.addEventListener('dragleave', (event) => {
      if (!isFileDrag(event)) return;
      if (event.relatedTarget === null) hideDragOverlay();
    });

    window.addEventListener('drop', (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      hideDragOverlay();
      if (event.dataTransfer) handleFiles(event.dataTransfer.files);
    });

    window.addEventListener('blur', hideDragOverlay);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPlayback();
    });

    window.addEventListener('pagehide', stopPlayback);
    window.addEventListener('beforeunload', stopPlayback);

    setupReveals();
    setupSpotlight();
    updateListSummary();
    updateStudioStatus();
    resetPlaybackTime({ el: null });
  }

  init();
})();
