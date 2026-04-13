const WebSocket = require('ws');
const EventEmitter = require('node:events');

class RealtimeSession extends EventEmitter {
    constructor({ apiKey, instructions, voice = 'cedar', model = 'gpt-realtime' }) {
        super();
        this.apiKey = apiKey;
        this.instructions = instructions;
        this.voice = voice;
        this.model = model;
        this.ws = null;
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

            if (event.type === 'session.created') {
                console.log('[RT] session created');
            }

            if (event.type === 'session.updated') {
                console.log('[RT] session updated');
            }

            // Current Realtime API uses response.output_audio.* (see openai realtime.d.ts).
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

            if (event.type === 'response.created') {
                this.emit('responseCreated', event);
            }

            if (event.type === 'response.done') {
                this.emit('responseDone', event);
            }

            if (event.type === 'conversation.item.input_audio_transcription.completed') {
                if (event.transcript) {
                    this.emit('transcript', event.transcript);
                }
            }

            if (event.type === 'error') {
                console.error('[RT API ERROR]', event);
                this.emit('error', event);
            }
        });

        this.send({
            type: 'session.update',
            session: {
                type: 'realtime',
                instructions: this.instructions,
                output_modalities: ['audio'],
                audio: {
                    input: {
                        format: {
                            type: 'audio/pcm',
                            rate: 24000
                        },
                        // Discord segments audio with its own VAD; we commit + response.create per segment.
                        turn_detection: null,
                        transcription: {
                            model: 'gpt-4o-mini-transcribe'
                        }
                    },
                    output: {
                        format: {
                            type: 'audio/pcm',
                            rate: 24000
                        },
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
        this.send({ type: 'response.create' });
    }

    cancelResponse() {
        this.send({ type: 'response.cancel' });
    }

    clearOutputAudioBuffer() {
        this.send({ type: 'output_audio_buffer.clear' });
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