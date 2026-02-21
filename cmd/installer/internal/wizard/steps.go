package wizard

// Step represents a named step in the installation wizard.
type Step string

const (
	StepWelcome     Step = "welcome"
	StepDomain      Step = "domain"
	StepTelegram    Step = "telegram"
	StepCore        Step = "core"
	StepFeatures    Step = "features"
	StepConditional Step = "conditional"
	StepSummary     Step = "summary"
	StepDNS         Step = "dns"
	StepDeploy      Step = "deploy"
	StepPasskey     Step = "passkey"
	StepVerify      Step = "verify"
	StepDone        Step = "done"
)

// AllSteps returns the ordered list of steps.
func AllSteps() []Step {
	return []Step{
		StepWelcome,
		StepDomain,
		StepTelegram,
		StepCore,
		StepFeatures,
		StepConditional,
		StepSummary,
		StepDNS,
		StepDeploy,
		StepPasskey,
		StepVerify,
		StepDone,
	}
}

// StepIndex returns the index of a step in the ordered list, or -1 if not found.
func StepIndex(s Step) int {
	for i, step := range AllSteps() {
		if step == s {
			return i
		}
	}
	return -1
}
