export interface ResponseStream {
    id: string;
    active: boolean;
    startedAt: number;
  }

export class ActiveStreamManager {
    private activeStreams: Map<string, ResponseStream> = new Map()

    constructor() {
        setTimeout(this.cleanup, 10 * 1000)
    }

    has(streamId: string): boolean {
        return this.activeStreams.has(streamId)
    }


    get(streamId: string): ResponseStream | undefined {
        return this.activeStreams.get(streamId)
    } 

    register(stream: ResponseStream): void {
        this.activeStreams.set(stream.id, stream)
    }

    abort(streamId: string): void {
        const stream = this.activeStreams?.get(streamId)
        if (stream) {
            stream.active = false
        }
    }

    abortOthers(streamId: string): void {
        this.activeStreams?.forEach(stream => {
            if (stream?.id !== streamId) {
                stream.active = false
            }
        })
    }

    isActive(streamId: string): boolean {
        const stream = this.activeStreams?.get(streamId)
        return stream?.active ?? false
    }


    cleanup() {
        const now = Date.now()
        this.activeStreams?.forEach(stream => {
            if (!stream?.active && now - stream?.startedAt > 30 * 1000) {
                this.activeStreams?.delete(stream.id)
            }
        })
        setTimeout(this.cleanup, 10 * 1000)
    }


}