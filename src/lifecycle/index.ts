// Lifecycle module exports
export {
  LifecycleManager,
  createLifecycleManager,
  type LifecycleManagerConfig,
  type StartupNotificationConfig,
  type RecoveryResult,
  type StatusMessageState,
  type ShutdownConfig,
  type LifecycleEventListeners,
} from "./LifecycleManager.js";

// Legacy exports for backward compatibility
export { startBot } from "./startup.js";
export {
  createShutdownController,
  type ShutdownController,
} from "./shutdown.js";
