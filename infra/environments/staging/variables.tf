variable "location" {
  description = "Azure region (Saudi data-residency decision). Set in terraform.tfvars before applying."
  type        = string
}

variable "administrator_password" {
  description = "Postgres administrator password. Provide via TF_VAR_administrator_password or a secret store; never commit it."
  type        = string
  sensitive   = true
}
