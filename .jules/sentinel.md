## 2025-04-07 - Ephemeral Session Secrets Cause Silent Invalidation
**Vulnerability:** Application silently generated ephemeral (in-memory) session secrets (`generateSessionSecret`) if `SESSION_SECRET` was missing or too short, instead of failing on startup.
**Learning:** Generating ephemeral secrets on startup causes all active user sessions to be silently invalidated on every process restart or update, masking configuration errors and severely degrading user experience while appearing to "solve" a missing secret issue.
**Prevention:** For critical persistent secrets like `SESSION_SECRET`, always fail-fast using `os.Exit(1)` on application startup if the configuration is missing or insecure, forcing administrators to explicitly provision persistent credentials.

## 2025-04-07 - Missing Negative Input Validation on Macros
**Vulnerability:** Endpoints handling food logs and products (`handleCreateFoodLog`, `handleUpdateFoodLog`, `handleUpdateFoodProduct`) did not validate that nutritional inputs (calories, carbs, protein, fat, weight) were non-negative, allowing potential manipulation of health statistics via negative values.
**Learning:** Always explicitly validate numeric boundaries on user-provided data, especially when values logically cannot be negative (like physical weight or macronutrients), even if the struct parsing succeeds.
**Prevention:** Implement strict boundary checks (e.g., `if val < 0`) on all incoming numeric inputs before processing or storing them in the database.
