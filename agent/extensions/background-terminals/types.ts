import type { ChildProcess } from "node:child_process";
import type * as fs from "node:fs";
import { Deferred, type RunState } from "../shared/lifecycle.ts";
import { Utf8TailBuffer } from "../shared/text.ts";

export interface StreamSnapshot {
	text: string;
	omittedBytes: number;
	spillPath?: string;
	spillBytes: number;
	spillCapped: boolean;
	spillEvicted: boolean;
}

export interface TerminalSnapshot {
	id: string;
	command: string;
	title: string;
	cwd: string;
	pid?: number;
	state: RunState;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: NodeJS.Signals;
	error?: string;
	residualTreeTerminated?: boolean;
	stdout: StreamSnapshot;
	stderr: StreamSnapshot;
}

export interface StreamCapture {
	tail: Utf8TailBuffer;
	spillPath?: string;
	writer?: fs.WriteStream;
	spillBytes: number;
	spillCapped: boolean;
	spillEvicted: boolean;
	writeError?: string;
}

export interface TerminalRecord {
	id: string;
	command: string;
	title: string;
	cwd: string;
	child: ChildProcess;
	state: RunState;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: NodeJS.Signals;
	error?: string;
	stdout: StreamCapture;
	stderr: StreamCapture;
	completion: Deferred<TerminalSnapshot>;
	settling?: Promise<TerminalSnapshot>;
	closed: boolean;
	processError: boolean;
	killRequested: boolean;
	abortRequested: boolean;
	consumeInterest: number;
	residualTreeTerminated: boolean;
	exitCleanup?: ReturnType<typeof setTimeout>;
}
