import {
  configureFsSafeNative,
  type FsSafeNativeMode,
} from "@openclaw/fs-safe";

const nativeMode = configuredNativeMode();

configureFsSafeNative({ mode: nativeMode });

function configuredNativeMode(): FsSafeNativeMode {
  const value = process.env["MY_AGENT_FS_SAFE_NATIVE_MODE"];
  return value === "auto" || value === "off" || value === "require"
    ? value
    : "off";
}
