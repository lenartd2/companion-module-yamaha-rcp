const paramFuncs = require('./paramFuncs')

const updateCurrentScene = (instance, sceneKey) => {
	if (
		instance.config.cancelFadesOnSceneRecall !== false &&
		instance.currentSceneKey !== undefined &&
		instance.currentSceneKey != sceneKey
	) {
		paramFuncs.cancelAllFades(instance)
	}
	instance.currentSceneKey = sceneKey
	instance.checkFeedbacks('CurrentScene')
}

const formatSceneNumber = (rcpCmd, sceneNumber) => {
	if (rcpCmd?.Type == 'string') return `${sceneNumber}.00`
	return sceneNumber
}

const getSceneAddress = (instance, bank) => {
	if (['TF', 'DM3', 'DM7'].includes(instance.config.model)) return `scene_${bank == 1 ? 'a' : 'b'}`
	return 'MIXER:Lib/Scene'
}

const requestSceneNames = (instance) => {
	const sceneRecallCmd = instance.rcpCommands.find((cmd) => cmd.Index == 1000 && cmd.RW.includes('w'))
	if (!sceneRecallCmd) return

	const sceneCount = Math.min(Math.max(parseInt(sceneRecallCmd.Max) || 1, 1), 99)
	const bankCount = Math.max(parseInt(sceneRecallCmd.Y) || 1, 1)
	for (let bank = 1; bank <= bankCount; bank++) {
		const sceneAddress = getSceneAddress(instance, bank)
		for (let sceneNumber = 1; sceneNumber <= sceneCount; sceneNumber++) {
			const formattedSceneNumber = formatSceneNumber(sceneRecallCmd, sceneNumber)
			if (sceneRecallCmd.Type == 'string') {
				const quotedSceneNumber = instance.config.model == 'PM' ? `"${formattedSceneNumber}"` : formattedSceneNumber
				instance.sendCmd(`ssinfot_ex ${sceneAddress} ${quotedSceneNumber}`)
			} else {
				instance.sendCmd(`ssinfo_ex ${sceneAddress} ${formattedSceneNumber}`)
			}
		}
	}
}

const updateSceneName = (instance, msg) => {
	const sceneNumbers = [...new Set([msg.Val, msg.TxtVal].filter((value) => value !== undefined && value !== ''))]
	const values = {}
	for (const sceneNumber of sceneNumbers) {
		values[paramFuncs.getSceneNameVariableName(msg.Address, sceneNumber)] = msg.ScnName || ''
	}
	instance.setVariableValues(values)
	return sceneNumbers.map((sceneNumber) => `${msg.Address}:${sceneNumber}`)
}

module.exports = {
	initVars: (instance) => {
		instance.variables = [
			{ variableId: 'modelName', name: 'Device Model Name' },
			{ variableId: 'deviceName', name: 'Device Label' },
			{ variableId: 'runMode', name: 'Device Run Mode' },
		]
		if (!['TF', 'DM3', 'DM7'].includes(instance.config.model)) {
			instance.variables.push({ variableId: 'error', name: 'Device Status' })
		}

		if (instance.config.model.slice(-2) != 'IO') {
			// Not TIO, RIO or RSio
			instance.variables.push(
				{ variableId: 'curScene', name: 'Current Scene Number' },
				{ variableId: 'curSceneName', name: 'Current Scene Name' },
				{ variableId: 'curSceneComment', name: 'Current Scene Comment' },
			)

			switch (instance.config.model) {
				case 'CL/QL':
					{
						instance.variables.push(
							{ variableId: 'cuedInChannels', name: 'Inputs Cued' },
							{ variableId: 'cuedStInChannels', name: 'Stereo Inputs Cued' },
							{ variableId: 'cuedMixes', name: 'Mixes Cued' },
							{ variableId: 'cuedMatrices', name: 'Matrices Cued' },
							{ variableId: 'cuedDCAs', name: 'DCAs Cued' },
						)
					}
					break

				case 'DM3':
					{
						instance.variables.push(
							{ variableId: 'cuedStInChannels', name: 'Stereo Inputs Cued' },
							{ variableId: 'cuedInChannels', name: 'Inputs Cued' },
							{ variableId: 'cuedMixes', name: 'Mixes Cued' },
							{ variableId: 'cuedMatrices', name: 'Matrices Cued' },
						)
					}
					break

				case 'PM': {
					instance.variables.push(
						{ variableId: 'cuedInChannels', name: 'Inputs Cued' },
						{ variableId: 'cuedMixes', name: 'Mixes Cued' },
						{ variableId: 'cuedMatrices', name: 'Matrices Cued' },
						{ variableId: 'cuedDCAs', name: 'DCAs Cued' },
					)
				}
			}
		}

		paramFuncs.setVariableDefinitions(instance)
		instance.setVariableValues({
			cuedStInChannels: '[]',
			cuedInChannels: '[]',
			cuedMixes: '[]',
			cuedMatrices: '[]',
			cuedDCAs: '[]',
		})
	},

	// Get info from a connected console
	getVars: (instance) => {
		instance.sendCmd('devinfo productname') // Request Device Model
		instance.sendCmd('devinfo devicename') // Request Device Label
		instance.sendCmd('devstatus runmode') // Request Run Mode
		if (!['TF', 'DM3', 'DM7'].includes(instance.config.model)) instance.sendCmd('devstatus error') // Request error status

		switch (instance.config.model) {
			case 'CL/QL': {
				instance.sendCmd('sscurrent_ex MIXER:Lib/Scene') // Request Current Scene Number
				break
			}
			case 'TF':
			case 'DM3': {
				instance.sendCmd('sscurrent_ex scene_a') // TF uses 2 "banks", with no way to determine which is active
				instance.sendCmd('sscurrent_ex scene_b') // except when asking for the opposite back, you'll get an error
				break
			}
			case 'PM': {
				instance.sendCmd(`scpmode sstype "text"`) // Scene numbers are text on Rivage
				instance.sendCmd('sscurrentt_ex MIXER:Lib/Scene')
				break
			}
			case 'DM7': {
				instance.sendCmd(`scpmode sstype "text"`) // Scene numbers are text on DM7
				instance.sendCmd('sscurrentt_ex scene_a')
				instance.sendCmd('sscurrentt_ex scene_b')
			}
		}
		requestSceneNames(instance)
	},

	// Auto-populate a variable for every strip's name/level/on-state, for every fader-level channel
	// on the console, without needing a feedback with "Auto-Create Variable" manually placed on a
	// button first (Phase 5 P1, PLAN.md §9). Reuses createAction/createPresets' own
	// isFaderLevel+RW('w') channel enumeration for consistency with what already gets fader-control
	// UI. Builds instance._channelVariableAddresses, a plain address set index.js's addToDataStore
	// consults on every value change so these variables keep updating live for free - the same
	// mechanism a real Auto-Create Variable feedback uses (fbCreatesVar), just triggered without
	// requiring any button to exist.
	requestChannelVariables: (instance) => {
		instance._channelVariableAddresses = new Set()
		const faderCmds = instance.rcpCommands.filter((c) => paramFuncs.isFaderLevel(c) && c.RW.includes('w'))
		for (const levelCmd of faderCmds) {
			const nameCmd = instance.rcpCommands.find(
				(cmd) => cmd.Address == levelCmd.Address.replace('/Fader/Level', '/Label/Name') && cmd.RW.includes('r'),
			)
			const onCmd = instance.rcpCommands.find(
				(cmd) => cmd.Address == levelCmd.Address.replace('/Fader/Level', '/Fader/On') && cmd.RW.includes('r'),
			)
			const xCount = Math.max(parseInt(levelCmd.X) || 1, 1)
			// Only ever request Y=0 here, even for a row whose table declares Y>1 (Fx says 2, e.g.) -
			// confirmed live that Fx's Y=1 is InvalidArgument despite the table's own claim, so its
			// real Y semantics aren't what X/Y addressing normally means elsewhere. Y=0 is always
			// valid; anything a row might have beyond that is out of scope for this feature.
			for (const cmd of [levelCmd, nameCmd, onCmd]) {
				if (cmd === undefined) continue
				instance._channelVariableAddresses.add(cmd.Address)
				for (let x = 1; x <= xCount; x++) {
					instance.addToCmdQueue({ Address: cmd.Address, X: x - 1, Y: 0, prefix: 'get' })
				}
			}
		}
	},

	setVar: (instance, msg) => {
		switch (msg.Action) {
			case 'devinfo': {
				switch (msg.Address) {
					case 'productname':
						if (instance.getVariableValue('modelName') == '') {
							instance.log('info', `Device Model is ${msg.Val}`)
						}
						instance.setVariableValues({ modelName: msg.Val })
						break
					case 'devicename':
						instance.setVariableValues({ deviceName: msg.Val })
						break
				}
				break
			}
			case 'devstatus': {
				switch (msg.Address) {
					case 'runmode':
						instance.setVariableValues({ runMode: msg.Val })
						break
					case 'error':
						instance.setVariableValues({ error: msg.Val })
						break
				}
				break
			}
			case 'ssrecall_ex':
				break
			case 'sscurrent_ex':
				// Request Current Scene Info once we know what scene we have
				if (instance.config.model == 'TF' || instance.config.model == 'DM3') {
					updateCurrentScene(instance, `${msg.Address}:${msg.Val}`)
					instance.setVariableValues({
						curScene: `${msg.Address.toUpperCase().slice(-1)}${msg.Val.toString().padStart(2, '0')}`,
					})
					instance.sendCmd(`ssinfo_ex ${msg.Address} ${msg.Val}`)
				} else {
					updateCurrentScene(instance, `${msg.Address}:${msg.Val}`)
					instance.setVariableValues({ curScene: msg.Val })
					instance.sendCmd(`ssinfo_ex MIXER:Lib/Scene ${msg.Val}`)
				}
				break
			case 'sscurrentt_ex':
				updateCurrentScene(instance, `${msg.Address}:${msg.Val}`)
				instance.setVariableValues({ curScene: msg.Val })
				// Request Current Scene Info once we know what scene we have
				switch (instance.config.model) {
					case 'PM':
						instance.sendCmd(`ssinfot_ex MIXER:Lib/Scene "${msg.Val}"`)
						break
					case 'DM3':
					case 'DM7':
						instance.sendCmd(`ssinfot_ex ${msg.Address} ${msg.Val}`)
				}
				break
			case 'ssinfo_ex':
			case 'ssinfot_ex': {
				const sceneKeys = updateSceneName(instance, msg)
				if (sceneKeys.includes(instance.currentSceneKey)) {
					instance.setVariableValues({ curSceneName: msg.ScnName })
					instance.setVariableValues({ curSceneComment: msg.ScnComment })
				}
				break
			}
			default: {
				// A malformed/truncated line (e.g. one split mid-line across two TCP chunks - see the
				// receive handler in index.js) could reach here with no Address at all. Every case
				// below expects one; bail rather than crash the connection over a single bad line.
				if (msg.Address === undefined) return
				let cmdName = msg.Address.slice(msg.Address.indexOf('/') + 1) // String after "MIXER:Current/"
				let varName

				switch (cmdName) {
					case 'Cue/InCh/On':
						varName = 'cuedInChannels'
						break
					case 'Cue/StInCh/On':
						varName = 'cuedStInChannels'
						break
					case 'Cue/Mix/On':
						varName = 'cuedMixes'
						break
					case 'Cue/Mtrx/On':
						varName = 'cuedMatrices'
						break
					case 'Cue/DCA/On':
						varName = 'cuedDCAs'
						break
					default:
						return
				}

				let ch = JSON.parse(instance.getVariableValue(varName) || '[]')
				let XBase1 = parseInt(msg.X) + 1 // Actual channel/Mix/DCA numbers starting at 1
				let chIdx = ch.indexOf(XBase1)
				if (msg.Val == 1) {
					if (chIdx == -1) {
						ch.push(XBase1)
					}
				} else {
					if (chIdx > -1) {
						ch.splice(chIdx, 1) || []
					}
				}
				let varN = {}
				varN[varName] = JSON.stringify(ch)
				instance.setVariableValues(varN)
			}
		}
	},

	fbCreatesVar: (instance, cmd, data, context) => {
		const wtMtrTable = require('./wtMtrTable.json')
		const paramFuncs = require('./paramFuncs.js')
		let rcpCmd = paramFuncs.findRcpCmd(instance, cmd.Address)

		if (rcpCmd.Type == 'mtr') {
			if (instance.config.model == 'DM7') {
				data = Math.round(wtMtrTable[data])
			} else {
				data = data - 126
			}
			if (rcpCmd.Pickoff && cmd.Y > 0) {
				cmd.Y = rcpCmd.Pickoff.split('|')[cmd.Y - 1] || undefined
			}
		}

		if (rcpCmd.Type == 'integer' || rcpCmd.Type == 'freq') {
			data = data == -32768 ? '-Inf' : data / rcpCmd.Scale
		}

		if (cmd.createVariable) {
			// Auto-create a variable

			let varName = paramFuncs.getAutoVariableName(rcpCmd, cmd.X, cmd.Y)

			let varToAdd = { variableId: varName, name: 'Auto-Created Variable' }
			let varIndex = instance.variables.findIndex((i) => i.variableId === varToAdd.variableId)

			// Add new Auto-created variable and value. §7.6: a metering frame (or a scene recall) can
			// discover many of these in one burst - each used to trigger its own full
			// setVariableDefinitions() rebuild and its own setVariableValues() call (this is what
			// upstream #64, "plugin restarts when a lot of data comes in", was hitting on a QL5 full
			// of auto-created DCA level variables). Both are now coalesced into at most one call each
			// per tick via the instance's queueNewVariable()/queueVariableValue().
			if (varIndex == -1) {
				instance.queueNewVariable(varToAdd)
			}
			instance.queueVariableValue(varName, data)
		} else {
			const reg = /^@\(custom:([^)$]+)\)/
			let hasCustomVar = reg.exec(cmd.Val)
			if (hasCustomVar) {
				// Set a custom variable value using @ syntax.
				// Companion's module API only exposes this write from an action's context, not a
				// feedback's, as of API 2.0 - there is no replacement for the feedback case.
				if (context && typeof context.setCustomVariableValue === 'function') {
					context.setCustomVariableValue(hasCustomVar[1], data)
				} else if (!instance._loggedCustomVarFeedbackWarning) {
					instance._loggedCustomVarFeedbackWarning = true
					instance.log(
						'warn',
						'A feedback uses "@(custom:...)" in its Val option to write a custom variable. Companion no longer allows feedbacks to write custom variables (only actions can); this value will not be written.',
					)
				}
			}
		}
	},
}
