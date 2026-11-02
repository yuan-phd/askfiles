// Stand-in for Windows `taskkill /PID <pid> /T /F` in unit tests on macOS and Linux: finds the pid's
// descendants from `ps` before killing anything (as taskkill /T does, so a child reparented when its
// parent dies is still found), then SIGKILLs the whole tree, children first.
//   --record <file>   append one JSON line { name: 'taskkill', event, pid, args, killed }
//   --fail            exit 128 without killing, like taskkill on a pid it cannot find
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i === -1 ? undefined : args[i + 1];
};
const recordFile = opt('--record');
const target = Number(opt('/PID'));
const passed = args.filter((a, i) => a !== '--record' && args[i - 1] !== '--record' && a !== '--fail');

if (args.includes('--fail')) {
  console.error(`ERROR: The process "${target}" not found.`);
  process.exit(128);
}

const children = new Map();
for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
  const [pid, ppid] = line.trim().split(/\s+/).map(Number);
  if (!pid) continue;
  if (!children.has(ppid)) children.set(ppid, []);
  children.get(ppid).push(pid);
}
const tree = [];
const walk = (pid) => {
  for (const c of children.get(pid) ?? []) walk(c);
  tree.push(pid);
};
if (args.includes('/T')) walk(target);
else tree.push(target);

const killed = [];
for (const pid of tree) {
  try {
    process.kill(pid, 'SIGKILL');
    killed.push(pid);
  } catch {
    // Already gone.
  }
}
if (recordFile)
  fs.appendFileSync(
    recordFile,
    JSON.stringify({ name: 'taskkill', event: 'taskkill', pid: target, args: passed, killed, t: Date.now() }) + '\n',
  );
console.log(`SUCCESS: The process with PID ${target} has been terminated.`);
