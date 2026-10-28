import type { StateCreator } from "zustand/vanilla";
import { generateUuidv4 } from "../../uuid.ts";
import type {
  SentryStore,
  Subscription,
  SubscriptionsSliceActions,
  SubscriptionsSliceState,
} from "../types.ts";

export const createSubscriptionsSlice: StateCreator<
  SentryStore,
  [],
  [],
  SubscriptionsSliceState & SubscriptionsSliceActions
> = (set, get) => ({
  subscribers: new Map(),

  subscribe: (...args: Subscription) => {
    const id = generateUuidv4();
    const { subscribers } = get();
    const newSubscribers = new Map(subscribers);
    newSubscribers.set(id, args);
    set({ subscribers: newSubscribers });

    return () => {
      const { subscribers: currentSubscribers } = get();
      const updatedSubscribers = new Map(currentSubscribers);
      updatedSubscribers.delete(id);
      set({ subscribers: updatedSubscribers });
    };
  },
});
