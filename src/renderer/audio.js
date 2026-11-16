(() => {
  const bridge = window.anotch;
  const MEDIA = 'audio/webm;codecs=opus';
  const SEGMENT_MS = 4600;
  let session = null;

  function stopTracks(stream) { stream?.getTracks().forEach((track) => track.stop()); }
  function canSend(owner) { return session === owner && (!owner.stopping || owner.flush); }

  function captureClip(stream, owner) {
    return new Promise((resolve, reject) => {
      const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: MEDIA, audioBitsPerSecond: 48_000 });
      const parts = [];
      let timer;
      const clean = () => { clearTimeout(timer); owner.recorders.delete(recorder); };
      recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
      recorder.onstop = () => { clean(); resolve(new Blob(parts, { type: recorder.mimeType })); };
      recorder.onerror = () => { clean(); reject(new Error('macOS could not record the audio stream.')); };
      owner.recorders.add(recorder);
      try {
        recorder.start();
        timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, SEGMENT_MS);
      } catch (error) { clean(); reject(error); }
    });
  }

  async function silent(context, bytes) {
    try {
      const audio = await context.decodeAudioData(bytes.slice(0));
      let highest = 0;
      for (let channel = 0; channel < audio.numberOfChannels; channel++) {
        const samples = audio.getChannelData(channel);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
        highest = Math.max(highest, Math.sqrt(sum / Math.ceil(samples.length / 4)));
      }
      return highest < 0.004;
    } catch { return false; }
  }

  async function drain(owner) {
    if (owner.draining) return owner.draining;
    owner.draining = (async () => {
      while (canSend(owner) && owner.queue.length) {
        const { data, mime, source } = owner.queue.shift();
        try {
          const { text } = await bridge.sendAudio(data, mime);
          if (canSend(owner) && text) owner.events.line({ source, text });
        } catch (error) {
          if (!canSend(owner)) return;
          owner.events.error(error.message);
          if (!owner.stopping) void stop(false);
          return;
        }
      }
    })();
    try { await owner.draining; }
    finally { owner.draining = null; }
  }

  async function record(owner, stream, source) {
    const track = stream.getAudioTracks()[0];
    while (session === owner && !owner.stopping && track.readyState === 'live') {
      const clip = await captureClip(stream, owner);
      if (!canSend(owner) || clip.size < 900) continue;
      const data = await clip.arrayBuffer();
      if (await silent(owner.context, data) || !canSend(owner)) continue;
      enqueue(owner, data, clip.type, source);
    }
  }

  function enqueue(owner, data, mime, source) {
    if (!canSend(owner)) return;
    if (owner.queue.length >= 6) {
      owner.events.error('The provider is behind. Anotch skipped the oldest queued clip.');
      owner.queue.shift();
    }
    owner.queue.push({ data, mime, source });
    void drain(owner);
  }

  function describe(error, source) {
    if (source === 'Mic' && ['NotAllowedError', 'NotFoundError', 'NotReadableError'].includes(error.name)) {
      return 'Microphone unavailable. Allow Anotch in macOS Microphone settings.';
    }
    return error.message || 'Audio could not start.';
  }

  async function start(source, events) {
    if (session) return;
    if (source !== 'system' && !window.MediaRecorder?.isTypeSupported(MEDIA)) throw new Error('This Mac microphone format is unavailable.');
    const owner = {
      events, context: source === 'system' ? null : new AudioContext(), streams: new Map(), recorders: new Set(), queue: [], tasks: [],
      system: false, draining: null, stopping: false, flush: false, completion: null
    };
    session = owner;
    try {
      const permission = await bridge.audioReady(source);
      if (session !== owner || owner.stopping) return;
      const errors = [];
      if (source !== 'system') {
        if (!permission.micAllowed) errors.push('Allow Anotch in macOS Microphone settings.');
        else {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
            if (session !== owner || owner.stopping) { stopTracks(stream); return; }
            owner.streams.set('Mic', stream);
          } catch (error) { errors.push(describe(error, 'Mic')); }
        }
      }
      if (session !== owner || owner.stopping) return;
      if (source !== 'mic') {
        try {
          await bridge.startSystemAudio();
          if (session !== owner || owner.stopping) return;
          owner.system = true;
        } catch (error) { errors.push(error.message); }
      }
      if (session !== owner || owner.stopping) return;
      const sources = [...owner.streams.keys(), ...(owner.system ? ['Mac audio'] : [])];
      if (!sources.length) throw new Error(errors.at(0) || 'No audio input opened.');
      events.recording(sources, errors.at(0));
      for (const [label, stream] of owner.streams) {
        stream.getAudioTracks()[0].addEventListener('ended', () => {
          if (session !== owner || owner.stopping) return;
          events.error(label + ' stopped in macOS.');
          void stop(false);
        }, { once: true });
        owner.tasks.push(record(owner, stream, label).catch((error) => {
          if (session !== owner || owner.stopping) return;
          events.error(error.message);
          void stop(false);
        }));
      }
    } catch (error) {
      if (session === owner) {
        await stop(false);
        throw error;
      }
    }
  }

  function stop(flush = false) {
    const owner = session;
    if (!owner) return Promise.resolve();
    if (owner.completion) {
      if (!flush && owner.flush) {
        owner.flush = false;
        owner.queue.length = 0;
        void bridge.stopAudio().catch(() => {});
      }
      return owner.completion;
    }
    owner.stopping = true;
    owner.flush = flush;
    if (!flush) owner.queue.length = 0;
    owner.events.stopping(flush);
    for (const recorder of owner.recorders) if (recorder.state !== 'inactive') recorder.stop();
    for (const stream of owner.streams.values()) stopTracks(stream);
    owner.completion = (async () => {
      if (flush) {
        await bridge.stopSystemAudio(true).catch(() => {});
        await Promise.allSettled(owner.tasks);
        const outstanding = drain(owner);
        let timer;
        await Promise.race([outstanding, new Promise((resolve) => { timer = setTimeout(resolve, 12_000); })]);
        clearTimeout(timer);
      } else await bridge.stopAudio().catch(() => {});
      if (session === owner) session = null;
      owner.queue.length = 0;
      await Promise.allSettled([owner.context?.close(), flush ? bridge.stopAudio() : undefined]);
      owner.events.stopped();
    })();
    return owner.completion;
  }

  bridge.onSystemClip((data) => {
    const owner = session;
    if (owner?.system) enqueue(owner, data, 'audio/wav', 'Mac audio');
  });
  bridge.onSystemEnded((message) => {
    const owner = session;
    if (!owner?.system || owner.stopping) return;
    owner.system = false;
    owner.events.error(message);
    if (!owner.streams.size) void stop(false);
  });
  bridge.onAudioRouteChanged(() => {
    const owner = session;
    if (!owner) return;
    owner.events.error('Listening stopped after transcription settings changed.');
    void stop(false);
  });
  window.anotchAudio = { start, stop, active: () => Boolean(session) };
})();
