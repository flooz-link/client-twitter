interface TranscriptionData {
  transcript: string;
  isFinal: boolean;
  userId: string;
}

type ProcessCallback = (userId: string, transcript: string) => void;

class TranscriptionMonitor {
  private bufferDuration: number;
  private checkInterval: number;
  private lastTranscriptionTime: Map<string, number>;
  private lastAudioActivityTime: Map<string, number>; // Track when we last received audio
  private transcriptBuffer: Map<string, string>;
  private monitorInterval: NodeJS.Timeout | null;
  private processCallback: ProcessCallback;
  private isRunning: boolean;
  private speechQuietPeriod: number; // How long to wait after last audio before processing

  constructor(
    processCallback: ProcessCallback,
    options: {
      bufferDuration?: number;
      checkInterval?: number;
      speechQuietPeriod?: number;
      autoStart?: boolean;
    } = {},
  ) {
    this.bufferDuration = options.bufferDuration || 500;
    this.checkInterval = options.checkInterval || 100;
    this.speechQuietPeriod = options.speechQuietPeriod || 800; // Default to 800ms of silence
    this.lastTranscriptionTime = new Map<string, number>();
    this.lastAudioActivityTime = new Map<string, number>();
    this.transcriptBuffer = new Map<string, string>();
    this.monitorInterval = null;
    this.processCallback = processCallback;
    this.isRunning = false;

    // If autoStart is true, start monitoring immediately
    if (options.autoStart) {
      this.start();
    }
  }

  public start(): void {
    if (this.isRunning) {
      return; // Already running
    }

    this.monitorInterval = setInterval(() => {
      this.checkAllUsers();
    }, this.checkInterval);

    // TypeScript doesn't have built-in types for the unref method, so we need to use it carefully
    if (this.monitorInterval.unref) {
      this.monitorInterval.unref();
    }

    this.isRunning = true;
  }

  /**
   * Track audio activity from a user - call this when audio data is received
   */
  public trackUserAudioActivity(userId: string): void {
    this.lastAudioActivityTime.set(userId, Date.now());
  }

  public addTranscription(
    userId: string,
    transcript: string,
    isFinal: boolean,
  ): void {
    // Make sure the monitor is running before adding transcriptions
    if (!this.isRunning) {
      this.start();
    }

    this.transcriptBuffer.set(userId, transcript);
    this.lastTranscriptionTime.set(userId, Date.now());

    if (isFinal) {
      // Only process final transcriptions if the user has been silent for a while
      if (!this.isUserCurrentlySpeaking(userId)) {
        this.processUser(userId);
      }
      // Otherwise wait for the regular check to process it once user stops speaking
    }
  }

  /**
   * Check if a user is currently speaking based on recent audio activity
   */
  private isUserCurrentlySpeaking(userId: string): boolean {
    const lastAudioTime = this.lastAudioActivityTime.get(userId) || 0;
    const timeSinceLastAudio = Date.now() - lastAudioTime;
    return timeSinceLastAudio < this.speechQuietPeriod;
  }

  private checkAllUsers(): void {
    const now: number = Date.now();

    for (const [userId, lastTime] of this.lastTranscriptionTime.entries()) {
      const elapsed: number = now - lastTime;
      const isUserSpeaking = this.isUserCurrentlySpeaking(userId);

      // Only process if:
      // 1. Elapsed time exceeds buffer duration AND
      // 2. User is not currently speaking
      if (elapsed >= this.bufferDuration && !isUserSpeaking) {
        this.processUser(userId);
      }
    }

    // We keep the interval running as long as the monitor is active
  }

  private processUser(userId: string): void {
    const transcript = this.transcriptBuffer.get(userId);
    if (transcript) {
      // Call the process callback with the transcript
      this.processCallback(userId, transcript);

      // Clean up
      this.transcriptBuffer.delete(userId);
      this.lastTranscriptionTime.delete(userId);
      // We keep lastAudioActivityTime as it's updated separately
    }
  }

  /**
   * Force processing for a user regardless of speaking state
   * Useful for when you need to process pending transcriptions immediately
   */
  public forceProcessUser(userId: string): void {
    if (this.transcriptBuffer.has(userId)) {
      this.processUser(userId);
    }
  }

  public cleanup(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isRunning = false;
    this.transcriptBuffer.clear();
    this.lastTranscriptionTime.clear();
    this.lastAudioActivityTime.clear();
  }
}

export { TranscriptionMonitor, TranscriptionData };
