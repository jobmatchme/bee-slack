import chalk from "chalk";

function timestamp(): string {
	return new Date().toISOString();
}

export function logInfo(message: string): void {
	console.log(`${chalk.gray(timestamp())} ${chalk.cyan("INFO")} ${message}`);
}

export function logWarning(message: string): void {
	console.warn(`${chalk.gray(timestamp())} ${chalk.yellow("WARN")} ${message}`);
}

export function logError(message: string, error?: string): void {
	console.error(`${chalk.gray(timestamp())} ${chalk.red("ERROR")} ${message}${error ? `: ${error}` : ""}`);
}
