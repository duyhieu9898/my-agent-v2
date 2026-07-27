export type RuntimeEvent = {
  schemaVersion: 1;
  eventName: string;
  occurredAt: string;
  sourceModule: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  attemptId?: string;
  modelCallId?: string;
  payload: Readonly<Record<string, string | number | boolean | null>>;
};
export class RuntimeEventBus {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  public constructor(private readonly capacity = 100) {}
  private readonly events: RuntimeEvent[] = [];
  emit(event: RuntimeEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* optional delivery is isolated */
      }
    }
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  snapshot(): readonly RuntimeEvent[] {
    return [...this.events];
  }
}
