export interface StreamData {
  id: string;
  active: boolean;
  startedAt: number;
  userId: string;
  message: string;
  responseText?: string;
}

export class ActiveStreamManager {
  private activeStreams: Map<string, StreamData>;
  private cleanupTimeout: NodeJS.Timeout;

  constructor() {
    this.activeStreams = new Map();
    this.cleanupTimeout = setInterval(() => {
      this.cleanup();
    }, 10 * 1000);
  }

  has(streamId: string): boolean {
    return this.activeStreams.has(streamId);
  }

  get(streamId: string): StreamData | undefined {
    return this.activeStreams.get(streamId);
  }

  register(stream: StreamData): void {
    this.activeStreams.set(stream.id, stream);
  }

  abort(streamId: string): void {
    const stream = this.activeStreams?.get(streamId);
    if (stream) {
      stream.active = false;
    }
  }

  findAllByUserId(userId: string): StreamData[] {
    if (this.activeStreams.size === 0) {
      return [];
    }
    return Array.from(this.activeStreams?.values() ?? []).filter(
      (stream) => stream.userId === userId,
    );
  }
  /**
   * Abort all streams except the specified one
   * @param exceptId Stream ID to keep active
   */
  public abortOthers(exceptId: string): void {
    for (const [id, stream] of this.activeStreams.entries()) {
      if (id !== exceptId && stream.active) {
        stream.active = false;
        this.activeStreams.set(id, stream);
      }
    }
  }

  /**
   * Update the response text for a stream
   * @param id Stream ID
   * @param text Text to append to the stream's response
   */
  public updateResponseText(id: string, text: string): void {
    const stream = this.activeStreams.get(id);
    if (stream) {
      stream.message = (this.activeStreams.get(id)?.message || '') + text;
      this.activeStreams.set(id, stream);
    }
  }
  isActive(streamId: string): boolean {
    const stream = this.activeStreams?.get(streamId);
    return stream?.active ?? false;
  }

  cleanup = () => {
    const now = Date.now();
    for (const stream of this.activeStreams?.values() ?? []) {
      if (!stream?.active && now - stream?.startedAt > 30 * 1000) {
        this.activeStreams?.delete(stream.id);
      }
    }
  };
}
