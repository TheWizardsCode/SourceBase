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
    usage: "sb add [--verbose] <url> [<url2> ...]",
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
  --verbose   Enable verbose output (JSON logging)

Examples:
  sb add https://example.com/article
  sb add --verbose https://example.com/article
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

function parseArgs(args: string[]): { command: string | null; commandArgs: string[]; verbose: boolean } {
  const globalFlags = new Set(["--help", "-h", "--version", "-v", "--verbose"]);
  
  let verbose = false;
  const remainingArgs: string[] = [];
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--verbose") {
      verbose = true;
    } else if (!globalFlags.has(arg)) {
      remainingArgs.push(arg);
    }
  }
  
  const command = remainingArgs.length > 0 ? remainingArgs[0] : null;
  const commandArgs = remainingArgs.slice(1);
  
  return { command, commandArgs, verbose };
}

async function main(): Promise<number> {
  const allArgs = process.argv.slice(2);
  
  if (allArgs.length === 0) {
    showHelp();
    return 2; // Invalid args
  }
  
  // Handle global flags immediately (before command parsing)
  if (allArgs[0] === "--help" || allArgs[0] === "-h") {
    showHelp();
    return 0;
  }
  
  if (allArgs[0] === "--version" || allArgs[0] === "-v") {
    showVersion();
    return 0;
  }
  
  // Parse args to extract --verbose and get command
  const { command, commandArgs, verbose } = parseArgs(allArgs);
  
  if (!command) {
    showHelp();
    return 2; // Invalid args
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
  
  // Command routing
  switch (command) {
    case "add":
      if (commandArgs.length === 0) {
        console.error("Error: 'add' command requires at least one URL argument");
        console.error("Usage: sb add [--verbose] <url> [<url2> ...]");
        return 2;
      }
      const { addCommand } = await import("./commands/add.js");
      const { exitCode } = await addCommand(commandArgs, { verbose });
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
