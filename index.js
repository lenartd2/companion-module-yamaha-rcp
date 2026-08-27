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
const DEFAULT_FADE_STEP_INTERVAL = 40
const CLQL_DEFAULT_METER_SPEED = 80

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
		this.fadeTimers = {}
		this.fadeQueue = []
		this.currentSceneKey = undefined
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
		for (const fade of Object.values(this.fadeTimers || {})) {
			clearTimeout(fade?.timer)
		}
		this.fadeQueue = []
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
				tooltip:
					'For RIVAGE PM systems, use the DSP ENGINE IP SETTING address from SETUP > NETWORK > FOR MIXER CONTROL, not necessarily the CONSOLE IP SETTING address. The DSP ENGINE IP SETTING must be enabled on the console.',
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
				id: 'cancelFadesOnSceneRecall',
				label: 'Cancel fades on scene recall?',
				tooltip:
					'Recalling a scene from the console surface while Companion fades are running can cause the console and Companion to fight over fader values. Keep this enabled to cancel active and queued fades when the module detects a scene change.',
				width: 4,
				default: true,
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
				type: 'number',
				id: 'maxConcurrentFades',
				label: 'Maximum concurrent fades',
				tooltip:
					'More simultaneous fades create more RCP traffic. Recalling a scene from the console surface during active fades is an edge case that can cause unexpected fader movement, so keep this conservative.',
				width: 4,
				default: 6,
				min: 1,
				max: 32,
			},
			{
				type: 'dropdown',
				id: 'fadeLimitMode',
				label: 'When maximum concurrent fades exceeded',
				tooltip:
					'Controls what happens when too many fades are active. Recalling a scene from the console surface during active fades is an edge case that can cause unexpected fader movement.',
				width: 4,
				default: 'queue',
				choices: [
					{ id: 'cancel', label: 'Cancel new fade' },
					{ id: 'queue', label: 'Queue new fade' },
					{ id: 'rateLimit', label: 'Rate limit fades' },
				],
				minChoicesForSearch: 0,
			},
			{
				type: 'number',
				id: 'fadeStepInterval',
				label: 'Fade step interval (ms)',
				tooltip:
					'Lower values send more frequent level updates. Recalling a scene from the console surface during active fades is an edge case that can cause unexpected fader movement, so keep this conservative.',
				width: 4,
				default: DEFAULT_FADE_STEP_INTERVAL,
				min: 10,
				max: 500,
			},
			{
				type: 'checkbox',
				id: 'metering',
				label: 'Enable Metering?',
				tooltip:
					'Metering adds ongoing polling traffic. Large systems can feel slower when many live preset buttons are visible because Companion requests feedback data for displayed buttons.',
				width: 3,
				default: false,
			},
			{
				type: 'number',
				id: 'meterSpeed',
				label: 'Metering interval (40 - 1000 ms)',
				tooltip:
					'Lower values increase polling traffic. On larger systems, keep this conservative, especially when using preset pages with many dynamic labels, meters, or feedbacks visible.',
				width: 8,
				default: CLQL_DEFAULT_METER_SPEED,
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
				this.queueTimer = {}
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
					receiveBuffer = receivedLines[receivedLines.length - 1] // Broken line, leave it for next time...
					receivedLines.splice(receivedLines.length - 1) // Remove it.
				} else {
					receiveBuffer = ''
				}

				for (let line of receivedLines) {
					if (line.length == 0) {
						continue
					}
					this.log('debug', `[${new Date().toJSON()}] Received: '${line}'`)
					receivedCmds = paramFuncs.parseData(line) // Break out the parameters

					for (let i = 0; i < receivedCmds.length; i++) {
						let curCmd = JSON.parse(JSON.stringify(receivedCmds[i])) // deep clone
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
		clearTimeout(this.queueTimer)
		let cmdToAdd = JSON.parse(JSON.stringify(cmd)) // Deep Clone
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

		if (this.queueTimer) {
			this.queueTimer = setTimeout(() => {
				this.processCmdQueue()
			}, MSG_DELAY)
		}
	}

	// When a message comes in from the console, match it up and delete it, and send the next message
	processCmdQueue(cmd) {
		clearTimeout(this.queueTimer)
		if (this.cmdQueue == undefined || this.cmdQueue.length == 0) return
		if (cmd != undefined) {
			let i = this.cmdQueue.findIndex(
				(c) => c.prefix == 'get' && c.Address == cmd.Address && c.X == cmd.X && c.Y == cmd.Y,
			)
			if (i > -1) {
				this.cmdQueue.splice(i, 1) // Got value from matching request so remove it!
			}
		}

		if (this.cmdQueue.length > 0) {
			// Messages still to send?
			let nextCmd = this.cmdQueue[0] // Oldest

			if (nextCmd.prefix == 'set') {
				let nextCmdVal = paramFuncs.parseVal(this, nextCmd)
				if (nextCmdVal == undefined) {
					this.cmdQueue.shift()
					this.cmdQueue.push(nextCmd)

					this.queueTimer = setTimeout(() => {
						this.processCmdQueue()
					}, MSG_DELAY)

					return
				}
				nextCmd.Val = nextCmdVal
			}

			let msg = paramFuncs.fmtCmd(this, nextCmd)
			if (this.sendCmd(msg)) {
				if (nextCmd.prefix == 'set') {
					this.addToDataStore(nextCmd) // Update to latest value
				}
			}

			this.cmdQueue.shift() // Get rid of message, whether sent or not
			this.queueTimer = setTimeout(() => {
				this.processCmdQueue()
			}, MSG_DELAY)
		}
	}

	// Create the preset definitions
	createPresets() {
		var meterCmds = this.rcpCommands
			.filter((c) => c.Action == 'mtrinfo')
			.sort((a, b) => (a.Index == b.Index ? 0 : a.Index > b.Index ? 1 : -1))
		this.rcpPresets = []
		const faderMeterNames = {
			InCh: 'InCh',
			StInCh: 'StInCh',
			FxRtnCh: 'FxRtnCh',
			Mix: 'Mix',
			Mtrx: 'Mtrx',
			St: 'St',
			Mono: 'Mono',
		}
		const getMeterInfo = (faderName, x) => {
			let meterName = faderMeterNames[faderName]
			if (!meterName) return undefined

			const meterCmd = meterCmds.find((c) => c.Address.endsWith(`/Meter/${meterName}`))
			if (meterCmd === undefined) return undefined

			const pickoffs = meterCmd.Pickoff?.split('|')
			const pickoffIndex = pickoffs ? (meterCmd.Index < 2100 ? 1 : parseInt(meterCmd.Y) || 1) : 1
			const pickoff = pickoffs?.[pickoffIndex - 1]

			return {
				feedbackId: meterCmd.Address.replace(/:/g, '_'),
				options: {
					X: x,
					Y: pickoffIndex,
					Val: 0,
					createVariable: true,
				},
				variable: `$(${this.label}:V_Meter_${meterName}_${x}${pickoff ? `_${pickoff}` : ''})`,
			}
		}
		const getFaderVariable = (rcpCmd, x, y) => {
			return `$(${this.label}:${paramFuncs.getIndexedVariableName(rcpCmd, x - 1, y - 1)})`
		}
		const getLabelNameInfo = (rcpCmd, x, y) => {
			const labelNameCmd = this.rcpCommands.find(
				(cmd) => cmd.Address == rcpCmd.Address.replace('/Fader/Level', '/Label/Name') && cmd.RW.includes('r'),
			)
			if (!labelNameCmd) return undefined

			return {
				feedbackId: labelNameCmd.Address.replace(/:/g, '_'),
				options: {
					X: x,
					Y: y,
					Val: '',
					createVariable: true,
				},
				variable: `$(${this.label}:${paramFuncs.getIndexedVariableName(labelNameCmd, x - 1, y - 1)})`,
			}
		}
		const getCueInfo = (faderName, x) => {
			const cueCmd = this.rcpCommands.find(
				(cmd) => cmd.Address == `MIXER:Current/Cue/${faderName}/On` && cmd.RW.includes('w'),
			)
			if (!cueCmd) return undefined

			return {
				actionId: cueCmd.Address.replace(/:/g, '_'),
				options: {
					X: x,
					Y: 1,
					Val: 'Toggle',
				},
				feedbackOptions: {
					X: x,
					Y: 1,
					Val: 1,
					createVariable: true,
				},
			}
		}
		const getFaderLabel = (faderName, x, y, yCount) => {
			if (faderName == 'St') return `ST ${x}`
			if (faderName == 'Mtrx') return `MTRX ${x}`
			if (faderName == 'FxRtnCh') return `FX RTN ${x}`
			if (faderName == 'StInCh') return `ST IN ${x}`
			if (faderName == 'InCh') return `CH ${x}`
			if (faderName == 'Fx') return yCount > 1 ? `FX ${x}-${y}` : `FX ${x}`
			return `${faderName} ${x}`
		}
		const getFaderSortRank = (rcpCmd) => {
			const faderName = rcpCmd.Address.split('/').at(-3)
			const monoBeforeStereoOrder = {
				InCh: 10,
				Mono: 20,
				Mix: 30,
				Mtrx: 40,
				DCA: 50,
				StInCh: 60,
				FxRtnCh: 70,
				St: 80,
			}
			return monoBeforeStereoOrder[faderName] ?? 100
		}
		const faderCmds = this.rcpCommands
			.filter((c) => paramFuncs.isFaderLevel(c) && c.RW.includes('w'))
			.sort((a, b) => {
				const rankA = getFaderSortRank(a)
				const rankB = getFaderSortRank(b)
				if (rankA != rankB) return rankA - rankB
				return a.Index == b.Index ? 0 : a.Index > b.Index ? 1 : -1
			})
		const getFaderOnInfo = (rcpCmd, x, y) => {
			const faderOnCmd = this.rcpCommands.find(
				(cmd) => cmd.Address == rcpCmd.Address.replace('/Fader/Level', '/Fader/On') && cmd.RW.includes('w'),
			)
			if (!faderOnCmd) return undefined

			const actionId = faderOnCmd.Address.replace(/:/g, '_')
			return {
				actionId,
				toggleOptions: {
					X: x,
					Y: y,
					Val: 'Toggle',
				},
				onOptions: {
					X: x,
					Y: y,
					Val: 1,
				},
				offOptions: {
					X: x,
					Y: y,
					Val: 0,
				},
				feedback: {
					feedbackId: actionId,
					options: {
						X: x,
						Y: y,
						Val: 1,
						createVariable: true,
					},
					style: {
						bgcolor: combineRgb(204, 101, 0),
					},
				},
			}
		}
		const getFaderSelectInfo = (rcpCmd, x, y) => {
			const selectAddresses = [
				rcpCmd.Address.replace('/Fader/Level', '/Fader/Select'),
				rcpCmd.Address.replace('/Fader/Level', '/Select'),
				rcpCmd.Address.replace('/Fader/Level', '/PatchSelect'),
			]
			const faderSelectCmd = this.rcpCommands.find(
				(cmd) => selectAddresses.includes(cmd.Address) && cmd.RW.includes('w'),
			)
			if (!faderSelectCmd) return undefined

			const actionId = faderSelectCmd.Address.replace(/:/g, '_')
			return {
				actionId,
				options: {
					X: x,
					Y: y,
					Val: 1,
				},
				feedback: faderSelectCmd.RW.includes('r')
					? {
							feedbackId: actionId,
							options: {
								X: x,
								Y: y,
								Val: 1,
								createVariable: true,
							},
							style: {
								bgcolor: combineRgb(0, 153, 0),
							},
						}
					: undefined,
			}
		}
		const sceneRecallCmd = this.rcpCommands.find((c) => c.Index == 1000 && c.RW.includes('w'))
		const sceneRecallIncCmd = this.rcpCommands.find((c) => c.Index == 1010 && c.RW.includes('w'))
		const sceneRecallDecCmd = this.rcpCommands.find((c) => c.Index == 1011 && c.RW.includes('w'))
		const formatSceneNumber = (rcpCmd, sceneNumber) => {
			if (rcpCmd.Type == 'string') return `${sceneNumber}.00`
			return sceneNumber
		}
		const getSceneCurrentAddress = (bank) => {
			if (['TF', 'DM3', 'DM7'].includes(this.config.model)) return `scene_${bank == 1 ? 'a' : 'b'}`
			return 'MIXER:Lib/Scene'
		}
		const getSceneBankLabel = (bank) => (bank == 1 ? 'A' : 'B')
		const getSceneNameVariable = (address, sceneNumber) =>
			`$(${this.label}:${paramFuncs.getSceneNameVariableName(address, sceneNumber)})`
		const addSceneNameVariable = (address, sceneNumber, sceneText) => {
			const variableId = paramFuncs.getSceneNameVariableName(address, sceneNumber)
			if (!this.variables.find((variable) => variable.variableId == variableId)) {
				this.variables.push({ variableId, name: `Scene ${sceneText} Name` })
			}
		}
		const addCurrentScenePreset = () => {
			this.rcpPresets.push({
				type: 'button',
				category: 'Scene Recall Buttons',
				name: 'Current Scene',
				style: {
					text: `SCENE\\n$(this:curScene)\\n$(this:curSceneName)`,
					size: 'auto',
					show_topbar: false,
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 51),
				},
				steps: [],
				feedbacks: [],
			})
		}
		const addSceneRecallPreset = (rcpCmd, sceneNumber, bank) => {
			const actionId = rcpCmd.Address.replace(/:/g, '_')
			const hasBanks = parseInt(rcpCmd.Y) > 1
			const sceneText = hasBanks ? `${getSceneBankLabel(bank)} ${sceneNumber}` : `${sceneNumber}`
			const formattedSceneNumber = formatSceneNumber(rcpCmd, sceneNumber)
			const sceneAddress = getSceneCurrentAddress(bank)
			addSceneNameVariable(sceneAddress, formattedSceneNumber, sceneText)
			this.rcpPresets.push({
				type: 'button',
				category: 'Scene Recall Buttons',
				name: `Recall Scene ${sceneText}`,
				style: {
					text: `Recall\\nScene\\n${sceneText}\\n${getSceneNameVariable(sceneAddress, formattedSceneNumber)}`,
					size: 'auto',
					show_topbar: false,
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 51),
				},
				steps: [
					{
						down: [
							{
								actionId,
								options: {
									X: 1,
									Y: bank,
									Val: formattedSceneNumber,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'CurrentScene',
						options: {
							sceneKey: `${sceneAddress}:${formattedSceneNumber}`,
						},
						style: {
							bgcolor: combineRgb(0, 0, 153),
						},
					},
				],
			})
		}
		const addSceneStepPreset = (rcpCmd, direction) => {
			const actionId = rcpCmd.Address.replace(/:/g, '_')
			this.rcpPresets.push({
				type: 'button',
				category: 'Scene Recall Buttons',
				name: `Recall ${direction} Scene`,
				style: {
					text: `RECALL\\n${direction}\\nScene`,
					size: 14,
					show_topbar: false,
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 51),
				},
				steps: [
					{
						down: [
							{
								actionId,
								options: {
									X: 1,
									Y: 1,
									Val: '',
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			})
		}
		if (sceneRecallCmd) addCurrentScenePreset()
		if (sceneRecallDecCmd) addSceneStepPreset(sceneRecallDecCmd, 'Previous')
		if (sceneRecallIncCmd) addSceneStepPreset(sceneRecallIncCmd, 'Next')
		if (sceneRecallCmd) {
			const sceneCount = Math.min(Math.max(parseInt(sceneRecallCmd.Max) || 1, 1), 99)
			const bankCount = Math.max(parseInt(sceneRecallCmd.Y) || 1, 1)
			for (let bank = 1; bank <= bankCount; bank++) {
				for (let sceneNumber = 1; sceneNumber <= sceneCount; sceneNumber++) {
					addSceneRecallPreset(sceneRecallCmd, sceneNumber, bank)
				}
			}
			paramFuncs.setVariableDefinitions(this)
		}
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
			// console.log(c)
			var addrParts = c.Address.split('/')
			var cmdName = addrParts.length > 1 ? addrParts[2] : ''
			var pickoffIndex = c.Index < 2100 ? 1 : c.Y
			var pickoffName = ''
			if (c.Pickoff) {
				cmdName = addrParts.length > 0 ? addrParts[addrParts.length - 1] : ''
				var pickoffParts = c.Pickoff.split('|')
				pickoffName = `_${pickoffParts[pickoffIndex - 1]}`
			}
			if (cmdName) {
				curPreset.name = `Meter Level Indicator - ${cmdName}`
				curPreset.style.text = `${cmdName}\\nMeter\\n`
				curPreset.feedbacks[0].options.meterVal1 = `$(${this.label}:V_Meter_${cmdName}_1${pickoffName})`
				curPreset.feedbacks[1].feedbackId = c.Address.replace(/:/g, '_')
				curPreset.feedbacks[1].options.Y = pickoffIndex
				if (cmdName == 'St' || cmdName == 'StInCh' || cmdName == 'FxRtnCh') {
					// Make a Stereo Meter
					curPreset.feedbacks[0].options.meterVal2 = `$(${this.label}:V_Meter_${cmdName}_2${pickoffName})`
					curPreset.feedbacks.push(JSON.parse(JSON.stringify(curPreset.feedbacks[1])))
					curPreset.feedbacks[2].options.X = 2 // Right channel
				}
				this.rcpPresets.push(curPreset)
			}
		}

		for (const c of faderCmds) {
			const faderName = c.Address.split('/').at(-3)
			const xCount = Math.max(parseInt(c.X) || 1, 1)
			const yCount = Math.max(parseInt(c.Y) || 1, 1)
			const actionId = c.Address.replace(/:/g, '_')

			for (let x = 1; x <= xCount; x++) {
				for (let y = 1; y <= yCount; y++) {
					const label = getFaderLabel(faderName, x, y, yCount)
					const faderVariable = getFaderVariable(c, x, y)
					const labelNameInfo = getLabelNameInfo(c, x, y)
					const meterInfo = getMeterInfo(faderName, x)
					const faderButtonText = `${label}\\n${labelNameInfo?.variable || ''}\\n${faderVariable} dB\\n`
					const onOffButtonText = `${label}\\n${labelNameInfo?.variable || ''}\\nON/OFF`
					const faderOnInfo = getFaderOnInfo(c, x, y)
					const faderSelectInfo = getFaderSelectInfo(c, x, y)
					const cueInfo = getCueInfo(faderName, x)
					const cueButtonText = `CUE\\n${label}\\n${labelNameInfo?.variable || ''}`

					this.rcpPresets.push({
						type: 'button',
						category: 'Fader Control Buttons (Fade -inf / 0db)',
						name: faderButtonText,
						style: {
							text: faderButtonText,
							size: 14,
							show_topbar: false,
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(0, 0, 0),
						},
						steps: [
							{
								down: [
									{
										actionId,
										options: {
											X: x,
											Y: y,
											Val: 0,
											Fade: '1',
											Rel: false,
										},
									},
								],
								up: [],
							},
							{
								down: [
									{
										actionId,
										options: {
											X: x,
											Y: y,
											Val: '-Inf',
											Fade: '1',
											Rel: false,
										},
									},
								],
								up: [],
							},
						],
						feedbacks: [
							{
								feedbackId: actionId,
								options: {
									X: x,
									Y: y,
									Val: 0,
									createVariable: true,
								},
							},
							{
								feedbackId: 'LevelMeter',
								options: {
									position: 'bottom',
									padding: 1,
									level: faderVariable,
								},
							},
							...(faderOnInfo ? [faderOnInfo.feedback] : []),
							...(labelNameInfo
								? [
										{
											feedbackId: labelNameInfo.feedbackId,
											options: labelNameInfo.options,
										},
									]
								: []),
						],
					})

					if (faderOnInfo) {
						this.rcpPresets.push({
							type: 'button',
							category: 'Fader Control Buttons (ON/OFF)',
							name: `${label} on/off`,
							style: {
								text: onOffButtonText,
								size: 14,
								show_topbar: false,
								color: combineRgb(255, 255, 255),
								bgcolor: combineRgb(0, 0, 0),
							},
							steps: [
								{
									down: [
										{
											actionId: faderOnInfo.actionId,
											options: faderOnInfo.onOptions,
										},
									],
									up: [],
								},
								{
									down: [
										{
											actionId: faderOnInfo.actionId,
											options: faderOnInfo.offOptions,
										},
									],
									up: [],
								},
							],
							feedbacks: [
								faderOnInfo.feedback,
								...(labelNameInfo
									? [
											{
												feedbackId: labelNameInfo.feedbackId,
												options: labelNameInfo.options,
											},
										]
									: []),
							],
						})
					}

					if (faderSelectInfo) {
						this.rcpPresets.push({
							type: 'button',
							category: 'Fader Select Buttons',
							name: `${label} select`,
							style: {
								text: `${label}\\n${labelNameInfo?.variable || ''}\\nSELECT`,
								size: 14,
								show_topbar: false,
								color: combineRgb(255, 255, 255),
								bgcolor: combineRgb(0, 0, 0),
							},
							steps: [
								{
									down: [
										{
											actionId: faderSelectInfo.actionId,
											options: faderSelectInfo.options,
										},
									],
									up: [],
								},
							],
							feedbacks: [
								...(faderSelectInfo.feedback ? [faderSelectInfo.feedback] : []),
								...(labelNameInfo
									? [
											{
												feedbackId: labelNameInfo.feedbackId,
												options: labelNameInfo.options,
											},
										]
									: []),
							],
						})
					}

					const knobPushAction = faderOnInfo
						? [
								{
									actionId: faderOnInfo.actionId,
									options: faderOnInfo.toggleOptions,
								},
							]
						: []

					this.rcpPresets.push({
						type: 'button',
						category: 'Fader Control Knobs',
						name: `${label} fader control`,
						style: {
							text: faderButtonText,
							size: 14,
							show_topbar: false,
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(0, 0, 0),
						},
						steps: [
							{
								down: knobPushAction,
								up: [],
								rotate_left: [
									{
										actionId,
										options: {
											X: x,
											Y: y,
											Val: -1,
											Fade: '0',
											Rel: true,
										},
									},
								],
								rotate_right: [
									{
										actionId,
										options: {
											X: x,
											Y: y,
											Val: 1,
											Fade: '0',
											Rel: true,
										},
									},
								],
							},
						],
						feedbacks: [
							{
								feedbackId: actionId,
								options: {
									X: x,
									Y: y,
									Val: 0,
									createVariable: true,
								},
							},
							...(faderOnInfo ? [faderOnInfo.feedback] : []),
							...(labelNameInfo
								? [
										{
											feedbackId: labelNameInfo.feedbackId,
											options: labelNameInfo.options,
										},
									]
								: []),
							{
								feedbackId: 'LevelMeter',
								options: {
									position: 'bottom',
									padding: 1,
									level: faderVariable,
								},
							},
							...(meterInfo
								? [
										{
											feedbackId: 'Meter',
											options: {
												position: 'right',
												padding: 1,
												meterVal1: meterInfo.variable,
												meterVal2: '',
											},
										},
										{
											feedbackId: meterInfo.feedbackId,
											options: meterInfo.options,
										},
									]
								: []),
						],
					})

					if (cueInfo && y == 1) {
						this.rcpPresets.push({
							type: 'button',
							category: 'Cue Buttons',
							name: cueButtonText,
							style: {
								text: cueButtonText,
								size: 14,
								show_topbar: false,
								color: combineRgb(255, 255, 255),
								bgcolor: combineRgb(0, 0, 0),
							},
							steps: [
								{
									down: [
										{
											actionId: cueInfo.actionId,
											options: cueInfo.options,
										},
									],
									up: [],
								},
							],
							feedbacks: [
								{
									feedbackId: cueInfo.actionId,
									options: cueInfo.feedbackOptions,
									style: {
										bgcolor: combineRgb(204, 101, 0),
									},
								},
								...(labelNameInfo
									? [
											{
												feedbackId: labelNameInfo.feedbackId,
												options: labelNameInfo.options,
											},
										]
									: []),
							],
						})
					}
				}
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

			// 'Meter', 'LevelMeter' and 'CurrentScene' are hand-authored feedbacks, not derived from a
			// parameter row - findRcpCmd won't (and shouldn't) resolve them, so leave their options alone.
			const rcpCmd = paramFuncs.findRcpCmd(id)
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
			this.log(
				'debug',
				`[${new Date().toJSON()}] Sending :    '${c}' to ${this.getVariableValue('modelName')} @ ${this.config.host}`,
			)

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
		//varFuncs.getVars(this)
		this.dataStore = {}
		this.subscribeActions()
		this.checkAllFeedbacks()
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
			this.checkFeedbacks(dsAddr.replace(/:/g, '_')) // Make sure variables are updated
		}
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
