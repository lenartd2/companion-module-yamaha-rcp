import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	ignores: ['tools/probes/**'],
})

export default [
	...baseConfig,
	{
		// index.js is CommonJS (require/module.exports) throughout, except for the ESM
		// `export default`/`export {}` pair at the bottom that the module API 2.1 entrypoint
		// contract requires (see PLAN.md Phase 1 addendum) - sourceType: 'module' lets the parser
		// accept that without erroring, and doesn't affect how require() calls are treated.
		languageOptions: {
			sourceType: 'module',
		},
	},
	{
		// tools/rcp-probe.js is a standalone CLI diagnostic script (run directly via `node
		// tools/rcp-probe.js ...`, never imported by the module), not application code - a clean
		// process.exit(1) on a bad argument or connection failure is the normal, correct behaviour
		// for a CLI tool, not the accidental-process-kill this rule is meant to catch. The base
		// config already carves out the same exemption for examples/**/*.js.
		files: ['tools/**/*.js'],
		rules: {
			'n/no-process-exit': 'off',
		},
	},
]
