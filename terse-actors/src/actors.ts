import { Actor, Emittable, Persisted, type ActorSocket } from "terse-sdk"

export class Counter extends Actor<{ userId: string }, { by: number }, { count: number }> {
    @Persisted
    @Emittable
    count = 0

    async increment(by = 1): Promise<number> {
        this.count += by
        return this.count
    }

    async onMessage(socket: ActorSocket<{ userId: string }, { count: number }>, message: { by: number }): Promise<void> {
        await this.increment(message.by)
        this.broadcast({ count: this.count })
    }
}
