## 2024-04-18 - [Command Injection in RunInstallCommand]
**Vulnerability:** The RunInstallCommand allowed arbitrary execution via an unsafe os/exec call using sh -c.
**Learning:** Hard-coded commands containing complex pipeline structures led to using shell execution unnecessarily, circumventing os/exec's protections. Shell execution without tight constraints or explicit sanitization is inherently risky.
**Prevention:** Eliminate the shell execution and statically define an explicit allowlist mapping specific command strings into safe, structured exec.Command calls using direct arguments, handling piping explicitly in Go while obeying Wait() ordering.
