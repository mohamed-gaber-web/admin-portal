terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.100, < 5.0"
    }
  }
}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "this" {
  name     = "${var.name}-rg"
  location = var.location
  tags     = var.tags
}

# --- App hosting -----------------------------------------------------------
resource "azurerm_service_plan" "this" {
  name                = "${var.name}-plan"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  os_type             = "Linux"
  sku_name            = var.app_service_sku
  tags                = var.tags
}

resource "azurerm_linux_web_app" "this" {
  name                = "${var.name}-app"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  service_plan_id     = azurerm_service_plan.this.id
  tags                = var.tags

  site_config {
    application_stack {
      node_version = "20-lts"
    }
  }
}

# --- Postgres --------------------------------------------------------------
resource "azurerm_postgresql_flexible_server" "this" {
  name                   = "${var.name}-pg"
  resource_group_name    = azurerm_resource_group.this.name
  location               = azurerm_resource_group.this.location
  version                = "16"
  administrator_login    = var.administrator_login
  administrator_password = var.administrator_password
  sku_name               = var.postgres_sku_name
  storage_mb             = 32768
  zone                   = "1"
  tags                   = var.tags
}

# --- Redis -----------------------------------------------------------------
resource "azurerm_redis_cache" "this" {
  name                = "${var.name}-redis"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  capacity            = var.redis_capacity
  family              = "C"
  sku_name            = "Basic"
  tags                = var.tags
}

# --- Secret vault ----------------------------------------------------------
resource "azurerm_key_vault" "this" {
  name                = "${var.name}-kv"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
  tags                = var.tags
}
