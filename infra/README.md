# Infrastructure (Terraform)

Reproducible **dev** and **staging** Azure environments defined as code, so provisioning is not tribal knowledge.

## Layout

- `modules/environment/` — one reusable module that provisions the full stack:
  app hosting (`azurerm_service_plan` + `azurerm_linux_web_app`), Postgres
  (`azurerm_postgresql_flexible_server`), Redis (`azurerm_redis_cache`), and the
  secret vault (`azurerm_key_vault`).
- `environments/dev/`, `environments/staging/` — thin roots that invoke the same
  module with per-environment values and their own remote state key. One
  definition ⇒ identical environments; re-applying is idempotent.

## Blocking decision: Azure region

`location` is a **required variable with no default**. It is driven by the Saudi
client's data-residency requirement and **cannot change without re-provisioning**.
Set it in each `environments/<env>/terraform.tfvars` before applying (both
environments must use the same region).

## Apply

Prerequisites: Terraform >= 1.6, Azure CLI logged in (`az login`), and a storage
account for remote state (referenced in `backend.tf`).

```bash
cd infra/environments/dev        # or staging
terraform init
terraform plan  -var="administrator_password=..."   # or TF_VAR_administrator_password
terraform apply -var="administrator_password=..."
```

Secrets (e.g. `administrator_password`) must come from a secret store or
`TF_VAR_*` env vars — never commit them.

## Validation

CI runs `terraform fmt -check` and `terraform validate` for every environment on
each pull request (the `terraform` job in `.github/workflows/ci.yml`). Full
`apply` requires an Azure subscription and is performed out of band.
