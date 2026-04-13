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
            const event = JSON.parse(raw.toString());

            if (event.type === 'session.created') {
                console.log('[RT] session created');
            }

            if (event.type === 'session.updated') {
                console.log('[RT] session updated');
            }

            if (event.type === 'response.audio.delta' && event.delta) {
                this.emit('audioDelta', event.delta);
            }

            if (event.type === 'response.audio.done') {
                this.emit('audioDone');
            }

            if (event.type === 'conversation.item.input_audio_transcription.completed') {
                this.emit('transcript', event.transcript);
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
                        turn_detection: {
                            type: 'server_vad',
                            silence_duration_ms: 700,
                            prefix_padding_ms: 300,
                            create_response: true,
                            interrupt_response: true
                        },
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