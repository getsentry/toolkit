import type { StateCreator } from "zustand/vanilla";
import type { Sdk, SentryEvent } from "../../types.ts";
import type {
  SDKsSliceActions,
  SDKsSliceState,
  SentryStore,
} from "../types.ts";

const getSDKKey = (sdk: Sdk): string => `${sdk.name}@${sdk.version}`;

export const createSDKsSlice: StateCreator<
  SentryStore,
  [],
  [],
  SDKsSliceState & SDKsSliceActions
> = (set, get) => ({
  sdks: new Map(),

  inferSdkFromEvent: (event: SentryEvent) => {
    const sdk: Sdk = {
      name: "unknown",
      version: "unknown",
      lastSeen: new Date().getTime(),
    };

    if (event.sdk) {
      sdk.name = event.sdk.name || sdk.name;
      sdk.version = event.sdk.version || sdk.version;
    } else if (event.platform) {
      sdk.name = event.platform;
    }

    return sdk;
  },
  storeSdkRecord: (sdk: Sdk) => {
    const sdks = get().sdks;
    const existingSdk = sdks.get(getSDKKey(sdk));
    if (existingSdk) {
      existingSdk.lastSeen = sdk.lastSeen;
    } else {
      const newSdks = new Map(sdks);
      newSdks.set(getSDKKey(sdk), sdk);
      set({ sdks: newSdks });
    }
    return existingSdk || sdk;
  },
  getSdks: () => Array.from(get().sdks.values()),
});
