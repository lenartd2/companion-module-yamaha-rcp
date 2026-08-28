// Phase 5 P2 (PLAN.md §9): mic on-air monitor dim + optional exclusive-mic mode.
//
// Off by default (config.enableMicMonitorDim / config.micExclusiveMode both default false) - built
// and only unit/logic-tested without live hardware, per the user's request to hold all real-console
// testing until they're back on premise. NOT YET LIVE-VERIFIED - read PLAN.md's Phase 5 writeup
// before enabling this against a real console. This is the one feature in this project that writes
// to a live monitor bus in response to a mic-open event in a room that runs voice lift; get someone
// listening in the room before trusting it.
//
// Which input channels count as "mic channels" is a studio-specific patch decision, not something
// this module can know on its own - config.micChannels (comma-separated, 1-based) controls it.

const MIC_ON_ADDRESS = 'MIXER:Current/InCh/Fader/On'
const MONITOR_LEVEL_ADDRESS = 'MIXER:Current/Monitor/Fader/Level'
const DIM_FADE_SECONDS = '1'

// 1-based channel numbers as configured -> 0-based dataStore/wire indexes.
const getMicChannelIndexes = (instance) => {
	return String(instance.config.micChannels || '')
		.split(',')
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => Number.isInteger(n) && n >= 1)
		.map((n) => n - 1)
}

const anyMicOn = (instance) => {
	const store = instance.dataStore[MIC_ON_ADDRESS]
	if (store === undefined) return false
	return getMicChannelIndexes(instance).some((x) => store[x]?.[0] == 1)
}

const updateMonitorDim = (instance) => {
	const paramFuncs = require('./paramFuncs.js')
	const monitorCmd = paramFuncs.findRcpCmd(instance, MONITOR_LEVEL_ADDRESS)
	if (monitorCmd === undefined) {
		// Not every model has a Monitor bus (the RIO/TIO/RSIO stageboxes, for instance) - warn once
		// and do nothing rather than fail silently forever or throw.
		if (!instance._loggedMicMonitorDimUnsupported) {
			instance._loggedMicMonitorDimUnsupported = true
			instance.log(
				'warn',
				'Monitor Auto-Dim is enabled but this model has no Monitor/Fader/Level parameter - ignoring.',
			)
		}
		return
	}

	const minDb = parseInt(monitorCmd.Min) / parseInt(monitorCmd.Scale)
	const micOn = anyMicOn(instance)

	if (micOn && instance._monitorDimActive !== true) {
		const currentRaw = instance.getFromDataStore({ Address: MONITOR_LEVEL_ADDRESS, X: 0, Y: 0 })
		if (currentRaw === undefined) return // Not cached yet - getFromDataStore already queued a get; try again once it lands.

		instance._monitorDimActive = true
		instance._monitorPreDimRawLevel = currentRaw

		const dimAmountDb = Number(instance.config.micMonitorDimDb) || 0
		const currentDb =
			parseInt(currentRaw) <= parseInt(monitorCmd.Min) ? minDb : parseInt(currentRaw) / parseInt(monitorCmd.Scale)
		const targetDb = Math.max(currentDb - dimAmountDb, minDb)

		// prefix: 'set' is required - fadeCmd's own cmd (and every step/end command it derives from
		// it) flows straight into fmtCmd, which reads cmdToFmt.prefix to pick the wire verb.
		paramFuncs.fadeCmd(instance, {
			Address: MONITOR_LEVEL_ADDRESS,
			X: 0,
			Y: 0,
			Val: targetDb <= minDb ? '-Inf' : targetDb,
			Fade: DIM_FADE_SECONDS,
			Rel: false,
			prefix: 'set',
		})
	} else if (!micOn && instance._monitorDimActive === true) {
		instance._monitorDimActive = false
		const preDimRaw = instance._monitorPreDimRawLevel

		paramFuncs.fadeCmd(instance, {
			Address: MONITOR_LEVEL_ADDRESS,
			X: 0,
			Y: 0,
			Val: parseInt(preDimRaw) <= parseInt(monitorCmd.Min) ? '-Inf' : parseInt(preDimRaw) / parseInt(monitorCmd.Scale),
			Fade: DIM_FADE_SECONDS,
			Rel: false,
			prefix: 'set',
		})
	}
}

const enforceExclusiveMic = (instance, openedChannelIndex) => {
	for (const x of getMicChannelIndexes(instance)) {
		if (x === openedChannelIndex) continue
		const currentlyOn = instance.dataStore[MIC_ON_ADDRESS]?.[x]?.[0]
		if (currentlyOn == 1) {
			instance.addToCmdQueue({ Address: MIC_ON_ADDRESS, X: x, Y: 0, Val: 0, prefix: 'set' })
		}
	}
}

module.exports = {
	MIC_ON_ADDRESS,
	getMicChannelIndexes,

	// Called from index.js's addToDataStore whenever InCh/Fader/On changes for a channel listed in
	// config.micChannels. Both features are independent - either can be used without the other.
	handleMicOnChange: (instance, channelIndex, isOn) => {
		if (instance.config.micExclusiveMode && isOn) {
			enforceExclusiveMic(instance, channelIndex)
		}
		if (instance.config.enableMicMonitorDim) {
			updateMonitorDim(instance)
		}
	},
}
