const WebSocket = require('ws');
const EventEmitter = require('node:events');
const { isSubstantiveTranscript } = require('../utils/transcriptFilter');

class RealtimeSession extends EventEmitter {
    constructor({ apiKey, instructions, voice = 'cedar', model = 'gpt-realtime' }) {
        super();
        this.apiKey = apiKey;
        this.instructions = instructions;
        this.voice = voice;
        this.model = model;
        this.ws = null;
        this._assistantTranscript = '';
        this._assistantTranscriptEmitted = false;
    }

    async connect() {
        await new Promise((resolve, reject) => {
            this.ws = new WebSocket(
                `wss://api.openai.com/v1/realtime?model=${this.model}`,
                {
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                }
            );

            this.ws.once('open', resolve);
            this.ws.once('error', reject);
        });

        this.ws.on('message', (raw) => {
            let event;
            try {
                event = JSON.parse(raw.toString());
            } catch (e) {
                console.error('[RT] invalid JSON from server', e);
                return;
            }

            const debug = process.env.RT_DEBUG === '1';

            if (event.type === 'session.created') {
                console.log('[RT] session created');
            }

            if (event.type === 'session.updated') {
                console.log('[RT] session updated');
                if (debug) {
                    console.log(
                        '[RT] effective output_modalities:',
                        event.session?.output_modalities,
                        'audio.output:',
                        JSON.stringify(event.session?.audio?.output)
                    );
                }
            }

            // Streamed output audio (primary path).
            const audioDelta =
                (event.type === 'response.output_audio.delta' && event.delta) ||
                (event.type === 'response.audio.delta' && event.delta);
            if (audioDelta) {
                this.emit('audioDelta', audioDelta);
            }

            if (
                event.type === 'response.output_audio.done' ||
                event.type === 'response.audio.done'
            ) {
                this.emit('audioDone');
            }

            // Some sessions deliver assistant audio on content_part.done instead of deltas.
            if (event.type === 'response.content_part.done' && event.part?.type === 'audio' && event.part.audio) {
                this.emit('audioDelta', event.part.audio);
                this.emit('audioDone');
            }

            if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
                this._assistantTranscript += event.delta;
            }

            if (event.type === 'response.output_audio_transcript.done') {
                const text = event.transcript?.trim() || this._assistantTranscript.trim();
                this._assistantTranscript = '';
                if (isSubstantiveTranscript(text)) {
                    this._assistantTranscriptEmitted = true;
                    this.emit('assistantTranscript', text);
                }
            }

            if (event.type === 'response.created') {
                this._assistantTranscript = '';
                this._assistantTranscriptEmitted = false;
                if (debug) {
                    console.log(
                        '[RT] response.created modalities:',
                        event.response?.output_modalities
                    );
                }
                this.emit('responseCreated', event);
            }

            if (event.type === 'response.done') {
                const mods = event.response?.output_modalities;
                if (mods && !mods.includes('audio')) {
                    console.warn(
                        '[RT] response completed without audio modality; got:',
                        mods,
                        'status:',
                        event.response?.status
                    );
                }
                const status = event.response?.status;
                const partial = this._assistantTranscript.trim();
                if (
                    isSubstantiveTranscript(partial) &&
                    !this._assistantTranscriptEmitted &&
                    status &&
                    status !== 'completed'
                ) {
                    this.emit('assistantTranscript', partial);
                }
                this._assistantTranscript = '';
                this._assistantTranscriptEmitted = false;
                this.emit('responseDone', event);
            }

            if (event.type === 'conversation.item.input_audio_transcription.completed') {
                const t = event.transcript?.trim() ?? '';
                if (isSubstantiveTranscript(t)) {
                    this.emit('transcript', t);
                }
            }

            if (event.type === 'error') {
                console.error('[RT API ERROR]', event);
                this.emit('error', event);
            }
        });

        // Shape matches OpenAI Realtime TypeScript types (RealtimeSessionCreateRequest).
        this.send({
            type: 'session.update',
            session: {
                type: 'realtime',
                instructions: this.instructions,
                output_modalities: ['audio'],
                audio: {
                    input: {
                        format: { type: 'audio/pcm', rate: 24000 },
                        turn_detection: null,
                        transcription: {
                            model: 'gpt-4o-mini-transcribe'
                        }
                    },
                    output: {
                        format: { type: 'audio/pcm', rate: 24000 },
                        voice: this.voice
                    }
                }
            }
        });
    }

    appendAudio(base64Audio) {
        this.send({
            type: 'input_audio_buffer.append',
            audio: base64Audio,
        });
    }

    commitAudio() {
        this.send({ type: 'input_audio_buffer.commit' });
    }

    createResponse() {
        // Per-turn hint: empty create() can occasionally yield non-audio responses depending on server defaults.
        this.send({
            type: 'response.create',
            response: {
                output_modalities: ['audio'],
                max_output_tokens: 4096,
                audio: {
                    output: {
                        format: { type: 'audio/pcm', rate: 24000 },
                        voice: this.voice
                    }
                }
            }
        });
    }

    cancelResponse() {
        this.send({ type: 'response.cancel' });
    }

    clearInputBuffer() {
        this.send({ type: 'input_audio_buffer.clear' });
    }

    send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

module.exports = { RealtimeSession };