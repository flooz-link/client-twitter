import {
  createClient,
  DeepgramClient,
  ListenLiveClient,
  LiveTranscriptionEvents,
  SOCKET_STATES,
} from '@deepgram/sdk';
import {
  BaseTranscriptionService,
  DeepgramConfig,
  TranscriptionEvents,
} from './baseTranscription';

export class DeepgramStreamingTranscriptionService extends BaseTranscriptionService {
  private deepgram: DeepgramClient;
  private deepgramSocket: ListenLiveClient;

  constructor(config: DeepgramConfig) {
    super(config);
  }

  initialize() {
    try {
      // Initialize Deepgram
      this.deepgram = createClient(this.config.apiKey);

      // Configure Deepgram with proper audio settings
      this.deepgramSocket = this.deepgram.listen.live({
        language: this.config.language || 'en',
        punctuate: this.config.punctuate !== true,
        smart_format: this.config.smartFormat || false,
        filler_words: this.config.fillerWords || true,
        unknown_words: this.config.unknownWords || true,
        model: this.config.model || 'nova-3',
        encoding: this.config.encoding || 'linear16',
        sample_rate: this.config.sampleRate || 48000,
        channels: this.config.channels || 1,
        interim_results: this.config.interimResults || false,
        vad_events: this.config.vadEvents || true,
        endpointing: this.config.endpointing || 500,
      });

      // Setup event listeners
      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Transcript,
        (data: any) => {
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          console.log(
            `transcription: received transcript ${transcript} isFinal: ${data.is_final} speech_final: ${data.speech_final}`,
          );
          this.emitTranscript(
            transcript,
            data.speech_final ?? data.is_final,
            data,
          );
        },
      );

      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Close,
        async (data: any) => {
          console.warn(`Deepgram: Close event received: ${data?.reason}`);
          this.isInitialized = false;
          this.stopKeepAlive();
          this.deepgramSocket.requestClose();
          this.emit(TranscriptionEvents.DISCONNECTED);

          // Attempt to reconnect after a delay
          setTimeout(() => {
            this.initialize();
          }, 5000);
        },
      );

      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Error,
        (error: any) => {
          this.isInitialized = false;
          console.error(`Deepgram: Error event received: ${error?.message}`);

          this.emit(TranscriptionEvents.ERROR, error);
        },
      );

      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Unhandled,
        (warning: any) => {
          this.emit(TranscriptionEvents.WARNING, warning);
        },
      );

      this.deepgramSocket.addListener(LiveTranscriptionEvents.Open, () => {
        this.emit(TranscriptionEvents.CONNECTED);

        // Send a silent audio buffer to test the connection
        const silentBuffer = new Int16Array(960).fill(0);
        this.deepgramSocket.send(silentBuffer.buffer);
        this.isInitialized = true;

        this.startKeepAlive(() => {
          if (this.deepgramSocket) {
            this.deepgramSocket.keepAlive();

            if (this.deepgramSocket.getReadyState() === SOCKET_STATES.open) {
              // Send a silent audio buffer to keep the connection alive
              const silentBuffer = new Int16Array(960).fill(0);
              this.deepgramSocket.send(silentBuffer.buffer);
            }
          }
        });
      });
    } catch (error) {
      this.emit(TranscriptionEvents.ERROR, error);
      throw error;
    }
  }

  public async start(): Promise<void> {
    if (!this.isInitialized) {
      this.initialize();
    }
  }

  public async stop(): Promise<void> {
    this.stopKeepAlive();
    if (this.deepgramSocket) {
      this.deepgramSocket.requestClose();
      this.deepgramSocket = null;
    }
    this.isInitialized = false;
  }

  public sendAudio(audioBuffer: Int16Array): void {
    if (this.deepgramSocket && this.isInitialized) {
      this.deepgramSocket.send(audioBuffer);
    } else {
      console.error(
        `Tried to send audio to Deepgram, but it is not initialized`,
      );
    }
  }
}
