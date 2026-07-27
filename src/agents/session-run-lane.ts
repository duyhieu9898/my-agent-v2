import { AppError } from "../core/errors.js";

type QueuedWork = { cancelled: boolean; execute(): Promise<void> };

export class SessionRunLaneCoordinator {
  private readonly lanes = new Map<
    string,
    { active: boolean; reserved: number; queue: QueuedWork[] }
  >();
  public constructor(private readonly capacity: number) {}
  reserve(key: string): {
    enqueue(execute: () => Promise<void>): void;
    cancel(): void;
  } {
    const lane = this.lanes.get(key) ?? {
      active: false,
      reserved: 0,
      queue: [],
    };
    if (
      lane.queue.length + lane.reserved + (lane.active ? 1 : 0) >=
      this.capacity
    )
      throw new AppError("SESSION_RUN_QUEUE_FULL", "Session run queue is full");
    lane.reserved += 1;
    this.lanes.set(key, lane);
    const work: QueuedWork = { cancelled: false, execute: async () => {} };
    let enqueued = false;
    let cancelled = false;
    return {
      enqueue: (execute) => {
        if (cancelled) return;
        lane.reserved -= 1;
        enqueued = true;
        work.execute = execute;
        lane.queue.push(work);
        void this.drain(key, lane);
      },
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (!enqueued) lane.reserved -= 1;
        work.cancelled = true;
        if (!lane.active && !lane.queue.length && !lane.reserved)
          this.lanes.delete(key);
      },
    };
  }
  private async drain(
    key: string,
    lane: { active: boolean; reserved: number; queue: QueuedWork[] },
  ): Promise<void> {
    if (lane.active) return;
    lane.active = true;
    try {
      while (lane.queue.length) {
        const work = lane.queue.shift();
        if (work && !work.cancelled) await work.execute();
      }
    } finally {
      lane.active = false;
      if (!lane.queue.length && !lane.reserved) this.lanes.delete(key);
    }
  }
}
