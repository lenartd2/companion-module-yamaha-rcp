// Control module for Yamaha Pro Audio digital mixers
// Andrew Broughton <andy@checkcheckonetwo.com>
// Aug 2025 Version 3.5.11 (for Companion v3/v4)

const { InstanceBase, Regex, InstanceStatus, combineRgb, TCPHelper } = require('@companion-module/base')

const paramFuncs = require('./paramFuncs')
const actionFuncs = require('./actions.js')
const varFuncs = require('./variables.js')
const upgrade = require('./upgrade')

const RCP_PORT = 49280
const MSG_DELAY = 5
const METER_REFRESH = 10000 // 10 seconds
const KA_INTERVAL = 10000 // 10 seconds

// Instance Setup
class instance extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	// Startup
	async init(cfg) {
		this.updateStatus(InstanceStatus.Connecting)
		this.config = cfg
		this.rcpCommands = []
		this.colorCommands = [] // Commands which have a color field
		this.rcpPresets = []
		this.dataStore = {} // status, Address (using ":"), X, Y, Val
		this.cmdQueue = [] // prefix, Address (using ":"), X, Y, Val
		this.queueTimer
		this.meterTimer = {}
		this.kaTimer = {}
		this.variables = []
		this.newConsole()
	}

	// Change in Configuration
	async configUpdated(cfg) {
		this.config = cfg
		if (this.config.model) {
			this.newConsole()
		}
	}

	// Module deletion
	async destroy() {
		clearTimeout(this.queueTimer)
		clearTimeout(this._feedbackCheckTimer)
		clearTimeout(this._variableFlushTimer)
		clearInterval(this.meterTimer)
		clearInterval(this.kaTimer)
		this.socket?.destroy()
		this.log('debug', `[${new Date().toJSON()}] destroyed ${this.id}`)
	}

	// Web UI config fields
	getConfigFields() {
		let config = [
			{
				type: 'dropdown',
				id: 'model',
				label: 'Console/PreAmp Type',
				width: 12,
				default: 'CL/QL',
				// Referenced by isVisibleExpression below - Companion only allows that for fields which
				// can't themselves be switched to expression mode.
				disableAutoExpression: true,
				choices: [
					{ id: 'CL/QL', label: 'CL/QL Console' },
					{ id: 'PM', label: 'Rivage PM Console' },
					{ id: 'TF', label: 'TF Console' },
					{ id: 'DM3', label: 'DM3 Console' },
					{ id: 'DM7', label: 'DM7 Console' },
					{ id: 'RIO', label: 'RIO Preamp' },
					{ id: 'TIO', label: 'TIO Preamp' },
					{ id: 'RSIO', label: 'RSio IO Device' },
				],
			},
			{
				type: 'bonjour-device',
				id: 'bonjour_host',
				label: 'Bonjour Address of Device',
				width: 6,
				default: '',
				regex: Regex.IP,
				disableAutoExpression: true,
				// isVisible used to also clear options.bonjour_host as a side effect when hidden; plain
				// expressions can't do that. Not chased further here since it only matters for the
				// RIO/TIO/RSIO preamp types this studio's DM3 doesn't use.
				isVisibleExpression: "$(options:model) == 'RIO' || $(options:model) == 'TIO' || $(options:model) == 'RSIO'",
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'IP Address of Device',
				width: 6,
				default: '192.168.0.128',
				regex: Regex.IP,
				isVisibleExpression:
					"!$(options:bonjour_host) || !($(options:model) == 'RIO' || $(options:model) == 'TIO' || $(options:model) == 'RSIO')",
			},
			{
				type: 'static-text',
				id: 'hostSpacer',
				label: '',
				width: 6,
				isVisibleExpression:
					"$(options:bonjour_host) || !($(options:model) == 'RIO' || $(options:model) == 'TIO' || $(options:model) == 'RSIO')",
			},
			{
				type: 'checkbox',
				id: 'allowSceneStore',
				label: 'Allow Scene Store?',
				tooltip:
					'Storing a scene overwrites it on the console with the current state - no confirmation, no undo. Leave this off unless you specifically need a Scene Store button; any Scene Store action is ignored (and logged as a warning) while this is disabled.',
				width: 4,
				default: false,
			},
			{
				type: 'checkbox',
				id: 'metering',
				label: 'Enable Metering?',
				width: 3,
				default: false,
			},
			{
				type: 'number',
				id: 'meterSpeed',
				label: 'Metering interval (40 - 1000 ms)',
				width: 8,
				default: 100,
				min: 40,
				max: 1000,
			},
			{
				type: 'checkbox',
				id: 'keepAlive',
				label: 'Enable KeepAlive?',
				width: 3,
				default: false,
			},
			{
				type: 'static-text',
				id: 'keepAliveNote',
				label:
					'**NOTE** Do not enable KeepAlive unless you know what it means. It is generally not needed and will increase network traffic.',
				width: 12,
			},
		]
		return config
	}

	// Whenever the console type changes, update the info
	newConsole() {
		this.log('info', `Device selected: ${this.config.model}`)
		this.rcpCommands = paramFuncs.getParams(this, this.config)

		actionFuncs.updateActions(this) // Re-do the actions once the console is chosen
		varFuncs.initVars(this)
		this.createPresets()
		this.config.host = this.config.bonjour_host?.split(':')[0] || this.config.host
		this.initTCP()
	}

	// Initialize TCP
	initTCP() {
		let receiveBuffer = ''
		let receivedLines = []
		let receivedCmds = []
		let foundCmd = {}

		this.socket?.destroy()
		delete this.socket

		if (this.config.host) {
			this.socket = new TCPHelper(this.config.host, RCP_PORT)

			this.socket.on('status_change', (status, message) => {
				this.updateStatus(status, message)
			})

			this.socket.on('error', (err) => {
				// TCPHelper already retries on its own (reconnect: true by default) - C7 was mainly
				// about the log flooding that comes with that, once every retry during an extended
				// outage logs an identical line. Only log when the message actually changes.
				if (err.message !== this._lastNetworkError) {
					this._lastNetworkError = err.message
					this.log('error', `Network error: ${err.message}`)
				}
			})

			this.socket.on('connect', () => {
				this._lastNetworkError = undefined
				this.log('info', `Connected!`)
				clearInterval(this.meterTimer)
				clearInterval(this.kaTimer)
				varFuncs.getVars(this)
				varFuncs.requestChannelVariables(this) // Phase 5 P1 - see PLAN.md §9
				this.queueTimer = undefined
				this.processCmdQueue()
				if (this.config.metering) {
					this.startMeters()
					this.meterTimer = setInterval(() => this.startMeters(), METER_REFRESH)
				}
				if (this.config.keepAlive) {
					this.sendCmd(`scpmode keepalive ${KA_INTERVAL}`) // To possibly keep the device from closing the connection
					this.kaTimer = setInterval(() => this.sendCmd('devstatus runmode'), KA_INTERVAL)
				}
			})

			this.socket.on('data', (chunk) => {
				receiveBuffer += chunk
				receivedLines = receiveBuffer.split('\x0A') // Split by line break
				if (receivedLines.length == 0) {
					return // No messages
				}

				if (receiveBuffer.endsWith('\x0A')) {
					// Chunk ended exactly on a line boundary - the last split element is always the
					// empty string after the final delimiter, nothing left pending.
					receiveBuffer = ''
				} else {
					// These two branches were swapped - a chunk that does NOT end on a line boundary
					// means the last split element is a genuinely incomplete line (the rest is still
					// in flight), not the previous branch's always-empty trailing element. The old
					// code cleared the buffer here and let the for-loop below process that incomplete
					// fragment as if it were a complete line - normally invisible (most chunks happen
					// to land on a line boundary), but a heavy stream of rapid lines (e.g. many
					// concurrent meter subscriptions) makes a mid-line chunk split - and the resulting
					// garbled/truncated line - far more likely. Found via a crash in setVar's default
					// case (msg.Address undefined) that only reproduced once, under exactly that kind
					// of load, and never on a quiet connection.
					receiveBuffer = receivedLines[receivedLines.length - 1] // Broken line, leave it for next time...
					receivedLines.splice(receivedLines.length - 1) // Remove it - don't process it yet.
				}

				for (let line of receivedLines) {
					if (line.length == 0) {
						continue
					}
					this.log('debug', `[${new Date().toJSON()}] Received: '${line}'`)
					receivedCmds = paramFuncs.parseData(line) // Break out the parameters

					for (let i = 0; i < receivedCmds.length; i++) {
						// §7.7: parseData()'s output is a flat string-keyed object (see its RCP_*_FIELDS
						// lists) - a shallow copy is exactly equivalent to a deep clone here and much
						// cheaper on a path that runs once per received line.
						let curCmd = { ...receivedCmds[i] }
						foundCmd = paramFuncs.findRcpCmd(this, curCmd.Address, curCmd.Action) // Find which command

						switch (curCmd.Action) {
							case 'set':
							case 'get':
								if (foundCmd != undefined) {
									if (!(curCmd.Status == 'OK' && curCmd.Action == 'set')) {
										this.addToDataStore(curCmd)
									}

									if (this.isRecordingActions) {
										this.addToActionRecording({ rcpCmd: foundCmd, options: curCmd })
									}
								}
								break

							case 'sscurrent_ex':
							case 'sscurrentt_ex':
								if (curCmd.Status == 'NOTIFY') {
									this.pollConsole()
								}
								break

							case 'mtr': {
								if (foundCmd === undefined) break
								if (foundCmd.Pickoff) {
									let lastSlash = curCmd.Address.lastIndexOf('/')
									let pickoff = curCmd.Address.slice(lastSlash + 1)
									curCmd.Y = foundCmd.Pickoff.split('|').indexOf(pickoff)
								}
								curCmd.Address = foundCmd.Address
								let i = 0
								while (curCmd[i]) {
									curCmd.X = i
									curCmd.Val = parseInt(curCmd[i], 16)
									this.addToDataStore(curCmd)
									i++
								}
							}
						}

						varFuncs.setVar(this, curCmd)
						this.processCmdQueue(curCmd)
					}
				}
			})
		}
	}

	// New Command (Action or Feedback) to Add
	addToCmdQueue(cmd) {
		// §7.7: cmd is always a flat string/number-keyed object (an RCP address plus X/Y/Val/prefix) -
		// a shallow copy is exactly equivalent to a deep clone here and much cheaper on a path that
		// runs once per action fire and per feedback subscribe.
		let cmdToAdd = { ...cmd }
		let rcpCmd = paramFuncs.findRcpCmd(this, cmdToAdd.Address)
		let i = this.cmdQueue.findIndex(
			(c) =>
				c.prefix == cmdToAdd.prefix &&
				c.Address == cmdToAdd.Address &&
				((c.X == cmdToAdd.X && c.Y == cmdToAdd.Y) || (rcpCmd.Action == 'mtrinfo' && c.Y == cmdToAdd.Y)),
		)
		if (i > -1) {
			this.cmdQueue[i] = cmdToAdd // Replace queued message with new one
		} else {
			this.cmdQueue.push(cmdToAdd)
		}

		// §7.3: schedule a drain on the next tick instead of pacing sends MSG_DELAY apart. Only the
		// first add after an idle queue schedules anything - a burst of addToCmdQueue() calls within
		// the same synchronous block (e.g. startMeters()'s forEach) all land in cmdQueue before the
		// drain runs, so they go out as one batched TCP write instead of one write per command.
		if (this.queueTimer === undefined) {
			this.queueTimer = setTimeout(() => {
				this.queueTimer = undefined
				this.processCmdQueue()
			}, 0)
		}
	}

	// When a message comes in from the console, match it up and remove it from the queue if
	// present, then drain whatever's left in one batched write.
	processCmdQueue(cmd) {
		if (cmd != undefined) {
			let i = this.cmdQueue.findIndex(
				(c) => c.prefix == 'get' && c.Address == cmd.Address && c.X == cmd.X && c.Y == cmd.Y,
			)
			if (i > -1) {
				this.cmdQueue.splice(i, 1) // Got value from matching request so remove it!
			}
		}

		if (this.cmdQueue == undefined || this.cmdQueue.length == 0) return

		// §7.3: MSG_DELAY used to be a hard ceiling of ~200 msg/s regardless of what the console or
		// socket could actually absorb, paced one send per timer tick. Drain the whole queue into one
		// TCP write instead. A `set` that needs a live value it doesn't have yet (Toggle/relative
		// actions - see parseVal) is deferred to the end instead of blocking everything queued behind
		// it, same retry contract as before.
		let toSend = []
		let deferred = []
		for (const nextCmd of this.cmdQueue) {
			if (nextCmd.prefix == 'set') {
				let nextCmdVal = paramFuncs.parseVal(this, nextCmd)
				if (nextCmdVal == undefined) {
					deferred.push(nextCmd)
					continue
				}
				nextCmd.Val = nextCmdVal
				this.addToDataStore(nextCmd) // Update to latest value
			}
			toSend.push(paramFuncs.fmtCmd(this, nextCmd))
		}

		this.cmdQueue = deferred

		if (toSend.length > 0) {
			this.sendCmd(toSend.join('\n'))
		}

		if (this.cmdQueue.length > 0) {
			// Everything left is a `set` still waiting on a live value - give the in-flight `get`(s) a
			// moment to come back rather than busy-looping.
			this.queueTimer = setTimeout(() => {
				this.queueTimer = undefined
				this.processCmdQueue()
			}, MSG_DELAY)
		} else {
			this.queueTimer = undefined
		}
	}

	// Create the preset definitions
	createPresets() {
		var meterCmds = this.rcpCommands
			.filter((c) => c.Action == 'mtrinfo')
			.sort((a, b) => (a.Index == b.Index ? 0 : a.Index > b.Index ? 1 : -1))
		this.rcpPresets = []
		var meterPreset = {
			type: 'button',
			category: 'Level Meters',
			name: '',
			style: {
				text: '',
				size: 'auto',
				show_topbar: false,
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
			},
			steps: [],
			feedbacks: [
				{
					feedbackId: 'Meter',
					options: {
						position: 'right',
						padding: 1,
						meterVal1: '',
						meterVal2: '',
					},
				},
				{
					feedbackId: '',
					options: {
						X: 1,
						Y: 1,
						createVariable: true,
					},
					style: {},
				},
			],
		}
		for (const c of meterCmds) {
			var curPreset = JSON.parse(JSON.stringify(meterPreset))
			// Two possible meter-row shapes - see PLAN.md §4.5/C6. Old-style (every model except DM3
			// currently): one synthesised row per channel type ("MIXER:Current/Meter/InCh"), a
			// trailing Pickoff column, so one row covers every pickoff and cmdName is just the channel
			// type. New-style (DM3, post-C6-fix): the console's own flat enumeration
			// ("MIXER:Current/InCh/PreHPF") - each row is already one specific real pickoff, so
			// channelType and cmdName differ (cmdName includes the pickoff for a distinct preset name).
			var addrParts = c.Address.split('/')
			var channelType
			var cmdName
			var pickoffIndex
			if (c.Pickoff) {
				channelType = addrParts.length > 0 ? addrParts[addrParts.length - 1] : ''
				cmdName = channelType
				pickoffIndex = c.Index < 2100 ? 1 : c.Y
			} else {
				channelType = addrParts.length > 1 ? addrParts[addrParts.length - 2] : ''
				var pickoffLabel = addrParts.length > 0 ? addrParts[addrParts.length - 1] : ''
				cmdName = channelType && pickoffLabel ? `${channelType}_${pickoffLabel}` : ''
				pickoffIndex = 1
			}
			if (cmdName) {
				curPreset.name = `Meter Level Indicator - ${cmdName}`
				curPreset.style.text = `${cmdName}\\nMeter\\n`
				// Must match variables.js's fbCreatesVar exactly, via the same shared helper - a
				// hand-built prediction here silently drifts out of sync with the name that's actually
				// created (found while fixing C6, see PLAN.md's Phase 4 writeup).
				curPreset.feedbacks[0].options.meterVal1 = `$(${this.label}:${paramFuncs.getAutoVariableName(c, 1, pickoffIndex)})`
				curPreset.feedbacks[1].feedbackId = c.Address.replace(/:/g, '_')
				curPreset.feedbacks[1].options.Y = pickoffIndex
				if (channelType == 'St' || channelType == 'StInCh' || channelType == 'FxRtnCh') {
					// Make a Stereo Meter
					curPreset.feedbacks[0].options.meterVal2 = `$(${this.label}:${paramFuncs.getAutoVariableName(c, 2, pickoffIndex)})`
					curPreset.feedbacks.push(JSON.parse(JSON.stringify(curPreset.feedbacks[1])))
					curPreset.feedbacks[2].options.X = 2 // Right channel
				}
				this.rcpPresets.push(curPreset)
			}
		}

		/*
			{
				type: 'button',
				category: 'Macros',
				name: 'Create RCP Macro',
				style: {
					text: 'Record RCP Macro',
					png64: this.ICON_REC_INACTIVE,
					pngalignment: 'center:center',
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 0),
				},
				steps: [
					{
						down: [{ actionId: 'internal:Action Recorder: Set connections' }],
					},
				],
				feedbacks: [
					{
						feedbackId: 'macro',
						options: {
							mode: 'r',
							fg: combineRgb(0, 0, 0),
							bg: combineRgb(255, 0, 0),
						},
					},
				],
			},

*/

		// setPresetDefinitions now wants a structure (sections grouping preset ids) plus a presets
		// object keyed by id, instead of a flat array with a per-preset category string.
		const slugify = (s) =>
			s
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')
				.replace(/^_+|_+$/g, '')

		// Above, every preset unconditionally sets X/Y/Fade/Rel/etc on its actions and feedbacks, but
		// createAction() only declares each of those when the underlying parameter actually has that
		// axis (e.g. Y is skipped for a mono channel's fader level). Companion 5 validates presets
		// against the real option list and warns loudly about the mismatch, so strip anything a preset
		// references that its target doesn't actually declare - reusing createAction/
		// createFeedbackFromAction themselves rather than re-deriving the same rules a second time.
		const feedbackFuncs = require('./feedbacks.js')
		const declaredOptionIdsCache = new Map()
		const getDeclaredOptionIds = (id, isFeedback) => {
			const cacheKey = `${isFeedback ? 'f' : 'a'}:${id}`
			if (declaredOptionIdsCache.has(cacheKey)) return declaredOptionIdsCache.get(cacheKey)

			// 'Meter' is a hand-authored feedback, not derived from a parameter row - findRcpCmd won't
			// (and shouldn't) resolve it, so leave its options alone.
			const rcpCmd = paramFuncs.findRcpCmd(this, id)
			const declared = rcpCmd
				? new Set(
						(isFeedback
							? feedbackFuncs.createFeedbackFromAction(this, actionFuncs.createAction(this, rcpCmd))
							: actionFuncs.createAction(this, rcpCmd)
						).options.map((opt) => opt.id),
					)
				: null
			declaredOptionIdsCache.set(cacheKey, declared)
			return declared
		}
		const pickDeclaredOptions = (id, options, isFeedback) => {
			const declared = getDeclaredOptionIds(id, isFeedback)
			if (!declared || !options) return options
			return Object.fromEntries(Object.entries(options).filter(([key]) => declared.has(key)))
		}
		const stripUnknownPresetOptions = (preset) => {
			for (const step of preset.steps ?? []) {
				for (const group of Object.values(step)) {
					if (!Array.isArray(group)) continue
					for (const entry of group) {
						if (entry.actionId && entry.options) {
							entry.options = pickDeclaredOptions(entry.actionId, entry.options, false)
						}
					}
				}
			}
			for (const feedback of preset.feedbacks ?? []) {
				if (feedback.feedbackId && feedback.options) {
					feedback.options = pickDeclaredOptions(feedback.feedbackId, feedback.options, true)
				}
			}
			return preset
		}

		const presetsByCategory = new Map()
		for (const preset of this.rcpPresets) {
			if (!presetsByCategory.has(preset.category)) presetsByCategory.set(preset.category, [])
			presetsByCategory.get(preset.category).push(preset)
		}

		const structure = []
		const presets = {}
		for (const [category, categoryPresets] of presetsByCategory) {
			const sectionId = slugify(category)
			const ids = []
			categoryPresets.forEach((preset, index) => {
				const { category: _category, ...presetDefinition } = preset
				presetDefinition.type = 'simple'
				stripUnknownPresetOptions(presetDefinition)
				const id = `${sectionId}_${index}`
				ids.push(id)
				presets[id] = presetDefinition
			})
			structure.push({ id: sectionId, name: category, definitions: ids })
		}

		this.setPresetDefinitions(structure, presets)
	}

	// Track whether actions are being recorded
	handleStartStopRecordActions(isRecording) {
		this.isRecordingActions = isRecording
	}

	// Add a command to the Action Recorder
	async addToActionRecording(c) {
		let aId = c.rcpCmd.Address.replace(/:/g, '_')
		let cX = parseInt(c.options.X) + 1
		let cY = parseInt(c.options.Y) + 1
		let cV

		switch (c.rcpCmd.Type) {
			case 'integer':
			case 'binary':
				cV = c.options.Val == -32768 ? '-Inf' : c.options.Val / c.rcpCmd.Scale
				break
			case 'freq':
				cV = c.options.Val / c.rcpCmd.Scale
				break
			case 'bool':
				cV = 'Toggle'
				break
			case 'string':
				cV = c.options.Val
				break
		}

		this.recordAction(
			{
				actionId: aId,
				options: { X: cX, Y: cY, Val: cV },
			},
			`${aId} ${cX} ${cY}`, // uniqueId to stop duplicates
		)
	}

	sendCmd(c) {
		if (c !== undefined) {
			c = c.trim()
			// §7.3: a batched drain may pass several newline-joined commands to send in one TCP
			// write - log each on its own line so the debug log still reads one command at a time.
			for (const line of c.split('\n')) {
				this.log(
					'debug',
					`[${new Date().toJSON()}] Sending :    '${line}' to ${this.getVariableValue('modelName')} @ ${this.config.host}`,
				)
			}

			if (this.socket !== undefined && this.socket.isConnected) {
				this.socket.send(`${c}\n`) // send the message to the device
				return true
			}
			this.log('info', 'Socket not connected :(')
		}
		return false
	}

	// Poll the console for it's status to update buttons via feedback
	pollConsole() {
		// §7.2: this used to wipe this.dataStore before re-requesting everything, which meant every
		// reply looked like a *change* against an empty store, storming checkFeedbacks() for every
		// address on the page even when a scene recall left most of them untouched (upstream #44).
		// The re-poll is genuinely necessary - the console doesn't say what changed (§4.6) - but the
		// wipe isn't. Re-request every address we already have a cached value for without deleting
		// that value first: addToDataStore() below only fires checkFeedbacks() for an address once
		// the fresh reply actually differs from what's cached, so unaffected buttons stay silent.
		// Meter addresses are excluded - they're already re-requested continuously by meterTimer, so
		// re-fetching them here would only add redundant traffic during the exact moment we're
		// trying to avoid a storm.
		for (const dsAddr of Object.keys(this.dataStore)) {
			const rcpCmd = paramFuncs.findRcpCmd(this, dsAddr)
			if (rcpCmd === undefined || rcpCmd.Type === 'mtr' || !rcpCmd.RW.includes('r')) continue
			for (const dsX of Object.keys(this.dataStore[dsAddr])) {
				for (const dsY of Object.keys(this.dataStore[dsAddr][dsX])) {
					this.addToCmdQueue({ Address: dsAddr, X: Number(dsX), Y: Number(dsY), prefix: 'get' })
				}
			}
		}
		this.subscribeActions()
	}

	// Add a value to the dataStore
	addToDataStore(cmd) {
		let dsAddr = cmd.Address
		let dsX = cmd.X == undefined ? 0 : parseInt(cmd.X)
		let dsY = cmd.Y == undefined ? 0 : parseInt(cmd.Y)

		if (this.dataStore[dsAddr] == undefined) {
			this.dataStore[dsAddr] = {}
		}
		if (this.dataStore[dsAddr][dsX] == undefined) {
			this.dataStore[dsAddr][dsX] = {}
		}
		if (this.dataStore[dsAddr][dsX][dsY] != cmd.Val) {
			this.dataStore[dsAddr][dsX][dsY] = cmd.Val
			this.scheduleFeedbackCheck(dsAddr.replace(/:/g, '_')) // Make sure variables are updated

			// Phase 5 P1 (PLAN.md §9): keep every auto-populated channel variable
			// (requestChannelVariables, variables.js) live without needing a feedback with
			// "Auto-Create Variable" on some button - reuses fbCreatesVar's own naming/conversion via
			// a synthetic feedback-shaped cmd, exactly as a real feedback callback would build one.
			if (this._channelVariableAddresses?.has(dsAddr)) {
				varFuncs.fbCreatesVar(this, { Address: dsAddr, X: dsX + 1, createVariable: true }, cmd.Val, {})
			}
		}
	}

	// §7.5: a meter frame at the default 80ms interval can update a dozen-plus channel values in a
	// single burst; calling checkFeedbacks() once per changed address (as addToDataStore used to)
	// meant a full feedback sweep per channel per frame. Collect every address that actually changed
	// during the current synchronous burst and fire one checkFeedbacks() call for all of them on the
	// next tick instead - also helps pollConsole()'s residual post-recall trickle (§7.2) for the same
	// reason.
	scheduleFeedbackCheck(feedbackId) {
		if (this._pendingFeedbackChecks === undefined) {
			this._pendingFeedbackChecks = new Set()
		}
		this._pendingFeedbackChecks.add(feedbackId)
		if (this._feedbackCheckTimer === undefined) {
			this._feedbackCheckTimer = setTimeout(() => {
				this._feedbackCheckTimer = undefined
				const ids = [...this._pendingFeedbackChecks]
				this._pendingFeedbackChecks.clear()
				if (ids.length > 0) this.checkFeedbacks(...ids)
			}, 0)
		}
	}

	// §7.6: batches setVariableValues() calls and debounces setVariableDefinitions() rebuilds - see
	// variables.js's fbCreatesVar, the auto-created-variable path upstream #64 ("plugin restarts when
	// a lot of data comes in") was hitting. Not used for every setVariableValues() call in the module
	// - a couple of call sites read a variable's current value back synchronously to update it (e.g.
	// the cued-channels arrays in variables.js's setVar), and deferring those would risk two updates
	// in the same tick reading stale data and clobbering each other.
	queueVariableValue(name, value) {
		if (this._pendingVariableValues === undefined) {
			this._pendingVariableValues = {}
		}
		this._pendingVariableValues[name] = value
		this._scheduleVariableFlush()
	}

	// Register a newly auto-created variable's definition, without triggering an immediate rebuild.
	queueNewVariable(varToAdd) {
		this.variables.push(varToAdd)
		this._variableDefinitionsDirty = true
		this._scheduleVariableFlush()
	}

	_scheduleVariableFlush() {
		if (this._variableFlushTimer !== undefined) return
		this._variableFlushTimer = setTimeout(() => {
			this._variableFlushTimer = undefined
			if (this._variableDefinitionsDirty) {
				this._variableDefinitionsDirty = false
				paramFuncs.setVariableDefinitions(this)
			}
			if (this._pendingVariableValues !== undefined && Object.keys(this._pendingVariableValues).length > 0) {
				const values = this._pendingVariableValues
				this._pendingVariableValues = {}
				this.setVariableValues(values)
			}
		}, 0)
	}

	// Get a value from the dataStore. If the value doesn't exist, send a request to get it.
	getFromDataStore(cmd) {
		let data = undefined
		if (cmd == undefined) return data

		if (cmd.Address !== undefined) {
			if (
				this.dataStore[cmd.Address] !== undefined &&
				this.dataStore[cmd.Address][cmd.X] !== undefined &&
				this.dataStore[cmd.Address][cmd.X][cmd.Y] !== undefined
			) {
				data = this.dataStore[cmd.Address][cmd.X][cmd.Y]
				return data
			}
			let rcpCmd = paramFuncs.findRcpCmd(this, cmd.Address)
			if (rcpCmd !== undefined && rcpCmd.RW.includes('r')) {
				cmd.prefix = 'get'
				this.addToCmdQueue(cmd)
			}
		}

		return data
	}

	// Start requesting meter data
	startMeters() {
		let mtrFeedbacks = this.rcpCommands.filter((f) => f.Type == 'mtr')
		mtrFeedbacks.forEach((rcpCmd) => {
			let pickoffCount = rcpCmd.Pickoff ? rcpCmd.Pickoff.split('|').length : 1
			for (let y = 0; y < pickoffCount; y++) {
				let cmdToSend = { Address: rcpCmd.Address, X: 0, Y: y, prefix: 'get' }
				this.addToCmdQueue(cmdToSend)
			}
		})
	}
}

// Companion module API 2.0 removed runEntrypoint() in favour of a plain default export, plus a
// separately named UpgradeScripts export - see PLAN.md section 9 Phase 1 for how this was verified.
export default instance
export { upgrade as UpgradeScripts }
