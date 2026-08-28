//
// rcp-probe.js — read-only probe of a Yamaha RCP console.
//
// Opens TCP 49280, asks the console to identify itself, and (optionally) dumps its
// own parameter enumeration so we can diff it against the module's static
// "<Model> Parameters-N.txt" table.
//
// SAFETY: this script only ever sends read commands (devinfo / devstatus / *info).
// It never sends `set`, `ssrecall*`, or `ssupdate*`. Nothing it does changes console state.
//
// Usage:
//   node tools/rcp-probe.js <ip> [--enumerate] [--timeout=ms] [--out=file]
//
//   --enumerate   also attempt the parameter-table dump (prminfo/mtrinfo/scninfo).
//                 Without it, the script only identifies the console.
//   --raw="a;b"   send these semicolon-separated commands verbatim after identification.
//                 Refuses anything that would write to the console.
//   --pace=ms     gap between chunks of 16 commands (default 40). Raise if the
//                 console starts dropping replies on a large sweep.
//
// NOTE: put many commands into ONE invocation rather than looping this script —
// commands are paced internally, and a fresh TCP connection per command is both
// slower and harder on the console.
//
// Example:
//   node tools/rcp-probe.js 192.168.128.9
//   node tools/rcp-probe.js 192.168.128.9 --enumerate --out=DM3-probe.txt
//   node tools/rcp-probe.js 192.168.128.9 --raw='prminfo 0;get MIXER:Current/InCh/Fader/On 0 0'

const net = require('node:net')
const fs = require('node:fs')

const RCP_PORT = 49280

// Read-only identification. Safe on any console.
const IDENT_CMDS = ['devinfo productname', 'devinfo devicename', 'devinfo version', 'devstatus runmode']

// Parameter-table enumeration. Still read-only, but chattier — the console may
// answer with hundreds of lines, or reject the command outright depending on model.
const ENUMERATE_CMDS = ['prminfo', 'mtrinfo', 'scninfo']

function parseArgs(argv) {
	const positional = []
	const flags = {}
	for (const arg of argv) {
		if (arg.startsWith('--')) {
			const [key, value] = arg.slice(2).split('=')
			flags[key] = value === undefined ? true : value
		} else {
			positional.push(arg)
		}
	}
	return { host: positional[0], flags }
}

const { host, flags } = parseArgs(process.argv.slice(2))

if (!host) {
	console.error('usage: node tools/rcp-probe.js <ip> [--enumerate] [--timeout=ms] [--out=file]')
	process.exit(1)
}

const quietMs = Number(flags.timeout) || 2500 // stop once the console has been silent this long
const lines = []

// Guard rail: never let a --raw argument mutate the console.
const WRITE_VERBS = [
	'set',
	'ssrecall',
	'ssrecall_ex',
	'ssrecallt_ex',
	'ssupdate',
	'ssupdate_ex',
	'ssupdatet_ex',
	'event',
]

function assertReadOnly(cmd) {
	const verb = cmd.trim().split(/\s+/)[0]
	if (WRITE_VERBS.includes(verb)) {
		console.error(`refusing to send write command: ${cmd}`)
		process.exit(1)
	}
}

const rawCmds =
	typeof flags.raw === 'string'
		? flags.raw
				.split(';')
				.map((c) => c.trim())
				.filter(Boolean)
		: []
rawCmds.forEach(assertReadOnly)

// --sweep=prminfo:0-300 walks an index range, which is how the console's own
// parameter table is enumerated. Repeatable to sweep several verbs in one run.
const sweepCmds = []
for (const spec of [].concat(flags.sweep ?? [])) {
	if (typeof spec !== 'string') continue
	const match = spec.match(/^(\w+):(\d+)-(\d+)$/)
	if (!match) {
		console.error(`bad --sweep spec (want verb:from-to): ${spec}`)
		process.exit(1)
	}
	const [, verb, from, to] = match
	assertReadOnly(verb)
	for (let i = Number(from); i <= Number(to); i++) {
		sweepCmds.push(`${verb} ${i}`)
	}
}

// Send in paced chunks over ONE connection. A 112-command burst on a single
// socket was observed to produce no replies at all, so keep the chunks small and
// spaced rather than dumping everything into the socket at once.
const PACE_MS = Number(flags.pace) || 40
const CHUNK = 16

const socket = net.createConnection({ host, port: RCP_PORT }, () => {
	console.error(`connected to ${host}:${RCP_PORT}`)
	const cmds = [...IDENT_CMDS, ...(flags.enumerate ? ENUMERATE_CMDS : []), ...rawCmds, ...sweepCmds]
	const verbose = cmds.length <= 24

	let sent = 0
	const sendChunk = () => {
		if (socket.destroyed) return
		const chunk = cmds.slice(sent, sent + CHUNK)
		for (const cmd of chunk) {
			if (verbose) console.error(`  -> ${cmd}`)
			socket.write(`${cmd}\n`)
		}
		sent += chunk.length
		armQuietTimer()
		if (sent < cmds.length) {
			setTimeout(sendChunk, PACE_MS)
		} else if (!verbose) {
			console.error(`  -> ${cmds.length} commands sent`)
		}
	}
	sendChunk()
})

let buffer = ''
let quietTimer

function armQuietTimer() {
	clearTimeout(quietTimer)
	quietTimer = setTimeout(() => socket.end(), quietMs)
}

socket.on('data', (chunk) => {
	armQuietTimer()
	buffer += chunk.toString()
	const received = buffer.split('\n')
	buffer = received.pop() // keep any partial trailing line for next time
	for (const line of received) {
		if (line.length === 0) continue
		lines.push(line)
	}
})

socket.on('error', (err) => {
	console.error(`error: ${err.message}`)
	if (err.code === 'ECONNREFUSED') {
		console.error(
			'\nNothing is listening on 49280 at that address. Most likely the console has a\n' +
				'different IP than you think — its address is a DHCP reservation and the pool has\n' +
				'been observed to shuffle. Re-discover it before assuming a console fault:\n' +
				'  dns-sd -B _netaudio-arc._udp local     # finds the Dante interface, NOT this one\n' +
				'  nmap -p 49280 --open 192.168.128.0/24  # finds the Network (control) interface\n' +
				'Also check you are not pointed at the Dante interface: RCP lives only on the\n' +
				'Network port ("For Mixer Control"), which is a separate address.'
		)
	}
	process.exit(1)
})

socket.on('close', () => {
	clearTimeout(quietTimer)

	const summary = {}
	for (const line of lines) {
		const verb = line.split(' ')[1] ?? '?'
		summary[verb] = (summary[verb] ?? 0) + 1
	}

	console.error(`\nreceived ${lines.length} lines`)
	for (const [verb, count] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
		console.error(`  ${verb}: ${count}`)
	}

	const out = lines.join('\n') + '\n'
	if (flags.out) {
		fs.writeFileSync(flags.out, out)
		console.error(`\nwrote ${flags.out}`)
	} else {
		process.stdout.write(out)
	}
})
