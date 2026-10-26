/*!
 * notenklar – MIDI cleaner
 * Reads Standard MIDI Files and returns a version with note events only
 * (plus timing metadata). Everything runs locally in the browser.
 */
(function (root) {
  'use strict';

  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_PREVIEW_NOTES = 20000;
  const DEFAULT_TEMPO = 500000;
  const KEEP_META = new Set([0x51, 0x58, 0x59, 0x54]);

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });

  function fail(message) {
    const error = new Error(message);
    error.name = 'MidiError';
    throw error;
  }

  function ascii(bytes, start, length) {
    let value = '';
    for (let i = 0; i < length; i += 1) value += String.fromCharCode(bytes[start + i]);
    return value;
  }

  class Reader {
    constructor(bytes, start, end) {
      this.bytes = bytes;
      this.pos = start || 0;
      this.end = typeof end === 'number' ? end : bytes.length;
    }

    remaining() {
      return this.end - this.pos;
    }

    u8() {
      if (this.pos >= this.end) fail('Die MIDI-Datei endet unerwartet.');
      return this.bytes[this.pos++];
    }

    peek() {
      if (this.pos >= this.end) fail('Die MIDI-Datei endet unerwartet.');
      return this.bytes[this.pos];
    }

    skip(length) {
      if (length < 0 || this.pos + length > this.end) fail('Die MIDI-Datei enthält einen beschädigten Track.');
      this.pos += length;
    }

    slice(length) {
      if (length < 0 || this.pos + length > this.end) fail('Die MIDI-Datei enthält einen beschädigten Track.');
      const value = this.bytes.subarray(this.pos, this.pos + length);
      this.pos += length;
      return value;
    }

    u16() {
      return (this.u8() << 8) | this.u8();
    }

    u32() {
      return this.u8() * 0x1000000 + (this.u8() << 16) + (this.u8() << 8) + this.u8();
    }

    varLen() {
      let value = 0;
      let byte;
      let guard = 0;
      do {
        byte = this.u8();
        value = value * 128 + (byte & 0x7f);
        guard += 1;
        if (guard > 4) fail('Die MIDI-Datei enthält eine ungültige Längenangabe.');
      } while (byte & 0x80);
      return value;
    }
  }

  class Writer {
    constructor() {
      this.bytes = [];
    }

    u8(value) {
      this.bytes.push(value & 0xff);
    }

    u16(value) {
      this.u8(value >>> 8);
      this.u8(value);
    }

    u32(value) {
      this.u8(value >>> 24);
      this.u8(value >>> 16);
      this.u8(value >>> 8);
      this.u8(value);
    }

    ascii(value) {
      for (let i = 0; i < value.length; i += 1) this.u8(value.charCodeAt(i));
    }

    raw(data) {
      for (let i = 0; i < data.length; i += 1) this.bytes.push(data[i]);
    }

    varLen(value) {
      let buffer = value & 0x7f;
      let rest = value >>> 7;
      while (rest > 0) {
        buffer <<= 8;
        buffer |= (rest & 0x7f) | 0x80;
        rest >>>= 7;
      }
      while (true) {
        this.u8(buffer & 0xff);
        if (buffer & 0x80) buffer >>>= 8;
        else break;
      }
    }

    result() {
      return new Uint8Array(this.bytes);
    }
  }

  function decodeText(data) {
    if (!data || !data.length) return '';
    try {
      return decoder.decode(data).replace(/\0+$/g, '').trim();
    } catch (error) {
      return '';
    }
  }

  function parseMidi(arrayBuffer) {
    if (!arrayBuffer || !arrayBuffer.byteLength) fail('Die Datei ist leer.');
    if (arrayBuffer.byteLength > MAX_FILE_BYTES) fail('Die Datei ist größer als 25 MB.');

    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    if (bytes.length < 14) fail('Die Datei ist zu klein für eine MIDI-Datei.');
    if (ascii(bytes, 0, 4) !== 'MThd') {
      fail(
        'Die Datei enthält keine MIDI-Daten (Header "MThd" fehlt). ' +
          'Sie ist beschädigt oder kein MIDI-Export. ' +
          'Bitte erneut aus der DAW exportieren.'
      );
    }

    const header = new Reader(bytes, 4, bytes.length);
    const headerLength = header.u32();
    if (headerLength < 6 || 8 + headerLength > bytes.length) fail('Der MIDI-Header ist beschädigt.');
    const headerEnd = 8 + headerLength;
    const format = header.u16();
    const declaredTracks = header.u16();
    const division = header.u16();

    if (format === 2) fail('MIDI-Format 2 wird nicht unterstützt. Bitte exportiere die Datei als Format 0 oder 1.');
    if (format !== 0 && format !== 1) fail('Unbekanntes MIDI-Format.');
    if (declaredTracks < 1) fail('Die MIDI-Datei enthält keine Spuren.');

    const divisionIsSmpte = (division & 0x8000) !== 0;
    if (!divisionIsSmpte && (division & 0x7fff) === 0) fail('Die MIDI-Datei hat eine ungültige Taktauflösung.');
    if (divisionIsSmpte && (division & 0xff) === 0) fail('Die MIDI-Datei hat eine ungültige SMPTE-Auflösung.');

    const dropped = {
      cc: 0,
      program: 0,
      bend: 0,
      aftertouch: 0,
      sysex: 0,
      meta: 0
    };

    const tracks = [];
    let pos = headerEnd;

    while (pos + 8 <= bytes.length) {
      const chunkId = ascii(bytes, pos, 4);
      const chunkLength = bytes[pos + 4] * 0x1000000 + (bytes[pos + 5] << 16) + (bytes[pos + 6] << 8) + bytes[pos + 7];
      const chunkStart = pos + 8;
      const chunkEnd = chunkStart + chunkLength;
      if (chunkEnd > bytes.length) fail('Die MIDI-Datei ist unvollständig oder beschädigt.');

      if (chunkId === 'MTrk') {
        tracks.push(parseTrack(bytes, chunkStart, chunkEnd, tracks.length, dropped));
      }
      pos = chunkEnd;
    }

    if (!tracks.length) fail('Die MIDI-Datei enthält keine lesbaren Spuren.');
    if (tracks.length > 512) fail('Die MIDI-Datei enthält zu viele Spuren.');

    return {
      bytes,
      format,
      division,
      declaredTracks,
      divisionIsSmpte,
      tracks,
      dropped
    };
  }

  function parseTrack(bytes, start, end, index, dropped) {
    const reader = new Reader(bytes, start, end);
    const events = [];
    let tick = 0;
    let lastTick = 0;
    let runningStatus = null;
    let name = '';
    let nameKept = false;
    let order = 0;
    let eventCount = 0;

    while (reader.remaining() > 0) {
      const delta = reader.varLen();
      tick += delta;
      lastTick = tick;
      eventCount += 1;
      if (eventCount > 1000000) fail('Die MIDI-Datei enthält zu viele Ereignisse.');

      let status = reader.u8();

      if (status < 0x80) {
        if (runningStatus === null) fail('Die MIDI-Datei enthält einen ungültigen Status.');
        reader.pos -= 1;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      } else {
        runningStatus = null;
      }

      if (status === 0xff) {
        const type = reader.u8();
        const length = reader.varLen();
        const data = reader.slice(length);

        if (type === 0x2f) {
          lastTick = tick;
          break;
        }

        let keep = false;
        if (KEEP_META.has(type)) {
          if (type === 0x51 && data.length === 3) keep = true;
          else if (type === 0x58 && data.length === 4) keep = true;
          else if (type === 0x59 && data.length === 2) keep = true;
          else if (type === 0x54 && data.length === 5) keep = true;
        }

        if (type === 0x03 && !nameKept) {
          name = decodeText(data);
          nameKept = true;
          keep = true;
        }

        if (keep) {
          events.push({ kind: 'meta', type, data, tick, order: order++ });
        } else {
          dropped.meta += 1;
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const length = reader.varLen();
        reader.skip(length);
        dropped.sysex += 1;
        continue;
      }

      if (status >= 0xf1) {
        if (status === 0xf2) reader.skip(2);
        else if (status === 0xf1 || status === 0xf3) reader.skip(1);
        dropped.sysex += 1;
        continue;
      }

      const command = status & 0xf0;
      const channel = status & 0x0f;

      if (command === 0x80) {
        const pitch = reader.u8();
        const velocity = reader.u8();
        events.push({ kind: 'off', channel, pitch, velocity, tick, order: order++ });
      } else if (command === 0x90) {
        const pitch = reader.u8();
        const velocity = reader.u8();
        if (velocity === 0) {
          events.push({ kind: 'off', channel, pitch, velocity: 0, tick, order: order++ });
        } else {
          events.push({ kind: 'on', channel, pitch, velocity, tick, order: order++ });
        }
      } else if (command === 0xa0) {
        reader.skip(2);
        dropped.aftertouch += 1;
      } else if (command === 0xb0) {
        reader.skip(2);
        dropped.cc += 1;
      } else if (command === 0xc0) {
        reader.skip(1);
        dropped.program += 1;
      } else if (command === 0xd0) {
        reader.skip(1);
        dropped.aftertouch += 1;
      } else if (command === 0xe0) {
        reader.skip(2);
        dropped.bend += 1;
      } else {
        fail('Die MIDI-Datei enthält ein unbekanntes Ereignis.');
      }
    }

    return {
      index,
      name: name || `Spur ${index + 1}`,
      events,
      endTick: lastTick
    };
  }

  function cleanTrackNotes(track) {
    const events = track.events;
    const open = new Map();
    const paired = new Set();
    const dropped = new Set();
    const generatedOffs = [];
    const notes = [];
    let orphanOffs = 0;
    let zeroLength = 0;
    let closedNotes = 0;

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.kind === 'meta') continue;
      const key = `${event.channel}:${event.pitch}`;

      if (event.kind === 'on') {
        if (!open.has(key)) open.set(key, []);
        open.get(key).push(event);
        continue;
      }

      const queue = open.get(key);
      if (!queue || !queue.length) {
        dropped.add(event);
        orphanOffs += 1;
        continue;
      }

      const on = queue.shift();
      if (event.tick <= on.tick) {
        dropped.add(event);
        dropped.add(on);
        zeroLength += 1;
        continue;
      }

      paired.add(on);
      paired.add(event);
      notes.push({
        pitch: on.pitch,
        channel: on.channel,
        velocity: on.velocity,
        startTick: on.tick,
        endTick: event.tick
      });
    }

    open.forEach((queue) => {
      while (queue.length) {
        const on = queue.shift();
        const offTick = Math.max(track.endTick, on.tick + 1);
        const off = {
          kind: 'off',
          channel: on.channel,
          pitch: on.pitch,
          velocity: 0,
          tick: offTick,
          order: Number.MAX_SAFE_INTEGER
        };
        paired.add(on);
        generatedOffs.push(off);
        notes.push({
          pitch: on.pitch,
          channel: on.channel,
          velocity: on.velocity,
          startTick: on.tick,
          endTick: offTick
        });
        closedNotes += 1;
      }
    });

    const output = [];
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.kind === 'meta' || paired.has(event)) output.push(event);
    }
    output.push.apply(output, generatedOffs);
    output.sort((a, b) => a.tick - b.tick || a.order - b.order);

    return {
      events: output,
      notes,
      orphanOffs,
      zeroLength,
      closedNotes,
      endTick: track.endTick,
      hasTimingMeta: output.some((event) => event.kind === 'meta' && event.type !== 0x03)
    };
  }

  function keepTimelineStart(events) {
    if (!events.length || events[0].tick === 0) return events;
    // Some DAWs place an imported clip at its first event. An empty track name
    // at tick 0 keeps the original lead-in instead of pulling the notes forward.
    return [
      { kind: 'meta', type: 0x03, data: new Uint8Array(0), tick: 0, order: -1 },
      ...events
    ];
  }

  function metaTempo(event) {
    if (!event || event.kind !== 'meta' || event.type !== 0x51) return DEFAULT_TEMPO;
    const value = (event.data[0] << 16) | (event.data[1] << 8) | event.data[2];
    return value > 0 ? value : DEFAULT_TEMPO;
  }

  function buildTimeConverter(division, divisionIsSmpte, tempoEvents) {
    if (divisionIsSmpte) {
      const fps = 256 - ((division >> 8) & 0xff);
      const ticksPerFrame = division & 0xff;
      const ticksPerSecond = Math.max(1, fps * ticksPerFrame);
      return {
        toSec(tick) {
          return tick / ticksPerSecond;
        },
        bpm: null
      };
    }

    const ppq = division & 0x7fff;
    const unique = new Map();
    const sorted = tempoEvents.slice().sort((a, b) => a.tick - b.tick || a.order - b.order);
    for (let i = 0; i < sorted.length; i += 1) {
      unique.set(sorted[i].tick, metaTempo(sorted[i]));
    }

    const changes = [];
    unique.forEach((tempo, tick) => changes.push({ tick, tempo }));
    changes.sort((a, b) => a.tick - b.tick);

    let tempo = DEFAULT_TEMPO;
    let lastTick = 0;
    let lastSec = 0;
    const segments = [{ tick: 0, sec: 0, tempo }];

    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i];
      if (change.tick === 0) {
        tempo = change.tempo;
        segments[0].tempo = tempo;
        continue;
      }
      lastSec += ((change.tick - lastTick) * tempo) / (1000000 * ppq);
      lastTick = change.tick;
      tempo = change.tempo;
      segments.push({ tick: change.tick, sec: lastSec, tempo });
    }

    return {
      toSec(tick) {
        let low = 0;
        let high = segments.length - 1;
        while (low < high) {
          const mid = (low + high + 1) >> 1;
          if (segments[mid].tick <= tick) low = mid;
          else high = mid - 1;
        }
        const segment = segments[low];
        return segment.sec + ((tick - segment.tick) * segment.tempo) / (1000000 * ppq);
      },
      bpm: 60000000 / segments[0].tempo
    };
  }

  function eventPriority(event) {
    if (event.kind === 'meta') return 0;
    if (event.kind === 'off') return 1;
    return 2;
  }

  function buildTrackData(events, endTick) {
    const writer = new Writer();
    let lastTick = 0;

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const tick = Math.max(lastTick, event.tick);
      writer.varLen(tick - lastTick);
      lastTick = tick;

      if (event.kind === 'meta') {
        writer.u8(0xff);
        writer.u8(event.type);
        writer.varLen(event.data.length);
        writer.raw(event.data);
      } else if (event.kind === 'on') {
        writer.u8(0x90 | (event.channel & 0x0f));
        writer.u8(event.pitch & 0x7f);
        writer.u8(event.velocity & 0x7f);
      } else {
        writer.u8(0x80 | (event.channel & 0x0f));
        writer.u8(event.pitch & 0x7f);
        writer.u8(event.velocity & 0x7f);
      }
    }

    writer.varLen(Math.max(0, (endTick || 0) - lastTick));
    writer.u8(0xff);
    writer.u8(0x2f);
    writer.u8(0x00);
    return writer.result();
  }

  function writeMidiFile(format, division, trackData) {
    const writer = new Writer();
    writer.ascii('MThd');
    writer.u32(6);
    writer.u16(format);
    writer.u16(trackData.length);
    writer.u16(division);
    for (let i = 0; i < trackData.length; i += 1) {
      writer.ascii('MTrk');
      writer.u32(trackData[i].length);
      writer.raw(trackData[i]);
    }
    return writer.result();
  }

  function cleanMidi(arrayBuffer, options) {
    const settings = options || {};
    const mergeTracks = !!settings.mergeTracks;
    const parsed = parseMidi(arrayBuffer);
    const counts = parsed.dropped;

    const cleanedTracks = [];
    const allMeta = [];
    const allNotes = [];
    let globalEndTick = 0;
    let orphanOffs = 0;
    let zeroLength = 0;
    let closedNotes = 0;

    for (let i = 0; i < parsed.tracks.length; i += 1) {
      globalEndTick = Math.max(globalEndTick, parsed.tracks[i].endTick);
    }

    for (let i = 0; i < parsed.tracks.length; i += 1) {
      const track = parsed.tracks[i];
      const cleaned = cleanTrackNotes(track);
      orphanOffs += cleaned.orphanOffs;
      zeroLength += cleaned.zeroLength;
      closedNotes += cleaned.closedNotes;

      for (let m = 0; m < cleaned.events.length; m += 1) {
        const event = cleaned.events[m];
        if (event.kind === 'meta') allMeta.push(event);
      }

      for (let n = 0; n < cleaned.notes.length; n += 1) {
        allNotes.push({
          pitch: cleaned.notes[n].pitch,
          channel: cleaned.notes[n].channel,
          velocity: cleaned.notes[n].velocity,
          startTick: cleaned.notes[n].startTick,
          endTick: cleaned.notes[n].endTick,
          track: i
        });
      }

      if (cleaned.notes.length > 0 || cleaned.hasTimingMeta) {
        cleanedTracks.push({
          index: i,
          name: track.name,
          events: cleaned.events,
          endTick: cleaned.endTick
        });
      }
    }

    if (!allNotes.length) {
      fail('In dieser MIDI-Datei stecken keine Noten. Es gibt nichts zu bereinigen.');
    }

    const tempoEvents = allMeta.filter((event) => event.type === 0x51);
    const converter = buildTimeConverter(parsed.division, parsed.divisionIsSmpte, tempoEvents);
    const durationSec = allNotes.reduce((max, note) => Math.max(max, converter.toSec(note.endTick)), 0);

    let timeSignature = null;
    const timeSignatureEvent = allMeta
      .slice()
      .sort((a, b) => a.tick - b.tick)
      .find((event) => event.type === 0x58 && event.data.length >= 2 && event.data[0] > 0);
    if (timeSignatureEvent) {
      const denominator = Math.pow(2, timeSignatureEvent.data[1]);
      if (denominator > 0) timeSignature = `${timeSignatureEvent.data[0]}/${denominator}`;
    }

    const sortedNotes = allNotes.slice().sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
    let previewNotes = sortedNotes.map((note) => {
      const start = converter.toSec(note.startTick);
      const end = Math.max(converter.toSec(note.endTick), start + 0.03);
      return {
        pitch: note.pitch,
        channel: note.channel,
        velocity: note.velocity,
        start,
        end
      };
    });
    const notesTruncated = previewNotes.length > MAX_PREVIEW_NOTES;
    if (notesTruncated) previewNotes = previewNotes.slice(0, MAX_PREVIEW_NOTES);

    let lowPitch = 127;
    let highPitch = 0;
    for (let i = 0; i < allNotes.length; i += 1) {
      if (allNotes[i].pitch < lowPitch) lowPitch = allNotes[i].pitch;
      if (allNotes[i].pitch > highPitch) highPitch = allNotes[i].pitch;
    }

    let outputTracks;
    let formatOut;

    if (mergeTracks) {
      const merged = [];
      for (let t = 0; t < cleanedTracks.length; t += 1) {
        for (let e = 0; e < cleanedTracks[t].events.length; e += 1) {
          const event = cleanedTracks[t].events[e];
          if (event.kind === 'meta' && event.type === 0x03) continue;
          merged.push({ event, track: t, pos: e });
        }
      }
      merged.sort((a, b) => {
        return (
          a.event.tick - b.event.tick ||
          eventPriority(a.event) - eventPriority(b.event) ||
          a.track - b.track ||
          a.pos - b.pos
        );
      });
      outputTracks = [{ events: merged.map((item) => item.event), endTick: globalEndTick }];
      formatOut = 0;
    } else {
      outputTracks = cleanedTracks.map((track) => ({
        events: track.events,
        endTick: track.endTick
      }));
      formatOut = outputTracks.length > 1 ? 1 : 0;
    }

    outputTracks.forEach((track) => {
      track.events = keepTimelineStart(track.events);
    });
    if (outputTracks.length) {
      const last = outputTracks[outputTracks.length - 1];
      last.endTick = Math.max(last.endTick || 0, globalEndTick);
    }

    const trackData = outputTracks.map((track) => buildTrackData(track.events, track.endTick));
    const bytes = writeMidiFile(formatOut, parsed.division, trackData);

    const removedTotal =
      counts.cc +
      counts.program +
      counts.bend +
      counts.aftertouch +
      counts.sysex +
      counts.meta +
      orphanOffs +
      zeroLength * 2;

    const stats = {
      notes: allNotes.length,
      removed: removedTotal,
      dropped: {
        cc: counts.cc,
        program: counts.program,
        bend: counts.bend,
        aftertouch: counts.aftertouch,
        sysex: counts.sysex,
        meta: counts.meta
      },
      orphanOffs,
      zeroLength,
      closedNotes,
      tracksIn: parsed.tracks.length,
      tracksOut: outputTracks.length,
      formatIn: parsed.format,
      formatOut,
      sizeIn: parsed.bytes.length,
      sizeOut: bytes.length,
      durationSec,
      bpm: converter.bpm ? Math.round(converter.bpm) : null,
      timeSignature,
      noteRange: allNotes.length ? `${noteName(lowPitch)}–${noteName(highPitch)}` : null,
      noteRangeLow: allNotes.length ? lowPitch : null,
      noteRangeHigh: allNotes.length ? highPitch : null
    };

    return {
      bytes,
      stats,
      notes: previewNotes,
      notesTruncated,
      meta: {
        durationSec,
        bpm: stats.bpm,
        timeSignature,
        noteRange: stats.noteRange,
        division: parsed.division,
        divisionIsSmpte: parsed.divisionIsSmpte
      }
    };
  }

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function createZip(entries) {
    if (!entries || !entries.length) fail('Es gibt nichts zum Herunterladen.');
    const chunks = [];
    const central = [];
    const now = new Date();
    const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f);
    const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);
    let offset = 0;
    let centralSize = 0;
    const utf8Flag = 0x0800;

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const nameBytes = encoder.encode(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const checksum = crc32(data);

      const local = new Uint8Array(30);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, utf8Flag, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, dosTime, true);
      localView.setUint16(12, dosDate, true);
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);

      chunks.push(local, nameBytes, data);

      const directory = new Uint8Array(46);
      const directoryView = new DataView(directory.buffer);
      directoryView.setUint32(0, 0x02014b50, true);
      directoryView.setUint16(4, 20, true);
      directoryView.setUint16(6, 20, true);
      directoryView.setUint16(8, utf8Flag, true);
      directoryView.setUint16(10, 0, true);
      directoryView.setUint16(12, dosTime, true);
      directoryView.setUint16(14, dosDate, true);
      directoryView.setUint32(16, checksum, true);
      directoryView.setUint32(20, data.length, true);
      directoryView.setUint32(24, data.length, true);
      directoryView.setUint16(28, nameBytes.length, true);
      directoryView.setUint16(30, 0, true);
      directoryView.setUint16(32, 0, true);
      directoryView.setUint16(34, 0, true);
      directoryView.setUint16(36, 0, true);
      directoryView.setUint32(38, 0, true);
      directoryView.setUint32(42, offset, true);

      central.push(directory, nameBytes);
      centralSize += directory.length + nameBytes.length;
      offset += local.length + nameBytes.length + data.length;
    }

    const centralOffset = offset;
    for (let i = 0; i < central.length; i += 1) {
      chunks.push(central[i]);
      offset += central[i].length;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);
    endView.setUint16(20, 0, true);
    chunks.push(end);

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let cursor = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      output.set(chunks[i], cursor);
      cursor += chunks[i].length;
    }
    return output;
  }

  function noteName(pitch) {
    if (!Number.isFinite(pitch)) return '';
    const value = Math.max(0, Math.min(127, Math.round(pitch)));
    return `${NOTE_NAMES[value % 12]}${Math.floor(value / 12) - 1}`;
  }

  const api = {
    cleanMidi,
    createZip,
    noteName,
    MAX_FILE_BYTES,
    MAX_PREVIEW_NOTES
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.NotenklarMidi = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
