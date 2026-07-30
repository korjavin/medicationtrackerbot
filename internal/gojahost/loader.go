package gojahost

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/dop251/goja"
	domainweb "github.com/korjavin/medicationtrackerbot/web/domain"
)

// The web/domain/*.js modules are authored as ES modules: they use
// `export function`/`export const` and `import { x } from './y.js'`. goja has
// no native ESM, so this file is the production module loader — a small,
// transpile-free ESM *linker*:
//
//   1. For each module it parses the imported names (+ source module) and the
//      exported names, then removes the `import`/`export ` keywords.
//   2. It wraps each module's body in an IIFE so the module's top-level
//      `const RECORD_TYPE` / helper declarations are function-scoped and cannot
//      collide across modules (bp.js and weight.js both declare RECORD_TYPE,
//      DAY_MS, toISOString, genId, ...). This is the concrete step past the
//      spike's "strip `export ` into one flat global scope", which only worked
//      because the spike loaded a single import-free module per VM.
//   3. It emits the IIFEs in dependency (topological) order, binding each
//      import from the already-linked exports of its source module, and
//      collecting each module's exports into a global `__exports[key]` object.
//
// web/domain/*.js are NOT modified — every transform happens on the in-memory
// copy here. Documented as the C6 load caveat in docs/cloud-mode.md.

// moduleSpec describes one web/domain module and, if it exposes a domain
// factory, how to construct it over the host's injected ports.
type moduleSpec struct {
	file    string // "bp.js"
	key     string // "bp" — namespace key + import target (filename w/o .js)
	factory string // "createBPDomain"; empty for pure-function modules
	// construct is the JS that builds the domain instance over injected globals
	// (__records/__now/__timeZone and the noop __foodDb/__rxnorm/__aiClient
	// ports). Empty for pure-function modules (medschedule/tgcommand/vault),
	// whose exports are reached directly via __exports[key].
	construct string
}

// modules is the full set of web/domain modules the production host loads. The
// load order below does not matter (the linker topo-sorts by import edges); the
// construct order DOES (foodai needs the constructed food domain), and is
// enforced separately in constructOrder.
var modules = []moduleSpec{
	{file: "bp.js", key: "bp", factory: "createBPDomain",
		construct: `__exports.bp.createBPDomain({ records: __records, now: __now, timeZone: __timeZone })`},
	{file: "weight.js", key: "weight", factory: "createWeightDomain",
		construct: `__exports.weight.createWeightDomain({ records: __records, now: __now, timeZone: __timeZone })`},
	{file: "notes.js", key: "notes", factory: "createNotesDomain",
		construct: `__exports.notes.createNotesDomain({ records: __records, now: __now })`},
	{file: "settings.js", key: "settings", factory: "createSettingsDomain",
		construct: `__exports.settings.createSettingsDomain({ records: __records, now: __now, timeZone: __timeZone })`},
	{file: "vitals.js", key: "vitals", factory: "createVitalsDomain",
		construct: `__exports.vitals.createVitalsDomain({ records: __records, now: __now, timeZone: __timeZone })`},
	{file: "food.js", key: "food", factory: "createFoodDomain",
		construct: `__exports.food.createFoodDomain({ records: __records, now: __now, timeZone: __timeZone, foodDb: __foodDb })`},
	{file: "foodai.js", key: "foodai", factory: "createFoodAIDomain",
		construct: `__exports.foodai.createFoodAIDomain({ aiClient: __aiClient, foodDomain: __domains.food, now: __now })`},
	{file: "medications.js", key: "medications", factory: "createMedicationsDomain",
		construct: `__exports.medications.createMedicationsDomain({ records: __records, now: __now, timeZone: __timeZone, rxnorm: __rxnorm })`},
	{file: "medintake.js", key: "medintake", factory: "createIntakeDomain",
		construct: `__exports.medintake.createIntakeDomain({ records: __records, now: __now, timeZone: __timeZone })`},
	{file: "tzplan.js", key: "tzplan", factory: "createTzPlanDomain",
		construct: `__exports.tzplan.createTzPlanDomain({ records: __records, now: __now, timeZone: __timeZone })`},
	{file: "reminders.js", key: "reminders", factory: "createRemindersDomain",
		construct: `__exports.reminders.createRemindersDomain({ records: __records, now: __now })`},
	{file: "workout.js", key: "workout", factory: "createWorkoutDomain",
		construct: `__exports.workout.createWorkoutDomain({ records: __records, now: __now, timeZone: __timeZone })`},
	// Pure-function modules — no factory to construct; their exports are used
	// directly (medschedule.planDoses, tgcommand.parseCommand, vault.*).
	{file: "medschedule.js", key: "medschedule"},
	{file: "tgcommand.js", key: "tgcommand"},
	{file: "vault.js", key: "vault"},
}

// constructOrder is the order domains are instantiated. food precedes foodai
// because createFoodAIDomain takes the constructed food domain as a port.
var constructOrder = []string{
	"bp", "weight", "notes", "settings", "vitals",
	"food", "foodai", "medications", "medintake", "tzplan", "reminders", "workout",
}

var (
	// importRe matches `import { a, b } from './mod.js';` including multi-line
	// brace blocks ((?s) so . spans newlines; .*? so it stops at the first }).
	importRe = regexp.MustCompile(`(?s)import\s*\{(.*?)\}\s*from\s*['"]\./([\w.]+\.js)['"]\s*;?`)
	// exportDeclRe captures the identifier of each `export function|const|let|
	// var|class NAME` declaration (optionally async).
	exportDeclRe = regexp.MustCompile(`(?m)^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)`)
	// exportKwRe strips the leading `export ` keyword, leaving the declaration.
	exportKwRe = regexp.MustCompile(`(?m)^export\s+`)
)

// parsedModule is a module after import/export analysis.
type parsedModule struct {
	spec    moduleSpec
	deps    []string          // module keys this one imports from (dedup)
	imports map[string]string // imported identifier -> source module key
	exports []string          // exported identifiers, in source order
	body    string            // source with import lines removed + `export ` stripped
}

// keyOf turns an import target ("bp.js") into a module key ("bp").
func keyOf(file string) string { return strings.TrimSuffix(file, ".js") }

// parseModule reads a module from the embedded FS and analyzes its ESM surface.
func parseModule(spec moduleSpec) (parsedModule, error) {
	raw, err := domainweb.FS.ReadFile(spec.file)
	if err != nil {
		return parsedModule{}, fmt.Errorf("read embedded module %q: %w", spec.file, err)
	}
	src := string(raw)

	pm := parsedModule{spec: spec, imports: map[string]string{}}
	depSet := map[string]bool{}
	for _, m := range importRe.FindAllStringSubmatch(src, -1) {
		depKey := keyOf(m[2])
		depSet[depKey] = true
		for _, name := range strings.Split(m[1], ",") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			// Aliases (`orig as alias`) are unused in web/domain today; bind the
			// alias if one ever appears so the linker stays correct.
			if parts := strings.SplitN(name, " as ", 2); len(parts) == 2 {
				pm.imports[strings.TrimSpace(parts[1])] = depKey
			} else {
				pm.imports[name] = depKey
			}
		}
	}
	for d := range depSet {
		pm.deps = append(pm.deps, d)
	}
	sort.Strings(pm.deps) // deterministic emit order

	for _, m := range exportDeclRe.FindAllStringSubmatch(src, -1) {
		pm.exports = append(pm.exports, m[1])
	}

	body := importRe.ReplaceAllString(src, "")
	body = exportKwRe.ReplaceAllString(body, "")
	pm.body = body
	return pm, nil
}

// buildLinkedSource parses every module and emits one JS program: each module
// wrapped in an IIFE (import bindings first, body next, exports collected into
// __exports[key] last), emitted in topological order so a module's deps are
// already linked when it runs. Returns the program and the parsed modules.
func buildLinkedSource() (string, map[string]parsedModule, error) {
	parsed := map[string]parsedModule{}
	for _, spec := range modules {
		pm, err := parseModule(spec)
		if err != nil {
			return "", nil, err
		}
		parsed[spec.key] = pm
	}

	order, err := topoOrder(parsed)
	if err != nil {
		return "", nil, err
	}

	var b strings.Builder
	b.WriteString("var __exports = {};\n")
	for _, key := range order {
		pm := parsed[key]
		b.WriteString("(function(){\n")
		// Bind imported names from already-linked source modules. Sorted for
		// deterministic output.
		var names []string
		for n := range pm.imports {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			fmt.Fprintf(&b, "var %s = __exports[%q].%s;\n", n, pm.imports[n], n)
		}
		b.WriteString(pm.body)
		b.WriteString("\n__exports[")
		fmt.Fprintf(&b, "%q] = {", key)
		for i, e := range pm.exports {
			if i > 0 {
				b.WriteString(", ")
			}
			fmt.Fprintf(&b, "%s: %s", e, e)
		}
		b.WriteString("};\n})();\n")
	}
	return b.String(), parsed, nil
}

// topoOrder returns module keys such that every module appears after all its
// import dependencies. Errors on a missing dependency or an import cycle
// (web/domain has none today; this fails loudly if one is introduced).
func topoOrder(parsed map[string]parsedModule) ([]string, error) {
	const (
		white = 0 // unvisited
		gray  = 1 // on the current DFS stack
		black = 2 // done
	)
	state := map[string]int{}
	var order []string
	var visit func(k string) error
	visit = func(k string) error {
		switch state[k] {
		case black:
			return nil
		case gray:
			return fmt.Errorf("import cycle through module %q", k)
		}
		pm, ok := parsed[k]
		if !ok {
			return fmt.Errorf("module %q imported but not registered in modules[]", k)
		}
		state[k] = gray
		for _, d := range pm.deps {
			if err := visit(d); err != nil {
				return err
			}
		}
		state[k] = black
		order = append(order, k)
		return nil
	}
	// Visit in a stable order for deterministic output.
	keys := make([]string, 0, len(parsed))
	for k := range parsed {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if err := visit(k); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// injectIntlShim installs a minimal Intl.DateTimeFormat over the runtime.
//
// goja has NO Intl. The web/domain modules use it only for tz day-boundary math
// — `Intl.DateTimeFormat(locale, {timeZone,...}).formatToParts(date)` to read a
// timestamp's wall-clock Y/M/D/H/M/S in a given IANA zone. We back that single
// primitive with Go's time package — the SAME tz database the native store's
// day-truncation uses — so both sides resolve identical offsets and the modules
// run unmodified. Documented spike/host caveat: not a real Intl, just the one
// capability the domain modules need. web/domain/*.js are NOT touched.
func injectIntlShim(vm *goja.Runtime) error {
	if err := vm.Set("__wallParts", wallParts); err != nil {
		return fmt.Errorf("set __wallParts: %w", err)
	}
	const shim = `globalThis.Intl = {
  DateTimeFormat: function (_locale, opts) {
    var tz = opts.timeZone;
    return {
      formatToParts: function (date) {
        var p = __wallParts(date.getTime(), tz);
        return [
          { type: 'year', value: String(p.year) },
          { type: 'month', value: String(p.month) },
          { type: 'day', value: String(p.day) },
          { type: 'hour', value: String(p.hour) },
          { type: 'minute', value: String(p.minute) },
          { type: 'second', value: String(p.second) },
        ];
      },
    };
  },
};`
	if _, err := vm.RunString(shim); err != nil {
		return fmt.Errorf("install Intl shim: %w", err)
	}
	return nil
}
