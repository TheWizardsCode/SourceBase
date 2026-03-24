#!/usr/bin/env node

const packageJson = {
  version: "0.1.0",
};

interface Command {
  name: string;
  description: string;
  usage: string;
}

const commands: Command[] = [
  {
    name: "add",
    description: "Add a URL to the database",
    usage: "sb add <url>",
  },
  {
    name: "search",
    description: "Perform semantic search on indexed content",
    usage: "sb search <query>",
  },
  {
    name: "stats",
    description: "Display database statistics",
    usage: "sb stats",
  },
];

function showHelp(): void {
  console.log(`Usage: sb <command> [options]

Commands:`);
  
  const maxNameLength = Math.max(...commands.map(cmd => cmd.name.length));
  
  for (const cmd of commands) {
    const padding = " ".repeat(maxNameLength - cmd.name.length + 2);
    console.log(`  ${cmd.name}${padding}${cmd.description}`);
  }
  
  console.log(`
Options:
  --help      Show this help message
  --version   Show version information

Examples:
  sb add https://example.com/article
  sb search "machine learning"
  sb stats`);
}

function showVersion(): void {
  console.log(`sb version ${packageJson.version}`);
}

function showUnknownCommandError(command: string): void {
  console.error(`Error: Unknown command "${command}"`);
  console.error(`Run 'sb --help' for usage information.`);
}

async function validateConfig(): Promise<boolean> {
  try {
    // Dynamically import config to catch validation errors
    const { config } = await import("../config.js");
    // Access DATABASE_URL to ensure it's loaded
    const _ = config.DATABASE_URL;
    return true;
  } catch (error) {
    if (error instanceof Error) {
      // Check if the error is about DATABASE_URL
      if (error.message.includes("DATABASE_URL")) {
        console.error("Error: DATABASE_URL environment variable is required");
      } else {
        console.error(`Error: ${error.message}`);
      }
    } else {
      console.error("Error: Configuration validation failed");
    }
    return false;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    showHelp();
    return 2; // Invalid args
  }
  
  const command = args[0];
  
  // Handle global flags
  if (command === "--help" || command === "-h") {
    showHelp();
    return 0;
  }
  
  if (command === "--version" || command === "-v") {
    showVersion();
    return 0;
  }
  
  // Validate configuration before executing commands
  if (!(await validateConfig())) {
    return 1; // Error
  }
  
  // Route to commands
  const knownCommands = commands.map(cmd => cmd.name);
  
  if (!knownCommands.includes(command)) {
    showUnknownCommandError(command);
    return 2; // Invalid args
  }
  
  // Command routing - for now, commands will be implemented separately
  switch (command) {
    case "add":
      if (args.length < 2) {
        console.error("Error: 'add' command requires at least one URL argument");
        console.error("Usage: sb add <url> [<url2> ...]");
        return 2;
      }
      const { addCommand } = await import("./commands/add.js");
      const { exitCode } = await addCommand(args.slice(1));
      return exitCode;
    case "search":
      console.error("Error: 'search' command not yet implemented");
      return 1;
    case "stats":
      console.error("Error: 'stats' command not yet implemented");
      return 1;
    default:
      showUnknownCommandError(command);
      return 2;
  }
}

main()
  .then(exitCode => {
    process.exit(exitCode);
  })
  .catch(error => {
    console.error("Unexpected error:", error);
    process.exit(1);
  });
