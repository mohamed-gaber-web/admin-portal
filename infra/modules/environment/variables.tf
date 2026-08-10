variable "name" {
  description = "Environment name prefix, e.g. growpath-dev."
  type        = string
}

variable "location" {
  description = "Azure region. REQUIRED, no default: driven by Saudi data-residency (blocking decision) and cannot change without re-provisioning."
  type        = string
}

variable "administrator_login" {
  description = "Postgres administrator login."
  type        = string
  default     = "gpadmin"
}

variable "administrator_password" {
  description = "Postgres administrator password."
  type        = string
  sensitive   = true
}

variable "postgres_sku_name" {
  description = "SKU for the Postgres flexible server."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "redis_capacity" {
  description = "Redis cache capacity."
  type        = number
  default     = 0
}

variable "app_service_sku" {
  description = "SKU for the app service plan."
  type        = string
  default     = "B1"
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
