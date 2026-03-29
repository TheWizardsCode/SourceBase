// Re-export the root config module so moved CLI files can import
// using the old path (src/cli/config/cli.js) without changing
// their import locations. Keep this file move-only and lightweight.
// Re-export the root config module. The CLI code imports
// '../../config/cli.js' from files under src/cli/lib/; to keep
// those imports working during the move we re-export the project's
// central config from here.
export * from "../../config/cli.js";
